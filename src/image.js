/**
 * 图片压缩：把超过微信正文配图 1MB 上限的图压到预算内。
 *
 * 插件本体保持零运行时依赖，压缩这件事交给机器上已有的 Python + Pillow
 * （DSH 自带的 runtime 里就有），本模块只负责：找解释器 → 调 python/compress.py → 把结果转成
 * 无损 JSON 返回。找不到可用的解释器就明确报错并给出处置建议，绝不静默产出丢图的稿。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 压缩脚本随包发布（package.json files 里有 python/*.py）。 */
export const COMPRESS_SCRIPT = fileURLToPath(new URL('../python/compress.py', import.meta.url))

/** 候选解释器：显式配置 → 环境变量 → DSH runtime 自带的 Python → 裸 python 指望 PATH。 */
export function candidatePythons(config = {}) {
  const out = []
  const push = value => {
    const item = String(value ?? '').trim()
    if (item !== '' && out.indexOf(item) < 0) out.push(item)
  }
  push(config.pythonPath)
  push(process.env.GZH_PYTHON)
  const root = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const base = join(root, entry.name, 'dependencies', 'python')
      for (const name of process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']) push(join(base, name))
    }
  } catch {
    // 没有 DSH runtime 目录就算了，后面还有 PATH 这条兜底
  }
  push('python')
  return out
}

// 探测结果缓存：一次进程生命周期里只试一遍候选，别每张图都重探一次。
let probe = { key: '', python: '', version: '', error: '' }

/**
 * 找一个「装了 Pillow 的 Python」。命中后缓存。
 * @returns {string} 可用的解释器路径；一个都没有时返回 ''（原因在 probe.error 里）
 */
export function findPython(config = {}, { force = false } = {}) {
  const candidates = candidatePythons(config)
  const key = candidates.join('|')
  if (!force && probe.key === key && probe.python !== '') return probe.python
  if (!force && probe.key === key && probe.error !== '') return ''

  const tried = []
  for (const candidate of candidates) {
    const version = probePillow(candidate)
    if (version !== '') {
      probe = { key, python: candidate, version, error: '' }
      return candidate
    }
    tried.push(candidate)
  }
  probe = { key, python: '', version: '', error: `没找到带 Pillow 的 Python（试过：${tried.join('、')}）` }
  return ''
}

/**
 * 探测：让 Python 把 Pillow 版本**写进临时文件**，不用管道读。
 * 宿主进程里管道本来也没问题，但整条链路不依赖管道，插件在受限环境（沙箱、无 stdio 的服务里）
 * 一样能跑，而且能在那种环境里跑自测。
 */
