/**
 * 面板 ↔ 宿主的通道：一条 webServer 前缀路由。
 *
 * 为什么走 HTTP：Client 半是浏览器模块，没有 fs，也拿不到 Host 注册的工具；
 * 唯一能自己立规矩的通道就是宿主提供的 webServer 前缀路由。
 *
 * 安全边界（宿主不替路由属主管，所以这里自己钉死）：
 *   - 除 /bootstrap 外都要 `x-gzh-token`；令牌每次激活换发，只发给同源请求。
 *   - 带 Origin 的请求必须同源；`Sec-Fetch-Site: cross-site` 一律拒。
 *   - 能改外部世界的动作（推草稿）只有 POST + 令牌 + 同源三把锁同时满足才放行。
 *   - 预览只允许读插件自己输出目录里的 .html，挡掉路径穿越。
 *   - 所有动作最终落到 registerTools 的同一份实现上：去重台账、fail-close、掩码全部共用。
 *
 * @module dsh-gzh-publisher/routes
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { listSkins, migrateSkinKey, resolveSkin } from './layout.js'
import { compressorStatus } from './image.js'
import { resolveStickerRules, DEFAULT_RULE_PROSE, WECHAT_STICKER, STICKER_RULE_FIELDS } from './sticker.js'

export const ROUTE_PREFIX = '/gzh-api'

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req, limit = 2_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体超过 2MB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

/**
 * 同源判定。浏览器对同源 GET 不发 Origin，所以顺序是：
 * Origin（有就必须等于自己）→ Referer（有就必须是自己的前缀）→ 都没有就当本机直连。
 */
function sameOrigin(req, expected) {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return false
  const origin = String(req.headers.origin ?? '')
  if (origin !== '') return origin === expected
  const referer = String(req.headers.referer ?? '')
  if (referer === '') return true
  return referer === expected || referer.startsWith(`${expected}/`)
}

/** 只放行插件输出目录里的 HTML，别把这台机器的文件系统开放给页面。 */
function safePreview(file, outDir) {
  const target = resolve(String(file ?? ''))
  const root = resolve(String(outDir ?? ''))
  if (target === '' || root === '') return { path: '', error: '没给文件路径' }
  if (target !== root && !target.startsWith(root + sep)) return { path: '', error: '预览路径不在插件输出目录内，已拒绝' }
  if (extname(target).toLowerCase() !== '.html') return { path: '', error: '只预览 .html' }
  if (!existsSync(target)) return { path: '', error: `文件不存在：${target}` }
  const bytes = statSync(target).size
  if (bytes > 4_000_000) return { path: '', error: `预览文件 ${(bytes / 1048576).toFixed(1)}MB 太大` }
  return { path: target, error: '' }
}

/**
 * 组装 handler。
 * @param {{ api: { call: Function, names: Function }, store: object, desk?: object,
 *           config?: Function, log?: Function, getOrigin?: Function }} deps
 * @returns {{ prefix: string, handler: Function, token: string }}
 */
