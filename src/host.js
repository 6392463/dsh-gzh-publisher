/**
 * dsh-gzh-publisher — 公众号排版 + 草稿箱推送（Host 半边）。
 *
 * 把「自媒体工作台」（或任何来源的 Markdown）产出的文章，按内置/自定义排版皮肤
 * 渲染成公众号 HTML，配图传微信图床，然后走代理推到**草稿箱**。
 * 骨架只有一套，号与号之间只差皮肤：设置里加一条账号（选一套皮肤）就能多一个号，
 * 嫌四套内置配色不合适就在设置里新建皮肤 —— 不绑定任何具体的人或号。
 *
 * 配置项都是 volatile：设置界面存完就生效，不用重启（读值走 readValue，
 * 兼容 volatile cell 与普通值 —— 和 dsh-compaction-policy 同一套做法）。
 *
 * 账号密钥不放这里：它们存在插件自己的 `~/.dsh/gzh-publisher/accounts.json`，
 * 由 gzh_account_set 写、任何工具输出都只回显尾 4 位。
 *
 * @module dsh-gzh-publisher
 */
import Schema from '@deepseek-ai/schemastery'
import { migrateSkinKey } from './layout.js'
import { createStore } from './store.js'
import { createMediaDesk } from './media-desk.js'
import { registerTools } from './tools.js'
import { registerApiRoutes } from './routes.js'

/** 设置命名空间 == bundle row id，设置界面靠这个对上。 */
export const name = 'gzh-publisher'

/** apply 之前需要就绪的服务。 */
export const inject = ['tools']

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('是否启用本插件。关闭后 gzh_* 工具全部拒绝执行（不会推任何东西）。')
    .volatile(),
  defaultAccount: Schema.string()
    .default('')
    .description('默认公众号账号 key（gzh_account_list 可查）。调用工具时不带 account 就用它；留空表示必须显式指定，防串号。')
    .volatile(),
  defaultLayout: Schema.string()
    .default('teal')
    .description('账号没配 layout 时用的排版皮肤 key。内置：teal｜sage｜redwhite｜graphite；自己新建的皮肤填它的 key（面板「设置 → 皮肤」或 gzh_skin_list 可查）。')
    .volatile(),
  mediaDeskDir: Schema.string()
    .default('')
    .description('自媒体工作台数据目录，留空 = ~/.dsh/media-desk。只在换机器或改过 DSH_HOME 时才需要填。')
    .volatile(),
  dataDir: Schema.string()
    .default('')
    .description('插件自己的数据目录（账号表、推送台账、渲染产物），留空 = ~/.dsh/gzh-publisher。')
    .volatile(),
  autoDigest: Schema.boolean()
    .default(true)
    .description('账号和调用都没给摘要时，自动摘正文第一段当摘要（≤110 字）。关掉则缺摘要直接报错，和产线脚本的 fail-close 一致。')
    .volatile(),
  allowDirectApi: Schema.boolean()
    .default(false)
    .description('允许 proxyUrl 留空时直连 api.weixin.qq.com。开着但本机出口 IP 没进公众号后台白名单会得到 40164。')
    .volatile(),
  maxImageMb: Schema.number()
    .step(0.1)
    .min(0.1)
    .max(10)
    .default(1)
    .description('正文配图上传上限（MB）。微信 uploadimg 硬限制 1MB，调大只会让失败推迟到微信那一端，一般别动。')
    .volatile(),
  imageMaxEdge: Schema.number()
    .step(10)
    .min(320)
    .max(4096)
    .default(1440)
    .description('压缩时的长边上限（像素）。公众号正文实际显示宽约 677px，1440 是给高分屏留的余量；调小更省流量也更糊。')
    .volatile(),
  pythonPath: Schema.string()
    .default('')
    .description('压缩配图用的 Python 解释器（需要 Pillow）。留空 = 自动找 DSH 自带 runtime 里的 python，再退到 PATH。')
    .volatile(),
  compressTimeoutMs: Schema.number()
    .step(1000)
    .min(10000)
    .max(600000)
    .default(120000)
    .description('单张图压缩的超时（毫秒），超时会杀掉压缩进程并在图片报告里写明原因。')
    .volatile(),
  timeoutMs: Schema.number()
    .step(1000)
    .min(5000)
    .max(180000)
    .default(60000)
    .description('单次微信接口请求超时（毫秒）。代理链路慢可以适当放大。')
    .volatile(),
})