function probePillow(executable) {
  const meta = join(tmpdir(), `gzh-pillow-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  const code = 'import PIL,sys\nopen(sys.argv[1],"w",encoding="utf-8").write(PIL.__version__)'
  try {
    const result = spawnSync(executable, ['-c', code, meta], { windowsHide: true, timeout: 8_000, stdio: 'ignore' })
    if (result.status !== 0 || !existsSync(meta)) return ''
    const version = readFileSync(meta, 'utf8').trim()
    return /^\d+(\.\d+)*$/.test(version) ? version : ''
  } catch {
    return ''
  } finally {
    try {
      if (existsSync(meta)) rmSync(meta)
    } catch {}
  }
}

/**
 * 压缩器现状，给工具返回值用（必须是无损 JSON）。
 * 这里**不做探测**：探测是同步 spawn，最坏会把宿主事件循环卡住十几秒。
 * 只在真的要压图时探一次（compressImage 里），探完之后这个函数就能报实况。
 */
export function compressorStatus(config = {}) {
  return {
    probed: probe.key !== '',
    ready: probe.python !== '',
    python: probe.python,
    version: probe.version,
    configured: String(config.pythonPath ?? ''),
    script: COMPRESS_SCRIPT,
    scriptFound: existsSync(COMPRESS_SCRIPT),
    error: probe.error,
  }
}

/**
 * 把一张图压进预算。
 * @param {string} sourcePath 源文件绝对路径
 * @param {{ outDir: string, maxBytes: number, maxEdge?: number, timeoutMs?: number, config?: object }} options
 * @returns {Promise<{ok: boolean, path: string, bytes: number, width: number, height: number, quality: number, scale: number, srcFormat: string, note: string, error: string, cached: boolean}>}
 */
export async function compressImage(sourcePath, options = {}) {
  const src = String(sourcePath ?? '').trim()
  const base = { ok: false, path: '', bytes: 0, width: 0, height: 0, quality: 0, scale: 1, srcFormat: '', note: '', error: '', cached: false }
  if (src === '' || !existsSync(src)) return { ...base, error: `要压缩的文件不存在：${src || '（空路径）'}` }

  const maxBytes = Math.max(8192, Number(options.maxBytes) || 1048576)
  const maxEdge = Math.max(64, Number(options.maxEdge) || 1440)
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 120_000, 5_000), 600_000)
  const outDir = String(options.outDir ?? '').trim() || join(process.cwd(), 'gzh-compressed')
  try {
    mkdirSync(outDir, { recursive: true })
  } catch (cause) {
    return { ...base, error: `压缩输出目录建不出来：${cause.message}` }
  }

  const python = findPython(options.config ?? {})
  if (python === '') {
    return { ...base, error: `${probe.error}。处置：在插件设置里填 pythonPath（指向装了 Pillow 的解释器），或在生图那头直接把尺寸/格式调小。` }
  }

  // 缓存键带上源文件 mtime 与预算：同一篇稿反复渲染不重复压，改了图或改了预算会自然失效。
  const stamp = `${src}|${statSync(src).mtimeMs}|${maxBytes}|${maxEdge}`
  const out = join(outDir, `${createHash('sha1').update(stamp).digest('hex').slice(0, 16)}.jpg`)
  if (existsSync(out) && statSync(out).size <= maxBytes) {
    return { ...base, ok: true, cached: true, path: out, bytes: statSync(out).size, note: '命中压缩缓存' }
  }

  const args = [COMPRESS_SCRIPT, '--in', src, '--out', out, '--max-bytes', String(maxBytes), '--max-edge', String(maxEdge)]
  const run = await runCompress(python, args, timeoutMs)
  if (run.error !== '') return { ...base, error: run.error }

  const data = run.data
  const bytes = Number.isFinite(Number(data.bytes)) ? Number(data.bytes) : 0
  if (data.ok !== true) {
    return { ...base, error: String(data.error ?? '压缩脚本没说明原因'), bytes }
  }
  if (!existsSync(out)) return { ...base, error: '压缩脚本说成功了，但输出文件不在', bytes }

  const written = statSync(out).size
  if (written > maxBytes) {
    return { ...base, error: `压完 ${(written / 1048576).toFixed(2)}MB 仍超预算 ${(maxBytes / 1048576).toFixed(2)}MB`, bytes: written }
  }
  return {
    ok: true,
    path: out,
    bytes: written,
    width: Number.isFinite(Number(data.width)) ? Number(data.width) : 0,
    height: Number.isFinite(Number(data.height)) ? Number(data.height) : 0,
    quality: Number.isFinite(Number(data.quality)) ? Number(data.quality) : 0,
    scale: Number.isFinite(Number(data.scale)) ? Number(data.scale) : 1,
    srcFormat: String(data.srcFormat ?? ''),
    note: String(data.note ?? ''),
    error: '',
    cached: false,
  }
}

/**
 * 跑压缩脚本：结果走 --meta 文件（不依赖管道），退出码兜底，超时杀进程。
 * @returns {Promise<{error: string, data: object}>}
 */
function runCompress(executable, args, timeoutMs) {
  return new Promise(resolve => {
    const meta = join(tmpdir(), `gzh-compress-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    let child
    try {
      child = spawn(executable, [...args, '--meta', meta], { windowsHide: true, stdio: 'ignore' })
    } catch (cause) {
      resolve({ error: `起不动压缩进程：${cause.message}`, data: {} })
      return
    }
    let settled = false
    let timer = null
    const finish = payload => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      try {
        if (existsSync(meta)) rmSync(meta)
      } catch {}
      resolve(payload)
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish({ error: `压缩超过 ${(timeoutMs / 1000).toFixed(0)}s 没回来，已杀进程`, data: {} })
    }, timeoutMs)

    child.on('error', cause => finish({ error: `起不动压缩进程：${cause.message}`, data: {} }))
    child.on('close', status => {
      if (!existsSync(meta)) {
        finish({
          error: `压缩脚本没有产出结果文件（退出码 ${String(status)}）：解释器或 Pillow 可能不可用，或脚本路径不对`,
          data: {},
        })
        return
      }
      let data
      try {
        data = JSON.parse(readFileSync(meta, 'utf8'))
      } catch (cause) {
        finish({ error: `压缩结果文件读不出 JSON：${cause.message}`, data: {} })
        return
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        finish({ error: '压缩结果文件不是对象', data: {} })
        return
      }
      finish({ error: '', data })
    })
  })
}
