/**
 * 贴图（图片消息，article_type=newspic）的形式规范：**哪些是微信的墙，哪些是我们自己的口径**。
 *
 * 这两档必须分开，混在一起的后果是「报错文案在撒谎」：
 *   - 微信硬上限（`WECHAT_STICKER`）：文档/实测决定的，配置改不动，超了一定被微信拒。
 *     这一档在这里只做一件事——给所有校验划一条不可越过的天花板。
 *   - 本项目形式规范（`DEFAULT_STICKER_RULES`）：日更做久了形成的口径（贴图靠图数撑场面、
 *     标题短到不折行、说明就几句话）。它**可以按号配置**，优先级：
 *     单次调用参数 > 账号 `sticker` > 全局配置 > 内置默认。
 *
 * 为什么规则要能配：贴图这件事在号与号之间差得很实在——有的号固定「一句金句 + 6 张卡」，
 * 有的号就是「一张图 + 两行话」的单图消息。写死 6 张时，后者每天被自己的闸门拦一次，
 * 而拦下来以后文案里那句「补到 6 张以上」对它是错的。所以这里把口径变成数据，
 * 但**报错文案永远同时报出两档**（我们的数 + 微信的数 + 这个数是从哪一层来的），
 * 否则「凭什么拦我」就变成了查不出来的玄学。
 *
 * @module dsh-gzh-publisher/sticker
 */

/**
 * 微信侧硬上限：不可配置、不可 force。
 * 数值都有出处（官方文档 + 真机跑通），改这里等于改契约，别顺手调。
 */
export const WECHAT_STICKER = {
  /** 贴图标题上限 32 字（图文才是 64 字）。 */
  titleMax: 32,
  /** 微信贴图 1 张就发得出去——所以「至少几张」永远是我们的口径，不是微信的墙。 */
  imageMin: 1,
  /** 一条贴图最多 20 张图，超了微信直接拒（不会截断）。 */
  imageMax: 20,
  /** 摘要 ≤120 字（图文贴图同档）。 */
  digestMax: 120,
  /** 永久图片素材 10MB；传到 9.5MB 就先压，留余量给 multipart 的封装开销。 */
  materialMaxBytes: Math.floor(9.5 * 1048576),
}

/** 内置默认形式规范（README 里写的那套；没配任何东西时就是它）。 */
export const DEFAULT_STICKER_RULES = {
  minImages: 6,
  maxImages: 20,
  titleMax: 20,
  textMax: 1000,
  coverFirst: true,
}

/**
 * 规则字段表：写配置时按它校验，面板按它渲染表单，工具描述按它写默认值。
 * `globalKey` 是 host.js 配置里的扁平字段名（coverFirst 没有全局档：首图当不当封面
 * 是号的形式习惯，不是全站参数）。
 */
export const STICKER_RULE_FIELDS = [
  {
    key: 'minImages',
    label: '每条最少几张图',
    min: 1,
    max: WECHAT_STICKER.imageMax,
    globalKey: 'stickerMinImages',
    hint: '图数下限。微信 1 张就发得出去，所以这是我们的口径：少于它会被拦（force+reason 可绕）。单图消息形式的号填 1。',
  },
  {
    key: 'maxImages',
    label: '每条最多几张图',
    min: 1,
    max: WECHAT_STICKER.imageMax,
    globalKey: 'stickerMaxImages',
    hint: `图数上限，天花板是微信的 ${WECHAT_STICKER.imageMax} 张。填更小是给这个号自己收口（比如固定 9 张），选多了会拒、不会静默丢。`,
  },
  {
    key: 'titleMax',
    label: '标题最多几字',
    min: 1,
    max: WECHAT_STICKER.titleMax,
    globalKey: 'stickerTitleMax',
    hint: `标题字数上限，天花板是微信的 ${WECHAT_STICKER.titleMax} 字（图文才是 64）。`,
  },
  {
    key: 'textMax',
    label: '说明最多几字',
    min: 0,
    max: 5000,
    globalKey: 'stickerTextMax',
    hint: '说明文字（content）字数上限。微信这一档没有公开硬上限，所以完全按我们的口径；填 0 = 要求说明留空。',
  },
  {
    key: 'coverFirst',
    label: '条目 cover 当第一张',
    type: 'boolean',
    hint: '用工作台条目选图时，是否把登记的 cover 放在第一张当封面。关掉 = 首图自己就是封面（配图成套的日更形式）。',
  },
]

/** 字段名 → 定义，校验和展示都查这张表。 */
export const STICKER_RULE_BY_KEY = Object.fromEntries(STICKER_RULE_FIELDS.map(row => [row.key, row]))

