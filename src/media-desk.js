/**
 * 读「自媒体工作台」（dsh-media-desk）的产出。
 *
 * media-desk 没有 Host Service，对外只有 HTTP `/media-desk/*`、它的工具和磁盘上的
 * `~/.dsh/media-desk/state.json` + `files/`。这里读的是后者——不依赖它起没起 HTTP，
 * 也不碰它的文件，只读。
 *
 * 素材 src 的写法是它自己的相对寻址（`src/export.js` 里的
 * `/^media-desk\/files\/([\w.-]+)$/`），映射到 `$DSH_HOME/media-desk/files/<name>`。
 *
 * @module dsh-gzh-publisher/media-desk
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, resolve } from 'node:path'

/** DSH 数据根目录。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

const ASSET_RE = /^media-desk\/files\/([\w.-]+)$/

/**
 * @param {{ dir?: string }} [options] media-desk 数据目录，默认 `~/.dsh/media-desk`。
 */
export function createMediaDesk(options = {}) {
  const dir = options.dir ?? join(dshHome(), 'media-desk')
  const stateFile = join(dir, 'state.json')
  const filesDir = join(dir, 'files')

  /** 读原始 state；缺文件返回 null（可能还没用过工作台）。 */
  function readState() {
    if (!existsSync(stateFile)) return null
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch (cause) {
      throw new Error(`自媒体工作台的 state.json 读不了（${stateFile}）：${cause.message}`)
    }
  }

  /**
   * 把素材 src 解析成本地绝对路径；已是 http(s) 的原样返回。
   *
   * 相对路径（工作台导出的稿子里就是 `![](配图1.png)`）以 `baseDir` 为基准，也就是那份 .md
   * 自己所在的目录 —— Markdown 的相对路径本来就是这个意思。以前不认相对路径，一整篇的配图
   * 会全部丢掉，只在 images 里留一句「本地素材不存在：配图1.png」，谁也看不出为什么。
   *
   * @param {string} src 正文里 `![](...)` 的内容。
   * @param {string} [baseDir] 正文所在目录，用来解析相对路径。
   * @returns {{ src: string, kind: string, localPath: string, tried?: string }}
   *   `tried` 是按 baseDir 拼出来的绝对路径；报错时要拿它说清「去哪儿找过」。
   */
  function resolveAsset(src, baseDir = '') {
    const text = String(src ?? '').trim()
    if (/^https?:\/\//i.test(text)) return { src: text, kind: 'remote', localPath: '' }
    const match = ASSET_RE.exec(text)
    if (match !== null) return { src: text, kind: 'local', localPath: join(filesDir, match[1]) }
    if (/^[{/\\\\]/.test(text) || /^[A-Za-z]:[\\/]/.test(text)) return { src: text, kind: 'local', localPath: text }
    const base = String(baseDir ?? '').trim()
    if (base !== '') {
      // 相对路径：基准是正文所在目录。`%20` 之类先还原，导出文件名带空格时也能对上。
      let name = text
      try { name = decodeURIComponent(text) } catch { /* 文件名里有裸 % 就按原样找 */ }
      const tried = resolve(base, name)
      return { src: text, kind: 'local', localPath: tried, tried }
    }
    return { src: text, kind: 'unknown', localPath: '' }
  }

  /** 一条 item 有没有可直接推送的正文。 */
  const publishable = item => String(item?.production?.article ?? '').trim().length > 80

  /**
   * 找这个条目**导出到磁盘上的 .md**（工作台「导出」写到 savedPath 里的那份）。
   *
   * 为什么必须有它：`state.json` 里的 `production.article` 有时是口播稿形态
   * （一行一句、没有 `##` 分节），或者比人后来在工作台目录里改定的那份短。
   * 两者谁该推**由人决定**，所以我们只做「找出来 + 报长度差」，不偷偷替换。
   *
   * @param {string} savedPath 条目里的 production.savedPath（目录或 .md 文件）。
   * @param {string} [title] 标题，用于优先挑文件名里带标题的那份。
   * @returns {{ path: string, bytes: number, markdown: string } | null}
   */
  function findSavedMarkdown(savedPath, title = '') {
    const root = String(savedPath ?? '').trim()
    if (root === '' || !existsSync(root)) return null
    let candidates = []
    try {
      if (statSync(root).isDirectory()) {
        candidates = readdirSync(root).filter(name => /\.md$/i.test(name)).map(name => join(root, name))
      } else if (/\.md$/i.test(root)) {
        candidates = [root]
      }
    } catch {
      return null
    }
    const wanted = String(title ?? '').replace(/[\s《》「」【】（）()，。、,.：:；;！!？?"'“”‘’\-—_/\\]+/g, '')
    const scored = candidates
      .filter(path => existsSync(path))
      .map(path => {
        let markdown = ''
        try {
          markdown = readFileSync(path, 'utf8')
        } catch {
          return null
        }
        const flat = basename(path).replace(/\.md$/i, '').replace(/[\s《》「」【】（）()，。、,.：:；;！!？?"'“”‘’\-—_/\\]+/g, '')
        return {
          path,
          bytes: Buffer.byteLength(markdown, 'utf8'),
          markdown,
          // 文件名像标题的优先，其次按长度（长的更可能是定稿全文）
          rank: (wanted !== '' && wanted.includes(flat) ? 2 : flat.includes(wanted) ? 1 : 0),
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.rank - a.rank || b.bytes - a.bytes)
    if (scored.length === 0) return null
    const best = scored[0]
    return { path: best.path, bytes: best.bytes, markdown: best.markdown }
  }

  /**
   * 列表：只看有正文的产出，附带配图数量与是否已导出。
   * @returns {{ dir: string, stateFile: string, missing: boolean, items: Array }}
   */
  function list() {
    const state = readState()
    if (state === null) {
      return { dir, stateFile, missing: true, items: [] }
    }
    const items = (Array.isArray(state.items) ? state.items : [])
      .filter(publishable)
      .map(item => {
        const production = item.production
        return {
          id: item.id,
          title: String(production.title ?? item.title ?? '').trim(),
          stage: production.stage ?? '',
          status: production.status ?? '',
          format: production.format ?? '',
          withImages: production.withImages === true,
          images: Array.isArray(production.images) ? production.images.length : 0,
          shots: Array.isArray(production.shots) ? production.shots.length : 0,
          hasCover: String(production.cover?.src ?? '') !== '',
          savedPath: production.savedPath ?? '',
          hasSavedMarkdown: hasSavedMarkdown(production.savedPath),
          updatedAt: item.updatedAt ?? 0,
        }
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    return { dir, stateFile, missing: false, items }
  }

  /**
   * 取一条产出的正文与素材清单（不做上传，只解析路径）。
   * @param {string} id item id（可只给前缀）。
   * @param {{requireBody?: boolean}} [options] `requireBody=false` 放过「还没有可用正文」的条目。
   *   贴图链路要的只是**配图**：一条图配几句话的贴图稿，production.article 可能就是空的，
   *   按图文的标准拦下来就等于不让发贴图。图文那边继续要求正文（空正文推出去是篇白稿）。
   * @returns {{ id, title, markdown, cover, images, savedPath }}
   */
  function read(id, { requireBody = true } = {}) {
    const state = readState()
    if (state === null) throw new Error(`没找到自媒体工作台的数据（${stateFile}）`)
    const want = String(id ?? '').trim()
    if (want === '') throw new Error('action=read 必须带 id（先用 action=list 看有哪些条目）')
    const items = Array.isArray(state.items) ? state.items : []
    // 完整 id 优先；否则才按前缀找（seed_1 是 seed_10 的前缀，不能一视同仁）
    const exact = items.filter(item => String(item.id) === want)
    const hits = exact.length === 1 ? exact : items.filter(item => String(item.id).startsWith(want))
    if (hits.length === 0) {
      const known = items.slice(0, 12).map(item => item.id).join('、')
      throw new Error(`自媒体工作台里没有 id「${id}」的条目；现有：${known}`)
    }
    if (hits.length > 1) {
      throw new Error(`id 前缀「${id}」命中 ${hits.length} 条，请给完整 id：${hits.map(item => item.id).join('、')}`)
    }
    const item = hits[0]
    const production = item.production ?? {}
    if (requireBody && !publishable(item)) throw new Error(`条目「${item.id}」还没有可用正文（production.article 为空），先在工作台生成/定稿`)
    const map = entry => {
      const asset = resolveAsset(entry?.src)
      const local = asset.localPath
      const exists = local !== '' && existsSync(local)
      return {
        src: asset.src,
        kind: asset.kind,
        caption: String(entry?.caption ?? '').trim(),
        anchor: String(entry?.anchor ?? '').trim(),
        status: String(entry?.status ?? '').trim(),
        localPath: exists ? local : '',
        fileName: exists ? basename(local) : '',
        bytes: exists ? statSync(local).size : 0,
        note: asset.kind === 'remote' ? '' : exists ? '' : local === '' ? '无法识别的素材路径' : `文件不存在：${local}`,
      }
    }
    const title = String(production.title ?? item.title ?? '').trim()
    const saved = findSavedMarkdown(production.savedPath, title)
    return {
      id: item.id,
      title,
      markdown: String(production.article ?? ''),
      markdownBytes: Buffer.byteLength(String(production.article ?? ''), 'utf8'),
      // 工作台目录里那份 .md（可能不存在，也可能比 state 里那份更完整）
      savedMarkdownPath: saved?.path ?? '',
      savedMarkdownBytes: saved?.bytes ?? 0,
      savedMarkdown: saved?.markdown ?? '',
      cover: production.cover !== undefined ? map(production.cover) : null,
      images: (Array.isArray(production.images) ? production.images : []).map(map),
      savedPath: production.savedPath ?? '',
    }
  }

  /** 轻版判断：目录里有没有 .md（列表用，不读文件内容）。 */
  function hasSavedMarkdown(savedPath) {
    const root = String(savedPath ?? '').trim()
    try {
      if (root === '' || !existsSync(root)) return false
      if (!statSync(root).isDirectory()) return /\.md$/i.test(root)
      return readdirSync(root).some(name => /\.md$/i.test(name))
    } catch {
      return false
    }
  }

  return { dir, stateFile, filesDir, list, read, resolveAsset, findSavedMarkdown }
}