export function createApiRoutes({ api, store, desk, config, log, getOrigin }) {
  const token = randomUUID()
  const settings = typeof config === 'function' ? config : () => ({})

  /**
   * 面板一眼要看的全部数据：账号、皮肤、文章、台账、渲染记录、全局参数。
   * 直接读 store/desk，不走工具层 —— 一来省掉「一次渲染要发七个请求」，
   * 二来插件被停用时页面仍能说明原因（工具层在停用时是一律拒绝的）。
   * 密钥不在这份快照里：publicAccount 只回尾 4 位与 has* 标记。
   */
  function snapshot() {
    const cfg = settings()
    const custom = store.readSkins()
    const skinRows = listSkins(custom)
    const knownSkins = new Set(skinRows.map(row => row.key))
    let listed = { dir: '', stateFile: '', missing: true, items: [], error: '' }
    try {
      if (desk !== undefined && desk !== null) listed = { error: '', ...listed, ...desk.list() }
    } catch (cause) {
      listed = { dir: desk?.dir ?? '', stateFile: desk?.stateFile ?? '', missing: true, items: [], error: cause.message }
    }
    return {
      enabled: cfg.enabled !== false,
      config: {
        defaultAccount: String(cfg.defaultAccount ?? ''),
        defaultLayout: migrateSkinKey(String(cfg.defaultLayout ?? 'teal')),
        mediaDeskDir: String(cfg.mediaDeskDir ?? ''),
        dataDir: String(cfg.dataDir ?? ''),
        autoDigest: cfg.autoDigest !== false,
        allowDirectApi: cfg.allowDirectApi === true,
        maxImageMb: cfg.maxImageMb ?? 1,
        imageMaxEdge: cfg.imageMaxEdge ?? 1440,
        timeoutMs: cfg.timeoutMs ?? 60000,
      },
      configNote: '全局参数在宿主「设置 → 插件 → 公众号草稿推送 → 配置」里改，存完自动生效；这里只读。',
      files: {
        accountsFile: store.accountsFile, skinsFile: store.skinsFile,
        rendersFile: store.rendersFile, ledgerFile: store.ledgerFile, outDir: store.outDir,
      },
      engine: compressorStatus(cfg),
      accounts: Object.entries(store.readAccounts()).map(([key, account]) => {
        const wanted = String(account.layout ?? '')
        // 账号可能还存着旧皮肤名（迁移前写的）：这里照渲染时的口径解析一遍，
        // 面板才知道该勾哪一项、要不要提示「这个皮肤名已经不存在了」。
        const { name, skin } = resolveSkin({ layout: wanted, skin: account.skin },
          { fallback: migrateSkinKey(String(cfg.defaultLayout ?? 'teal')), custom })
        return {
          ...store.publicAccount(key, account),
          layout: wanted,
          layoutKey: name,
          layoutLabel: skin.label,
          layoutKnown: wanted === '' || knownSkins.has(migrateSkinKey(wanted)),
          // 贴图规则按**生效值**给：面板不能自己再拼一遍优先级，否则页面和工具层会各说一套。
          sticker: (() => {
            const rules = resolveStickerRules({ account: { key, ...account }, config: cfg })
            return { summary: rules.summary, values: rules.rules, sources: rules.sources, configured: account.sticker ?? null, violations: rules.violations }
          })(),
        }
      }),
      // 全局参数页只读展示：四个贴图档的当前生效值 + 该填的范围（微信硬上限在那儿，别让人填出个填不进去的数）
      stickerDefaults: (() => {
        const rules = resolveStickerRules({ config: cfg })
        return {
          summary: rules.summary, values: rules.rules, sources: rules.sources,
          prose: DEFAULT_RULE_PROSE,
          hard: { title: WECHAT_STICKER.titleMax, images: `${WECHAT_STICKER.imageMin}~${WECHAT_STICKER.imageMax}`, digest: WECHAT_STICKER.digestMax },
          // 同时给规则 key（面板绑表单、查来源用它）与全局配置的扁平字段名（只读页展示它）
          fields: STICKER_RULE_FIELDS.filter(row => row.globalKey !== undefined)
            .map(row => ({
              key: row.key, globalKey: row.globalKey, label: row.label,
              min: row.min, max: row.max, hint: row.hint, value: rules.rules[row.key],
            })),
        }
      })(),
      // 带上整组 colors：设置弹窗要能改配色，就得读到当前值（这里没有密钥，随便读）
      skins: skinRows.map(row => ({
        key: row.key, label: row.label, builtIn: row.builtIn, colors: row.colors, accent: row.colors.accent,
      })),
      articles: listed.items,
      mediaDesk: { dir: listed.dir, stateFile: listed.stateFile, missing: listed.missing, error: listed.error },
      pushes: store.readLedger().slice(0, 20),
      renders: store.readRenders().slice(0, 20),
    }
  }

  const core = async (req, res, expected) => {
    const url = new URL(req.url ?? '/', 'http://gzh.local')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    if (method === 'GET' && route === '/bootstrap') {
      if (!sameOrigin(req, expected)) return sendJson(res, 403, { ok: false, code: 'cross_origin', error: '面板令牌只发给同源请求' })
      return sendJson(res, 200, { ok: true, token, actions: api.names(), ...snapshot() })
    }

    if (String(req.headers['x-gzh-token'] ?? '') !== token) {
      return sendJson(res, 401, { ok: false, code: 'unauthorized', error: '缺少面板令牌：页面没拿到 bootstrap，或宿主刚刚重启过（刷新页面即可）' })
    }
    if (method === 'POST' && !sameOrigin(req, expected)) {
      return sendJson(res, 403, { ok: false, code: 'cross_origin', error: '写操作只接受同源请求' })
    }

    // 一次拿全：面板打开/刷新只需要 /meta 一个请求
    if (method === 'GET' && route === '/meta') return sendJson(res, 200, { ok: true, ...snapshot() })

    if (method === 'GET' && route === '/accounts') return sendJson(res, 200, { ok: true, accounts: await api.call('gzh_account_list', {}) })
    if (method === 'GET' && route === '/articles') return sendJson(res, 200, { ok: true, articles: await api.call('gzh_media_desk', { action: 'list' }) })

    if (method === 'GET' && route === '/preview') {
      const check = safePreview(url.searchParams.get('file'), store.outDir)
      if (check.error !== '') return sendJson(res, 400, { ok: false, code: 'bad_path', error: check.error })
      return sendJson(res, 200, { ok: true, file: check.path, html: readFileSync(check.path, 'utf8') })
    }

    if (method === 'POST' && route === '/call') {
      const body = await readJsonBody(req)
      const result = await api.call(body.tool, body.args ?? {})
      return sendJson(res, 200, { ok: true, tool: String(body.tool ?? ''), result })
    }

    return sendJson(res, 404, { ok: false, code: 'not_found', error: `未知路由 ${method} ${route}`, actions: api.names() })
  }

  const handler = async (req, res) => {
    try {
      // 每次都现取：webServer 换端口/重启后 Origin 会变，别在注册时定死
      await core(req, res, String(getOrigin?.() ?? ''))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      sendJson(res, 400, { ok: false, code: 'failed', error: message, hint: String(cause?.hint ?? '') })
      log?.(`gzh: 路由出错 ${req.method} ${req.url} → ${message}`)
    }
  }

  return { prefix: ROUTE_PREFIX, handler, token }
}

/**
 * 注册到宿主 webServer，返回 disposer。
 * @param {object} webCtx 注入了 webServer 的子上下文
 * @param {{ api: object, store: object, log?: Function }} deps
 */
export function registerApiRoutes(webCtx, deps) {
  const routes = createApiRoutes({ ...deps, getOrigin: () => webCtx.webServer?.getOrigin?.() ?? '' })
  const dispose = webCtx.webServer.register({ kind: 'prefix', path: routes.prefix, handler: routes.handler })
  deps.log?.(`gzh: 面板路由挂在 ${routes.prefix}（令牌每次激活换发）`)
  return typeof dispose === 'function' ? dispose : () => {}
}