const NUMERIC_KEYS = STICKER_RULE_FIELDS.filter(row => row.type === undefined).map(row => row.key)

/** 把「1」「'6'」「6.0」这类输入换成整数；换不成返回 NaN。 */
function toInt(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : NaN
  const text = String(raw ?? '').trim()
  if (text === '') return NaN
  if (!/^-?\d+(\.\d+)?$/.test(text)) return NaN
  return Math.trunc(Number(text))
}

/** 布尔容错：面板传 'true'/'开' 也算，避免把 "false" 这种真值串写进去后开关关不掉。 */
function toBool(raw) {
  if (typeof raw === 'boolean') return raw
  const text = String(raw ?? '').trim().toLowerCase()
  if (['true', '1', 'yes', 'on', '开', '是'].includes(text)) return true
  if (['false', '0', 'no', 'off', '关', '否'].includes(text)) return false
  return NaN
}

/**
 * 校验并归一化一份 sticker 规则（账号字段 / 全局配置 / 调用参数都走它）。
 *
 * 严格是有原因的：这些数字就是闸门本身，写进去一个 60 张的下限，
 * 以后每条贴图都会被拦，而报错只会说「少于 60 张」——没人会想到是配置里手滑。
 *
 * @param {unknown} input 用户传的值（对象 / 布尔 / 空）。
 * @param {{ where?: string, allowEmpty?: boolean }} [options] where 用来把错误指回入口。
 * @returns {object|null} 只含传了且合法的键；返回 null 表示「不设这一档」。
 */