/**
 * 读一个可能是 volatile cell 的配置值。
 * `Schema.volatile()` 字段在某些边界是 `{ get }` 惰性单元，在另一些边界是普通值；
 * 这样读两种都对。
 * @param value 普通值 / volatile cell / undefined。
 * @returns 底层值。
 */
function readValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** 配置默认值，与 schema 对齐（缺字段时兜底）。 */
const DEFAULTS = {
  enabled: true, defaultAccount: '', defaultLayout: 'teal', mediaDeskDir: '',
  dataDir: '', autoDigest: true, allowDirectApi: false, maxImageMb: 1, timeoutMs: 60000,
  imageMaxEdge: 1440, pythonPath: '', compressTimeoutMs: 120000,
}

/**
 * 把运行时给的任何配置形状归一化成普通对象，工具层就不必关心 cell/值差异。
 * @param input 原始 config 或设置面板给的 section。
 * @returns 普通配置对象。
 */
export function normalize(input) {
  if (input === null || typeof input !== 'object') return { ...DEFAULTS }
  const out = {}
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = readValue(input[key])
    out[key] = value === undefined || value === null || value === '' ? fallback : value
  }
  const maxImageMb = Number(out.maxImageMb)
  out.maxImageMb = Number.isFinite(maxImageMb) && maxImageMb > 0 ? maxImageMb : DEFAULTS.maxImageMb
  const timeoutMs = Number(out.timeoutMs)
  out.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 5000 ? timeoutMs : DEFAULTS.timeoutMs
  const imageMaxEdge = Number(out.imageMaxEdge)
  out.imageMaxEdge = Number.isFinite(imageMaxEdge) && imageMaxEdge >= 320 ? Math.min(imageMaxEdge, 4096) : DEFAULTS.imageMaxEdge
  const compressTimeoutMs = Number(out.compressTimeoutMs)
  out.compressTimeoutMs = Number.isFinite(compressTimeoutMs) && compressTimeoutMs >= 10000
    ? Math.min(compressTimeoutMs, 600000)
    : DEFAULTS.compressTimeoutMs
  out.enabled = out.enabled === true || out.enabled === 'true'
  out.autoDigest = out.autoDigest === true || out.autoDigest === 'true'
  out.allowDirectApi = out.allowDirectApi === true || out.allowDirectApi === 'true'
  // 老配置里的皮肤名（曾按号命名）在这里就换算成中性 key，工具层只认新 key。
  out.defaultLayout = migrateSkinKey(String(out.defaultLayout))
  return out
}

/**
 * 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 本行（row）的配置，可能是 volatile cell 的组合。
 */
export function apply(ctx, config) {
  const settings = () => normalize(config)
  const store = createStore({ dir: settings().dataDir || undefined })
  // 皮肤曾经按号名命名，现在换成中性 key：老名字在 LEGACY_SKIN_KEYS 里指过来就能继续用。
  // 幂等，每次激活跑一遍，迁移过就没有可改的。
  const migrated = store.migrateAccounts()
  const desk = createMediaDesk({ dir: settings().mediaDeskDir || undefined })
  const log = (...args) => ctx.logger?.info?.('gzh-publisher', ...args)

  const { disposers, call, names } = registerTools(ctx, { config: settings, store, desk, log })
  // remount（非 volatile 字段变了）时把工具摘干净，避免重复注册。
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0).reverse()) {
      if (typeof dispose === 'function') dispose()
    }
  }, 'gzh-publisher: tools')

  // 面板要走的 HTTP 路由。webServer 在无头场景可能不存在，所以可选注入：
  // 缺它只是没有面板，gzh_* 工具照常可用。
  ctx.inject(['webServer'], webCtx => {
    try {
      return registerApiRoutes(webCtx, { api: { call, names }, store, desk, config: settings, log })
    } catch (cause) {
      log(`面板路由没注册上：${cause.message}（工具仍然可用）`)
      return () => {}
    }
  })

  log(`已就绪，账号表 ${store.accountsFile}，皮肤表 ${store.skinsFile}`)
  if (migrated.length > 0) {
    log(`已把 ${migrated.length} 处旧皮肤名换成中性 key：${migrated.map(row => `${row.key}:${row.from}→${row.to}`).join('，')}`)
  }
}