export function normalizeStickerRules(input, options = {}) {
  const where = String(options.where ?? 'sticker')
  if (input === null || input === undefined || input === '' || input === false) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${where} 要传对象：{ minImages: 6, maxImages: 20, titleMax: 20, textMax: 1000, coverFirst: true }`)
  }
  const out = {}
  for (const [key, raw] of Object.entries(input)) {
    const field = STICKER_RULE_BY_KEY[key]
    if (field === undefined) {
      throw new Error(`${where} 里没有「${key}」这一项：能配的只有 ${STICKER_RULE_FIELDS.map(row => row.key).join(' / ')}`)
    }
    if (raw === null || raw === undefined || raw === '') continue
    if (field.type === 'boolean') {
      const bool = toBool(raw)
      if (Number.isNaN(bool)) throw new Error(`${where}.${key} 认不出真假：只接受 true/false（收到「${String(raw)}」）`)
      out[key] = bool
      continue
    }
    const value = toInt(raw)
    if (Number.isNaN(value)) throw new Error(`${where}.${key} 要的是整数，收到「${String(raw)}」`)
    if (value < field.min || value > field.max) {
      throw new Error(`${where}.${key}=${value} 超出可配范围 ${field.min}~${field.max}（${field.hint}）`)
    }
    out[key] = value
  }
  // min/max 只有在两层都给值时才比得出关系；这一条不校验就会出现「下限 12、上限 8」这种
  // 永远推不出去的号。
  if (out.minImages !== undefined && out.maxImages !== undefined && out.minImages > out.maxImages) {
    throw new Error(`${where}.minImages=${out.minImages} 大于 maxImages=${out.maxImages}：这条规则下任何贴图都推不出去`)
  }
  return Object.keys(out).length === 0 ? null : out
}

/**
 * 兜底版校验：用于**运行时读配置**（全局配置、账号表里手改过的值），绝不抛错。
 * 插件激活阶段抛错等于整个插件加载不了，那比一个畸形的数字严重得多；
 * 这里的做法是丢掉坏键、把好键夹进合法范围，坏在哪由调用方说出来。
 *
 * @param {unknown} input 规则形状的任何值。
 * @param {string} [where] 只用来在将来接日志时指明出处。
 * @returns {object} 只含合法键（未校验通过的键缺席，由 resolveStickerRules 退到默认）。
 */
export function sanitizeStickerRules(input, where = '配置') {
  try {
    return normalizeStickerRules(input, { where }) ?? {}
  } catch {
    // 整块都不像样（例如 sticker: "6"）：逐键再试一次，能救一个是一个。
    const out = {}
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      for (const [key, raw] of Object.entries(input)) {
        try {
          const one = normalizeStickerRules({ [key]: raw }, { where: `${where}.${key}` })
          if (one !== null) Object.assign(out, one)
        } catch { /* 这个键丢掉 */ }
      }
    }
    return out
  }
}

/**
 * 解析出**生效**的贴图规则，并说清每个数从哪一层来。
 *
 * 优先级：单次调用参数 > 账号 sticker > 全局配置 > 内置默认。
 * 账号/全局里的值是文件里可能被人手改过的，所以这里再收一次天花板（超出微信硬上限就夹回来，
 * 并把这件事写进 `violations`，让调用方当成警告说出来——静默夹是最坏的）。
 *
 * @param {{ account?: object, args?: object, config?: object }} [layers]
 * @returns {{ rules: object, sources: Record<string, string>, violations: string[], hard: typeof WECHAT_STICKER, summary: string }}
 */
export function resolveStickerRules(layers = {}) {
  // 账号表可能被人手改过：这里只兜住「别把插件弄崩」，被丢掉的键在下面逐字段说出来。
  const rawSticker = layers.account?.sticker
  const accountRules = sanitizeStickerRules(rawSticker, '账号 sticker')
  const dropped = rawSticker !== null && typeof rawSticker === 'object' && !Array.isArray(rawSticker)
    ? Object.keys(rawSticker).filter(key => accountRules[key] === undefined)
    : []
  const config = layers.config ?? {}
  const args = layers.args ?? {}
  const rules = {}
  const sources = {}
  const violations = dropped.map(key => `账号 sticker.${key} 的值「${String(rawSticker?.[key])}」不合法，这一项按上一层（全局配置/内置默认）执行`)

  for (const field of STICKER_RULE_FIELDS) {
    const key = field.key
    let value
    let source
    if (args[key] !== undefined && args[key] !== null && String(args[key]) !== '') {
      value = args[key]
      source = '本次调用参数'
    } else if (accountRules[key] !== undefined) {
      value = accountRules[key]
      source = `账号 ${String(layers.account?.key ?? '').trim() || 'sticker'}`
    } else if (field.globalKey !== undefined && config[field.globalKey] !== undefined && String(config[field.globalKey]) !== '') {
      value = config[field.globalKey]
      source = '全局配置'
    } else {
      value = DEFAULT_STICKER_RULES[key]
      source = '内置默认'
    }
    sources[key] = source
    if (field.type === 'boolean') {
      const bool = toBool(value)
      rules[key] = Number.isNaN(bool) ? DEFAULT_STICKER_RULES[key] : bool
      if (Number.isNaN(bool)) violations.push(`${key} 收到「${String(value)}」（${source}），认不出真假，按 ${DEFAULT_STICKER_RULES[key]} 执行`)
      continue
    }
    let num = toInt(value)
    if (Number.isNaN(num)) {
      violations.push(`${key} 收到「${String(value)}」（${source}），不是整数，按内置默认 ${DEFAULT_STICKER_RULES[key]} 执行`)
      num = DEFAULT_STICKER_RULES[key]
    }
    // 天花板：越界一律夹回来。硬上限在这里不配是刻意的——配了也没用，微信会拒。
    if (num < field.min || num > field.max) {
      const clamped = Math.min(Math.max(num, field.min), field.max)
      violations.push(`${key}=${num}（${source}）超出可配范围 ${field.min}~${field.max}，按 ${clamped} 执行`)
      num = clamped
    }
    rules[key] = num
  }
  if (rules.minImages > rules.maxImages) {
    violations.push(`图数下限 ${rules.minImages} 大于上限 ${rules.maxImages}：已按 ${rules.maxImages} 张收口`)
    rules.minImages = rules.maxImages
  }

  return {
    rules,
    sources,
    violations,
    hard: WECHAT_STICKER,
    summary: `${rules.minImages}~${rules.maxImages} 图／标题 ≤${rules.titleMax} 字／说明 ${rules.textMax === 0 ? '必须留空' : `≤${rules.textMax} 字`}`,
  }
}

/**
 * 一句「这个数是哪来的」：闸门文案里带上它，被拦的人（和模型）才知道该改哪一层。
 * @param {Record<string, string>} sources resolveStickerRules().sources。
 * @param {string} key 规则字段名。
 * @returns {string} 形如「（来自账号 account-a）」。
 */
export function ruleSourceNote(sources, key) {
  const source = String(sources?.[key] ?? '')
  if (source === '' || source === '内置默认') return ''
  return `，来自${source}`
}

/** 工具描述里用的默认口径（别让 README、工具描述、代码三处各写一份数）。 */
export const DEFAULT_RULE_PROSE = `${DEFAULT_STICKER_RULES.minImages}~${DEFAULT_STICKER_RULES.maxImages} 张图、标题 ≤${DEFAULT_STICKER_RULES.titleMax} 字、说明 ≤${DEFAULT_STICKER_RULES.textMax} 字`
