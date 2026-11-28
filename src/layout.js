/**
 * 公众号排版引擎：Markdown → 微信草稿可用的行内样式 HTML。
 *
 * 结构不是凭空设计的，是从四篇线上成稿的 `article.html` 样本里逐条剥出来的。
 * 四篇的骨架**完全一致**，只差配色：同一个模板 + 一张皮肤表。
 *
 * 皮肤表是**可以被使用者替换的**：这里只内置四套示例配色（中性名字），
 * 别人可以在插件设置里新建自己的皮肤（`skins.json`），字段就是 `SKIN_FIELDS`。
 *
 * 骨架（顺序固定，与线上一致）：
 *   根 section（字体/行高/字距）
 *     ├─ 本文看点：14px 灰标签 + 三张 flex 卡片（01/02/03 数字胶囊 + 13px 粗标题）
 *     ├─ 每节：编号方块 + 小标签(INSIGHT/WHY/…，10px 字距 3px) + 18px 粗标题 + 3px 下划线
 *     │        正文段（15px / 1.8 / 两端对齐）
 *     │        强调：==重点== → 下划线；**重点** → 主色 strong
 *     ├─ 配图卡片：白底 12px 圆角 + 1px 边框 + 投影，内层 overflow:hidden，img 100% 自适应
 *     ├─ 金句卡片：左 4px 主色竖条 + 浅色底 + 16px 800 字重
 *     ├─ END 分隔：左右两道渐隐横线 + 中间 11px 字距 3px 的 END
 *     └─ 落款两段（自我介绍 + 三连）
 *   资料领取尾巴（在根 section 之外，和线上一致）
 *
 * 微信编辑器会把文本包成 <span leaf="">，那是它自己的归一化产物，
 * 我们推干净 HTML，不需要手写 leaf。
 *
 * @module dsh-gzh-publisher/layout
 */

/** 根节点：字体栈、行高、字距在所有号里都一样。 */
const ROOT_STYLE =
  "width:100%;box-sizing:border-box;padding:0 10px;background:#ffffff;" +
  "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;" +
  'color:#374151;line-height:1.75;letter-spacing:0.5px;overflow-x:hidden;'

/** 三张看点卡片的公共外框（第一张/中间张带 margin-right，最后一张不带）。 */
const CARD_STYLE =
  'flex:1;background:{cardBg};border-radius:10px;padding:16px 12px;text-align:center;border:1px solid {cardBorder};'

/** 图片外卡：所有号完全一致。 */
const IMAGE_CARD_STYLE =
  'background:#FFF;border-radius:12px;padding:6px;border:1px solid #E5E7EB;box-shadow:0 4px 12px -2px rgba(0,0,0,0.08);margin-bottom:24px;'

/** 小标签默认序列：线上四个号都是这几个词的排列，取众数做默认。 */
export const DEFAULT_EYEBROWS = ['INSIGHT', 'WHY', 'HOW', 'ACTION', 'WARNING']

/**
 * 皮肤可填字段与默认值。自定义皮肤就按这张表校验、补缺省、拒绝未知字段，
 * 所以「内置四套」和「用户自己新建的皮肤」走的是同一套结构，没有特权字段。
 */
export const SKIN_FIELDS = {
  accent: '#3F7D58',      // 主色：编号方块、下划线、竖条、strong
  cardBg: '#F1F7F4',      // 看点卡片底色
  cardBorder: '#FEE2E2',  // 看点卡片边框
  underline: '#C3DFCE',   // ==重点== 的下划线
  quoteBg: '#F1F7F4',     // 金句卡底色
  quoteText: '#2C5A3F',   // 金句字色
  heading: '#1C1917',     // 节标题 / 看点标题字色
}

/** 四套内置示例配色：只是起点，不绑定任何账号；可以在设置里改、也可以完全不用。 */
export const SKINS = {
  teal: {
    label: '青绿',
    accent: '#3F7D58', cardBg: '#F1F7F4', cardBorder: '#FEE2E2',
    underline: '#C3DFCE', quoteBg: '#F1F7F4', quoteText: '#2C5A3F', heading: '#1C1917',
  },
  sage: {
    label: '灰绿留白',
    accent: '#4A5D52', cardBg: '#EEF3F0', cardBorder: '#FEE2E2',
    underline: '#B5C8BC', quoteBg: '#EEF3F0', quoteText: '#3D5046', heading: '#1C1917',
  },
  redwhite: {
    label: '红白',
    accent: '#DC2626', cardBg: '#FEF2F2', cardBorder: '#FEE2E2',
    underline: '#FECACA', quoteBg: '#FEF2F2', quoteText: '#991B1B', heading: '#1C1917',
  },
  graphite: {
    label: '石墨',
    accent: '#3A4149', cardBg: '#F4F6F8', cardBorder: '#FEE2E2',
    underline: '#C9CFD6', quoteBg: '#F4F6F8', quoteText: '#22262B', heading: '#1C1917',
  },
}

/**
 * 旧版本把皮肤按使用者自己的号名命名；老配置（accounts.json 里的 layout）照这张表
 * 映射到中性 key。仓库里只保留**中性别名示例**——谁用谁把自己当年的老名字加进
 * `skins.json` 旁边或直接去面板重选一次；查不到的老名字不会炸，按未知皮肤退回默认。
 */
export const LEGACY_SKIN_KEYS = {
  'account-a': 'teal',
  'account-b': 'sage',
  'account-c': 'redwhite',
  'account-d': 'graphite',
}

/** 自定义皮肤 / 账号内联覆盖的兜底色。 */
const BASE_SKIN = { label: '自定义', ...SKIN_FIELDS }

/** 皮肤 key 规则（和账号 key 一致，前端与工具共用）。 */
export const SKIN_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/

/** 颜色只收 #RGB / #RRGGBB：它们会进 style 属性，别让人带引号进来。 */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** 老 key → 新 key；不是老 key 原样返回。 */
export function migrateSkinKey(value) {
  const key = String(value ?? '').trim()
  return LEGACY_SKIN_KEYS[key] ?? key
}

/**
 * 校验并补齐一套皮肤：只认 `SKIN_FIELDS` 里的颜色字段，未知字段直接报出来
 * （前端表单照这份表渲染，写错了当场知道）。
 *
 * 颜色必须是 #RGB / #RRGGBB：这些值会被原样拼进 `style="…"`，公众号正文里
 * 一段带引号的字符串就能从属性里跳出去。宁可当场不收。
 * @param {object} patch 颜色字段（可只给一部分）。
 * @returns {{ colors: Record<string,string>, unknown: string[], invalid: string[] }}
 */
export function normalizeSkinColors(patch) {
  const colors = {}
  const unknown = []
  const invalid = []
  for (const key of Object.keys(patch ?? {})) {
    if (!(key in SKIN_FIELDS)) { unknown.push(key); continue }
    const value = String(patch[key] ?? '').trim()
    if (value === '') continue
    if (!HEX_COLOR.test(value)) { invalid.push(key); continue }
    colors[key] = value
  }
  return { colors, unknown, invalid }
}

/**
 * 取皮肤：内置名 / 自定义名 / `{ layout: 名, skin: {…覆盖} }`。
 * @param {string|object} [input] 皮肤名，或带 override 的对象。
 * @param {string|{ fallback?: string, custom?: Record<string,object> }} [maybeFallback]
 *        老调用传兜底名；新调用传 `{ fallback, custom }`（custom 来自 skins.json）。
 * @returns {{ skin: object, name: string, unknown: string[] }} 皮肤、实际命中的 key、未知字段。
 */
export function resolveSkin(input, maybeFallback = {}) {
  const options = typeof maybeFallback === 'string' ? { fallback: maybeFallback } : (maybeFallback ?? {})
  const custom = options.custom ?? {}
  const fallback = migrateSkinKey(options.fallback ?? 'teal')
  const named = migrateSkinKey(
    typeof input === 'string' ? input : typeof input?.layout === 'string' ? input.layout : '')
  const table = { ...SKINS, ...custom }
  const hit = named !== '' ? table[named] : undefined
  const key = named !== '' && hit !== undefined ? named : fallback
  const base = table[key] ?? BASE_SKIN
  const override = typeof input === 'object' && input !== null ? input.skin ?? {} : {}
  const { colors, unknown, invalid } = normalizeSkinColors(override)
  return {
    skin: { ...BASE_SKIN, ...base, ...colors, label: base.label ?? key },
    name: key,
    unknown,
    invalid,
  }
}

/** 给前端/工具列皮肤：内置在前，自定义在后，都带上字段说明。 */
export function listSkins(custom = {}) {
  const row = (key, value, builtIn) => ({
    key,
    label: String(value?.label ?? key),
    builtIn,
    colors: Object.fromEntries(Object.entries({ ...SKIN_FIELDS, ...(normalizeSkinColors(value).colors) })
      .filter(([field]) => field !== 'label')),
  })
  return [
    ...Object.entries(SKINS).map(([key, value]) => row(key, value, true)),
    ...Object.entries(custom).map(([key, value]) => row(key, value, false)),
  ]
}


/* ------------------------------ 小工具 ------------------------------ */

/** HTML 转义（正文里出现的尖括号、引号都按字面处理）。 */
const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/** 按 CSS 里用 {token} 的写法插值。 */
const fill = (style, skin) => style.replace(/\{(\w+)\}/g, (_, key) => skin[key] ?? '')

/**
 * 按「字」数——**码点**，不是 UTF-16 单元。
 * 微信的 64 字标题 / 120 字摘要数的都是字，emoji 和生僻字算一个；
 * 用 `String.length` 会把 emoji 数成两个（合法标题被判超长），截断还会切在
 * 代理对中间，推出去一个 U+FFFD 乱码。
 */
export const textLength = text => Array.from(String(text ?? '')).length

/** 按码点截断，超出补省略号。 */
export function clampText(text, max = 22) {
  const chars = Array.from(String(text ?? '').trim())
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** 看点卡片标题截断：线上是 ~20 字加省略号。 */
const clamp = (text, max = 22) => clampText(text, max)

/** 01 / 02 / … 编号。 */
const pad2 = n => String(n).padStart(2, '0')

/**
 * 行内样式：在**已转义**的文本上套用行内语法。
 * `==重点==` → 下划线强调；`**重点**` → 主色加粗；`*重点*` / `_重点_` → 普通加粗。
 */
function inline(text, skin) {
  let out = esc(text)
  out = out.replace(/==([^=]+?)==/g, (_m, body) =>
    `<span style="border-bottom:2px solid ${skin.underline};font-weight:600;">${body}</span>`)
  out = out.replace(/\*\*\*([^*]+?)\*\*\*/g, (_m, body) =>
    `<span style="border-bottom:2px solid ${skin.underline};font-weight:600;"><strong style="color:${skin.accent};">${body}</strong></span>`)
  out = out.replace(/\*\*([^*]+?)\*\*/g, (_m, body) => `<strong style="color:${skin.accent};">${body}</strong>`)
  out = out.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, (_m, pre, body) => `${pre}<strong>${body}</strong>`)
  out = out.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, (_m, pre, body) => `${pre}<strong>${body}</strong>`)
  out = out.replace(/`([^`]+?)`/g, (_m, body) =>
    `<span style="background:#F3F4F6;color:#1F2937;padding:2px 6px;border-radius:4px;font-size:14px;font-weight:600;">${body}</span>`)
  return out
}

/* ------------------------------ 推送前扫描 ------------------------------ */

/** 微信正文里唯一稳的图片域名是自家的 mmbiz 图床。 */
const MMBIZ_HOST = /(?:^|\/\/)(?:[\w-]+\.)*mmbiz\.qpic\.cn\//i
/**
 * 未认证订阅号正文里能点的只有微信自家域名的链接。
 * 导出给贴图链路复用：图片消息的纯文本正文里裸写 http 链接一样被屏蔽，
 * 两处各写一份迟早会漂移成「图文拦、贴图不拦」。
 */
export const WECHAT_LINK = /^https?:\/\/(?:[\w-]+\.)*(?:weixin\.qq\.com|qq\.com)(?:[/?#]|$)/i

/**
 * 扫描成品 HTML，把推上去会被微信**静默处理**的东西挑出来：
 * 非图床配图（不显示）、站外链接（个人订阅号没认证，点了没反应）、`javascript:` 协议。
 * 只负责发现，拒不拒由调用方（`gzh_push_draft`）决定。
 *
 * @param {string} html 成品 HTML。
 * @returns {{ findings: Array<{ kind: string, value: string, why: string }> }}
 */
export function auditWechatSafe(html) {
  const findings = []
  const seen = new Set()
  const push = (kind, value, why) => {
    const key = `${kind}|${value}`
    if (value === '' || seen.has(key)) return
    seen.add(key)
    findings.push({ kind, value, why })
  }
  const text = String(html ?? '')
  for (const match of text.matchAll(/<img[^>]*\ssrc=["']([^"']+)["']/gi)) {
    const src = match[1].trim()
    if (!MMBIZ_HOST.test(src)) push('image', src, '不是微信图床（mmbiz.qpic.cn）的图，推上去显示不出来')
  }
  for (const match of text.matchAll(/<a[^>]*\shref=["']([^"']+)["']/gi)) {
    const href = match[1].trim()
    if (href === '' || href.startsWith('#')) continue
    if (/^javascript:/i.test(href)) {
      push('link', href, 'javascript: 链接会被微信直接剥掉')
      continue
    }
    if (!WECHAT_LINK.test(href)) {
      push('link', href, '个人订阅号未认证，正文里的站外链接会被微信屏蔽（点了没反应）；要留就放「阅读原文」或截图')
    }
  }
  return { findings }
}

/* ------------------------------ 解析 ------------------------------ */

/** 看点区块的标题别名。 */
const OUTLINE_TITLES = ['本文看点', '看点', '导读', '摘要', '大纲']

/** 像一句话的收尾：后面该起新段。 */
const SENTENCE_END = /[。！？!?…；;」』”"\]）】·]$/

/** 明显被硬折的英文软换行：字母/数字结尾 + 小写字母或括号开头。 */
const LATIN_WRAP = value => /[A-Za-z0-9)]$/.test(value)

/** 上一行以连接符号收尾 → 这行还是同一句，不换段。 */
const CLINGING_END = /[,;:，；：、—…-]$|(和|与|及|或|而|但|因为|所以)$|(\band\b|\bthe\b|\ba\b|\bof\b|\bto\b|\bin\b|\bis\b|\bthat\b|\bwhich\b)$/i

/**
 * 段内换行判定。**不追求 CommonMark**，只贴合公众号/口播稿的实际写法：
 *
 * - 空行 → 分段（Markdown 常规）
 * - 行尾**两个空格** → 段内硬换行（`<br>`，Markdown 常规）
 * - 单个换行 → **默认起新段**。产线上的稿子是「一行一句」写出来的
 *   （state.json 里的 production.article 就是这种），旧实现把整块拼成一段，
 *   推到微信就是一坨没有层级的文字——这就是「草稿没排版」的直接原因。
 * - 例外：上一行以逗号/冒号/破折号或英文虚词收尾、或中文长行被硬折行
 *   （≥ 40 字且不是句末收尾）→ 视为同一句的续行，拼回同一行。
 *
 * @param {Array<{ text: string, br?: boolean }>} items 同一段落块里的行。
 * @returns {Array<Array<{ text: string, br: boolean }>>} 拆好的段落，每段是若干行。
 */
export function splitParagraph(items) {
  const paragraphs = []
  /** @type {Array<{ text: string, br: boolean }> | null} */
  let current = null
  for (const item of items ?? []) {
    const text = String(item?.text ?? '').trim()
    if (text === '') continue
    if (current === null) {
      current = [{ text, br: item.br === true }]
      paragraphs.push(current)
      continue
    }
    const previousItem = current[current.length - 1]
    const previous = previousItem.text
    // br 的含义跟着 Markdown：标在「行尾有两个空格」的那一行上，表示这行后面要换行。
    // 所以判断本行是否留在同一段，看的是上一行有没有 br，而不是本行自己。
    const sameLine = previousItem.br === true
      || CLINGING_END.test(previous)
      || (!SENTENCE_END.test(previous) && (LATIN_WRAP(previous) ? /^[a-z("]/.test(text) : previous.length >= 40))
    if (sameLine) current.push({ text, br: item.br === true })
    else {
      current = [{ text, br: false }]
      paragraphs.push(current)
    }
  }
  return paragraphs
}

/**
 * 把 Markdown 拆成排版用的结构。不追求 CommonMark 完备，只覆盖常见产出形态：
 * 二级标题分节、段落、`> 金句`、`![](...)` 配图、有序/无序列表（两级缩进）、
 * 表格、围栏代码块、`---` 分隔线、`####` 小标题。
 *
 * 认不出来的语法不许静默丢：进 `notes`，由 `buildHtml` 并入 `warnings` 给人看。
 *
 * @param {string} markdown 正文。
 * @param {{ title?: string }} [meta] 外部标题（`#` 缺失时用）。
 * @returns {{ title: string, outline: string[], sections: Array, quotes: Array, images: Array, notes: string[] }}
 */
export function parseArticle(markdown, meta = {}) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const result = { title: String(meta.title ?? '').trim(), outline: [], sections: [], quotes: [], images: [], notes: [] }
  let current = null
  let mode = 'body'
  /** @type {Array<{ text: string, br: boolean }>} 正在累积的段落块（一行一句的稿子会拆成多段）。 */
  let buffer = []
  /** @type {string[]} */
  let quoteBuffer = []
  /** @type {{ type: 'ul'|'ol', items: Array<{ text: string, level: number }> } | null} 正在累积的列表。 */
  let listBuffer = null

  // YAML front matter（`---` 包住的元信息块）不是正文。以前两头各漏出一条分隔线、
  // 中间几行 `title: xxx` 变成段落推上去；现在整块跳过并说明。
  let startIndex = 0
  if (String(lines[0] ?? '').trim() === '---') {
    for (let index = 1; index < Math.min(lines.length, 60); index += 1) {
      const closing = String(lines[index] ?? '').trim()
      if (closing === '---' || closing === '...') {
        startIndex = index + 1
        result.notes.push(`已忽略开头的 front matter（第 2-${index} 行），它不是正文`)
        break
      }
    }
  }

  const flushQuote = () => {
    if (quoteBuffer.length === 0) return
    const text = quoteBuffer.join(' ').trim()
    quoteBuffer = []
    if (text !== '') {
      result.quotes.push({ text })
      // 金句归属当前节的末尾，顺序与线上一致（金句在正文之间）
      openSection().blocks.push({ type: 'quote', text })
    }
  }
  const openSection = () => {
    if (current !== null) return current
    // 第一个 `##` 之前的内容：单独一节，不编号（线上是导语，直接在看点之后）
    current = { eyebrow: '', heading: '', blocks: [], lead: true }
    result.sections.push(current)
    return current
  }
  const pushLine = (text, br) => {
    const trimmed = String(text ?? '').trim()
    if (trimmed !== '') buffer.push({ text: trimmed, br: br === true })
  }
  const flushParagraph = () => {
    if (buffer.length === 0) return
    const items = buffer
    buffer = []
    for (const segments of splitParagraph(items)) {
      const text = segments.map(segment => segment.text).join(' ').trim()
      if (text === '') continue
      openSection().blocks.push({ type: 'paragraph', text, segments })
    }
  }
  const flushList = () => {
    if (listBuffer === null) return
    const { type, items } = listBuffer
    listBuffer = null
    if (items.length > 0) openSection().blocks.push({ type: 'list', listType: type, items })
  }
  /** 任何块级语法开始或结束时都先清三个缓冲，保证块的先后顺序跟正文一致。 */
  const flushAll = () => { flushParagraph(); flushQuote(); flushList() }

  /** 表格分隔行：必须有 `|` 和 `-`，否则普通句子里的竖线会被当成表头。 */
  const isTableSeparator = value => /\|/.test(value) && /-/.test(value) && /^\s*\|?[\s:|-]+\|?\s*$/.test(value)
  const tableCells = value => String(value ?? '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())

  for (let index = startIndex; index < lines.length; index += 1) {
    const raw = lines[index]
    const trimmed = raw.trimEnd().trim()

    if (trimmed === '') {
      flushAll()
      continue
    }

    // 围栏代码块：整块收到闭合围栏，语言名只当角标。空围栏不产块。
    const fence = /^```+\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(trimmed)
    if (fence !== null) {
      flushAll()
      const codeLines = []
      let closed = false
      while (index + 1 < lines.length) {
        index += 1
        if (/^```+\s*$/.test(lines[index].trim())) { closed = true; break }
        codeLines.push(lines[index].replace(/\t/g, '  '))
      }
      if (!closed) result.notes.push('代码块的 ``` 没有闭合，已按代码渲染到文末')
      if (codeLines.some(cell => cell.trim() !== '')) {
        openSection().blocks.push({ type: 'code', lang: fence[1].trim(), lines: codeLines })
      }
      continue
    }

    // 表格：本行是表头，下一行必须是 `| --- |` 分隔行；认不出分隔行就按普通段落走。
    if (trimmed.includes('|') && isTableSeparator(String(lines[index + 1] ?? ''))) {
      flushAll()
      const header = tableCells(trimmed)
      const rows = []
      let next = index + 2
      while (next < lines.length) {
        const row = String(lines[next] ?? '')
        if (row.trim() === '' || !row.includes('|')) break
        rows.push(tableCells(row))
        next += 1
      }
      openSection().blocks.push({ type: 'table', header, rows })
      if (header.length > 4) result.notes.push(`表格有 ${header.length} 列，手机上会很挤（建议 ≤4 列）`)
      if (rows.some(row => row.length !== header.length)) result.notes.push('表格有行的列数和表头对不上，缺的按空单元格渲染')
      index = next - 1
      continue
    }

    // 一级标题：只取第一个当标题，其余忽略
    const h1 = /^#\s+(.*)$/.exec(trimmed)
    if (h1) {
      flushAll()
      if (result.title === '') result.title = h1[1].trim()
      continue
    }

    // 二级/三级标题：新节（可选 `INSIGHT｜标题` 前缀）
    const h2 = /^#{2,3}\s+(.*)$/.exec(trimmed)
    if (h2) {
      flushAll()
      let heading = h2[1].replace(/[#*]/g, '').trim()
      let eyebrow = ''
      const split = /^(?:([A-Za-z]{2,10})\s*[|｜]\s*)?(.*)$/.exec(heading)
      if (split !== null && split[1] !== undefined && split[1] !== '') {
        eyebrow = split[1].toUpperCase()
        heading = split[2].trim()
      }
      if (OUTLINE_TITLES.includes(heading)) {
        mode = 'outline'
        current = null
        continue
      }
      mode = 'body'
      current = { eyebrow, heading, blocks: [], lead: false }
      result.sections.push(current)
      continue
    }

    // 四级及以下标题：正文里的小标题。以前会当普通段落，把 `####` 原样推到微信。
    const h4 = /^#{4,6}\s+(.*)$/.exec(trimmed)
    if (h4 !== null) {
      flushAll()
      openSection().blocks.push({ type: 'subhead', text: h4[1].replace(/[#*]/g, '').trim() })
      continue
    }

    // 看点列表（在 `## 本文看点` 之后，或通篇的有序列表开头）
    if (mode === 'outline') {
      const item = /^[-*]\s+(.*)$/.exec(trimmed) ?? /^\d+[.、)]\s+(.*)$/.exec(trimmed)
      if (item !== null) {
        result.outline.push(item[1].replace(/[*_`]/g, '').trim())
        continue
      }
      if (trimmed !== '') {
        mode = 'body'
      }
    }

    // 配图
    const img = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)$/.exec(trimmed)
    if (img !== null) {
      flushAll()
      const src = img[2].trim()
      const image = { src, caption: img[1].trim() }
      result.images.push(image)
      if (current === null) {
        current = { eyebrow: '', heading: '', blocks: [], lead: true }
        result.sections.push(current)
      }
      current.blocks.push({ type: 'image', src, caption: image.caption })
      continue
    }

    // 金句
    if (/^>\s?/.test(trimmed)) {
      flushParagraph()
      flushList()
      quoteBuffer.push(trimmed.replace(/^>\s?/, '').trim())
      continue
    }

    // 分隔线：`---` / `***` / `___` 出一条细的（END 分隔仍由排版统一给）
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll()
      openSection().blocks.push({ type: 'hr' })
      continue
    }

    // 列表：连续的 `- ` / `1. ` 行累积成一个列表块，缩进决定层级（最多三级）。
    // 无序和有序换着出现时算两个列表，序号各自从头数。
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
    const ordinal = /^(\d{1,3})[.、)]\s+(.*)$/.exec(trimmed)
    if (bullet !== null || ordinal !== null) {
      flushParagraph()
      flushQuote()
      const indent = /^\s*/.exec(raw)[0].replace(/\t/g, '  ').length
      const level = indent >= 4 ? 3 : indent >= 2 ? 2 : 1
      const listType = ordinal !== null ? 'ol' : 'ul'
      if (listBuffer !== null && listBuffer.type !== listType) flushList()
      if (listBuffer === null) listBuffer = { type: listType, items: [] }
      listBuffer.items.push({ text: (ordinal !== null ? ordinal[2] : bullet[1]).trim(), level })
      continue
    }

    // 缩进的续行：接在最后一个列表项上（`- 第一项` 下一行缩进接着写）
    if (listBuffer !== null && /^\s{2,}\S/.test(raw)) {
      const last = listBuffer.items[listBuffer.items.length - 1]
      last.text = `${last.text} ${trimmed}`
      continue
    }

    // 普通段落：保留「行尾两个空格 = 段内硬换行」这个信号（raw 还没被 trim 掉尾部）
    flushQuote()
    flushList()
    pushLine(trimmed, / {2,}$/.test(raw))
  }
  flushAll()

  // 看点兜底：没写「本文看点」就用前三个节标题，和线上三张卡一致
  if (result.outline.length === 0) {
    result.outline = result.sections.filter(section => section.heading !== '').slice(0, 3).map(section => section.heading)
    result.outlineDerived = true
  }
  return result
}

/* ------------------------------ 渲染 ------------------------------ */

/** 正文段（15px / 1.8 / 两端对齐）；段内换行跟着 Markdown：行尾两个空格 → 该行后面输出 `<br>`。 */
const paragraphHtml = (block, skin) => {
  const segments = Array.isArray(block?.segments) && block.segments.length > 0
    ? block.segments
    : [{ text: String(typeof block === 'string' ? block : block?.text ?? ''), br: false }]
  // br 标在「上一行」上（Markdown 语义），所以输出在这个片段之后；段尾的 br 丢掉，
  // 不然段末会莫名多出一空行（段间距本来就有 20px）。
  const inner = segments
    .map((segment, index) => `${inline(segment.text, skin)}${segment.br === true && index < segments.length - 1 ? '<br>' : ''}`)
    .join('')
  return `<p style="margin-bottom:20px;font-size:15px;line-height:1.8;text-align:justify;">${inner}</p>`
}

/**
 * 配图卡片。图注取自 `![图注](src)` 的 alt（以前 alt 解析出来了却没人用）。
 * 没有图注时一个字节都不加 —— 各号现有排版的卡片外观不能因为这次改动变样。
 */
function imageHtml(url, skin, caption = '') {
  const note = String(caption ?? '').trim() === ''
    ? ''
    : `  <p style="margin:8px 2px 2px;font-size:13px;line-height:1.6;color:#8A8F99;text-align:center;">${esc(String(caption).trim())}</p>`
  return [
    `<section style="${IMAGE_CARD_STYLE}">`,
    `  <section style="margin:0;border-radius:8px;overflow:hidden;"><img src="${esc(url)}" style="max-width:100%;height:auto;display:block;margin:0 auto;"></section>`,
    note,
    '</section>',
  ].filter(line => line !== '').join('\n')
}

/** 金句卡片。 */
const quoteHtml = (text, skin) => [
  `<section style="background:${skin.quoteBg};border-radius:0 10px 10px 0;border-left:4px solid ${skin.accent};padding:18px 22px;margin-bottom:24px;">`,
  `  <p style="font-size:16px;font-weight:800;color:${skin.quoteText};margin:0;line-height:1.8;">${inline(text, skin)}</p>`,
  '</section>',
].join('\n')

/** 四级小标题：细主色竖条 + 加粗，不编号，和带编号方块的节标题区分开。 */
const subheadHtml = (text, skin) =>
  `<p style="margin:28px 0 14px;padding-left:10px;font-size:16px;font-weight:800;color:${skin.heading};line-height:1.6;border-left:3px solid ${skin.accent};">${inline(text, skin)}</p>`

/**
 * 列表。微信编辑器会吃掉 `<ul>/<ol>` 的 list-style，所以和本插件其它结构一致：
 * 每项一个 flex 行，左边手写圆点/序号（有序按层级各自计数），右边正文；层级用缩进表达。
 */
function listHtml(block, skin) {
  const ordered = block?.listType === 'ol'
  const glyphs = ['•', '–', '·']
  const counters = {}
  const rows = (Array.isArray(block?.items) ? block.items : []).map(item => {
    const level = Math.max(1, Math.min(3, Number(item?.level) || 1))
    if (ordered) {
      counters[level] = (counters[level] ?? 0) + 1
      // 回到上层时，下层的计数作废（`1. a` → `  1. x` → 下一项是 `2.`）
      for (const deeper of Object.keys(counters)) if (Number(deeper) > level) delete counters[deeper]
    }
    const marker = ordered ? `${String(counters[level]).padStart(2, '0')}.` : glyphs[level - 1]
    const indent = level > 1 ? `margin-left:${(level - 1) * 18}px;` : ''
    return [
      `  <section style="display:flex;align-items:flex-start;${indent}">`,
      `    <span style="flex:none;min-width:24px;font-size:15px;line-height:1.8;font-weight:700;color:${skin.accent};">${marker}</span>`,
      `    <section style="flex:1;min-width:0;"><p style="margin:0 0 10px;font-size:15px;line-height:1.8;text-align:justify;">${inline(item?.text, skin)}</p></section>`,
      '  </section>',
    ].join('\n')
  })
  return ['<section style="margin-bottom:14px;">', ...rows, '</section>'].join('\n')
}

/**
 * 表格。不用 `<table>`（微信对 table 的样式还原不稳定），用 flex 行 + 边框：
 * 表头浅底 + 主色下边线，行间斑马纹，手机上等宽铺开。列数多于 4 会在解析期告警。
 */
function tableHtml(block, skin) {
  const header = Array.isArray(block?.header) ? block.header : []
  const rows = Array.isArray(block?.rows) ? block.rows : []
  const cellStyle = 'flex:1;min-width:0;padding:8px 10px;font-size:13px;line-height:1.7;'
  const out = []
  if (header.length > 0) {
    out.push([
      `  <section style="display:flex;background:${skin.cardBg};border-bottom:2px solid ${skin.accent};">`,
      ...header.map(cell => `    <span style="${cellStyle}font-weight:800;color:${skin.heading};">${inline(cell, skin)}</span>`),
      '  </section>',
    ].join('\n'))
  }
  rows.forEach((row, rowIndex) => {
    const cells = Array.isArray(row) ? row : []
    out.push([
      `  <section style="display:flex;${rowIndex % 2 === 1 ? `background:${skin.cardBg};` : ''}border-bottom:1px solid ${skin.cardBorder};">`,
      ...header.map((_cell, columnIndex) => `    <span style="${cellStyle}">${inline(cells[columnIndex] ?? '', skin)}</span>`),
      '  </section>',
    ].join('\n'))
  })
  return [
    `<section style="margin-bottom:24px;border:1px solid ${skin.cardBorder};border-radius:8px;overflow:hidden;">`,
    ...out,
    '</section>',
  ].join('\n')
}

/** 代码块：逐行输出（微信会吃掉连续空白与空 p），缩进转 &nbsp;，长行走 break-all。 */
function codeHtml(block, skin) {
  const lang = String(block?.lang ?? '').trim()
  const out = []
  if (lang !== '') {
    out.push(`  <p style="margin:0 0 8px;font-size:11px;letter-spacing:1px;color:#9CA3AF;font-weight:700;">${esc(lang.toUpperCase())}</p>`)
  }
  for (const line of Array.isArray(block?.lines) ? block.lines : []) {
    const body = esc(String(line ?? '').replace(/\t/g, '  ')).replace(/ /g, '&nbsp;')
    out.push(`  <p style="margin:0;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.7;color:#1F2937;white-space:pre-wrap;word-break:break-all;">${body === '' ? '&nbsp;' : body}</p>`)
  }
  return [
    `<section style="background:#F6F7F5;border-left:3px solid ${skin.accent};border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:24px;overflow-x:auto;">`,
    ...out,
    '</section>',
  ].join('\n')
}

/** 细分隔线：比 END 轻一档，对应正文里自己写的 `---`。 */
const hrHtml = () => [
  '<section style="text-align:center;margin:28px 0;">',
  '  <span style="display:inline-block;width:56px;height:1px;background:#E5E7EB;"><br></span>',
  '</section>',
].join('\n')

/** 节头：编号方块 + 小标签 + 标题 + 3px 下划线。首节 16px 上边距，后续 48px。 */
function sectionHeadHtml(index, eyebrow, heading, skin) {
  const margin = index === 0 ? '16px' : '48px'
  return [
    `<section style="margin-top:${margin};margin-bottom:24px;">`,
    `  <section style="display:flex;align-items:center;margin-bottom:20px;padding-bottom:14px;border-bottom:3px solid ${skin.accent};">`,
    `    <span style="display:inline-block;background:${skin.accent};color:#FFFFFF;font-size:18px;font-weight:900;padding:4px 14px;border-radius:6px;margin-right:14px;line-height:1.3;">${pad2(index + 1)}</span>`,
    '    <section>',
    `      <p style="font-size:10px;color:${skin.accent};font-weight:700;letter-spacing:3px;margin:0 0 2px;text-transform:uppercase;">${esc(eyebrow)}</p>`,
    `      <h3 style="font-size:18px;font-weight:800;color:${skin.heading};margin:0;letter-spacing:0.5px;">${esc(heading)}</h3>`,
    '    </section>',
    '  </section>',
    '</section>',
  ].join('\n')
}

/** 本文看点：标签 + N 张等宽卡片（线上一律三张，超过三张只取三张）。 */
function outlineHtml(items, skin) {
  const cards = items.slice(0, 3).map((text, index) => {
    const last = index === Math.min(items.length, 3) - 1
    const style = fill(CARD_STYLE, skin) + (last ? '' : 'margin-right:8px;')
    return [
      `    <section style="${style}">`,
      `      <p style="display:inline-block;background:${skin.accent};color:#FFFFFF;font-size:12px;font-weight:800;padding:2px 10px;border-radius:4px;margin:0 0 8px;">${pad2(index + 1)}</p>`,
      `      <p style="font-size:13px;font-weight:700;color:${skin.heading};margin:0;">${esc(clamp(text))}</p>`,
      '    </section>',
    ].join('\n')
  })
  return [
    '<section style="padding:0 0 32px;">',
    '  <p style="font-size:14px;color:#9CA3AF;margin:0 0 14px;letter-spacing:1px;">📌 本文看点</p>',
    '  <section style="display:flex;justify-content:space-between;">',
    cards.join('\n'),
    '  </section>',
    '</section>',
  ].join('\n')
}

/** END 分隔：两道渐隐横线 + END。 */
const endHtml = skin => [
  '<section style="text-align:center;margin:8px 0 32px;">',
  '  <section style="display:flex;align-items:center;justify-content:center;">',
  `    <span style="display:inline-block;height:2px;width:60px;background:linear-gradient(to right,transparent,${skin.accent});margin-right:12px;"><br></span>`,
  `    <span style="font-size:11px;color:${skin.accent};letter-spacing:3px;font-weight:700;">END</span>`,
  `    <span style="display:inline-block;height:2px;width:60px;background:linear-gradient(to left,transparent,${skin.accent});margin-left:12px;"><br></span>`,
  '  </section>',
  '</section>',
].join('\n')

/** 落款两段：自我介绍 + 三连。文案按账号配置，缺省用通用说法。 */
function footerHtml(foot, skin) {
  const intro = String(foot?.intro ?? '').trim()
  const cta = String(foot?.cta ?? '点赞、在看、转发').trim()
  const closing = String(foot?.closing ?? '我们下篇见。').trim()
  const blocks = []
  if (intro !== '') blocks.push(`<p style="margin-bottom:20px;font-size:15px;line-height:1.8;text-align:justify;">${esc(intro)}</p>`)
  blocks.push(`<p style="margin-bottom:20px;font-size:15px;line-height:1.8;text-align:justify;">如果你觉得今天这篇有收获，欢迎<strong style="color:${skin.accent};">${esc(cta)}</strong>${esc(closing)}</p>`)
  return `<section style="margin-top:8px;">\n${blocks.join('\n')}\n</section>`
}

/** 资料领取尾巴：在根 section 之外，和线上 article.html 一致。 */
function tailHtml(tail) {
  if (tail === null || tail === undefined) return ''
  if (typeof tail === 'string') {
    return tail.trim() === '' ? '' : `<section style="margin:30px 0 10px;padding:16px 18px;border-radius:10px;background:#F6F7F5;border-left:4px solid #3A4149;">${tail}</section>`
  }
  const title = String(tail.title ?? '资料领取').trim()
  const body = String(tail.body ?? '').trim()
  if (body === '') return ''
  return [
    '<section style="margin:30px 0 10px;padding:16px 18px;border-radius:10px;background:#F6F7F5;border-left:4px solid #3A4149;">',
    `<p style="margin:0 0 8px;font-size:14px;letter-spacing:1px;color:#3A4149;font-weight:600;">${esc(title)}</p>`,
    `<p style="margin:0;font-size:15px;line-height:1.85;color:#333;">${esc(body)}</p>`,
    '</section>',
  ].join('\n')
}

/**
 * 渲染成品 HTML。
 *
 * @param {object} parsed `parseArticle` 的结果。
 * @param {object} options
 * @param {object} options.skin `resolveSkin().skin`
 * @param {Record<string,string>} [options.imageUrls] 原文 src → 微信 mmbiz URL
 * @param {string[]|string} [options.eyebrows] 小标签序列，`false`/`'none'` 表示不加
 * @param {{intro?: string, cta?: string, closing?: string}} [options.foot]
 * @param {{title?: string, body?: string}|string} [options.tail]
 * @returns {{ html: string, stats: object, warnings: string[] }}
 */
export function buildHtml(parsed, options = {}) {
  const skin = options.skin ?? SKINS.teal
  const imageUrls = options.imageUrls ?? {}
  const warnings = []
  const eyebrowMode = options.eyebrows ?? DEFAULT_EYEBROWS
  const eyebrows = eyebrowMode === false || eyebrowMode === 'none' ? [] : Array.isArray(eyebrowMode) ? eyebrowMode : DEFAULT_EYEBROWS
  // 解析期发现的问题（front matter、没闭合的代码围栏、列数太多的表格…）在这里一并暴露，
  // 不再静默降级——「推上去才发现少了东西」是最贵的一种降级。
  for (const note of Array.isArray(parsed.notes) ? parsed.notes : []) warnings.push(note)

  const outline = Array.isArray(parsed.outline) ? parsed.outline.filter(Boolean) : []
  if (parsed.outlineDerived === true && outline.length > 0) {
    warnings.push('看点卡片由节标题自动生成；正文里没写「## 本文看点」列表')
  }

  let missingImages = 0
  const body = []
  const numbered = parsed.sections.filter(section => section.heading !== '')
  let numberIndex = 0

  for (const section of parsed.sections) {
    const isLead = section.lead === true && section.heading === ''
    if (!isLead) {
      const eyebrow = eyebrows[numberIndex % Math.max(eyebrows.length, 1)] ?? ''
      body.push(sectionHeadHtml(numberIndex, section.eyebrow !== '' ? section.eyebrow : eyebrow, section.heading, skin))
      numberIndex += 1
    }
    for (const block of section.blocks) {
      if (block.type === 'paragraph') {
        body.push(paragraphHtml(block, skin))
      } else if (block.type === 'quote') {
        body.push(quoteHtml(block.text, skin))
      } else if (block.type === 'list') {
        body.push(listHtml(block, skin))
      } else if (block.type === 'table') {
        body.push(tableHtml(block, skin))
      } else if (block.type === 'code') {
        body.push(codeHtml(block, skin))
      } else if (block.type === 'subhead') {
        body.push(subheadHtml(block.text, skin))
      } else if (block.type === 'hr') {
        body.push(hrHtml())
      } else if (block.type === 'image') {
        const url = imageUrls[block.src]
        if (typeof url !== 'string' || url === '') {
          missingImages += 1
          warnings.push(`配图未上传，已从正文删除：${block.src}`)
          continue
        }
        body.push(imageHtml(url, skin, block.caption))
      }
    }
  }

  if (numbered.length === 0) warnings.push('正文没有任何 `##` 分节，全部按导语渲染（线上排版每篇都有 3-5 节）')

  const html = [
    `<section style="${ROOT_STYLE}">`,
    outline.length > 0 ? outlineHtml(outline, skin) : '',
    body.join('\n'),
    endHtml(skin),
    footerHtml(options.foot, skin),
    '</section>',
    tailHtml(options.tail),
  ].filter(line => line !== '').join('\n')

  const blocks = parsed.sections.flatMap(section => section.blocks)
  const countOf = kind => blocks.filter(block => block.type === kind).length

  return {
    html,
    stats: {
      sections: numberIndex,
      paragraphs: countOf('paragraph'),
      images: parsed.images.length - missingImages,
      droppedImages: missingImages,
      quotes: parsed.quotes.length,
      outlineCards: Math.min(outline.length, 3),
      // 新加的结构计数：面板/自检用它确认「稿子里的列表、表格、代码块都真的排版了」
      lists: countOf('list'),
      listItems: blocks.reduce((n, b) => n + (b.type === 'list' ? (b.items?.length ?? 0) : 0), 0),
      tables: countOf('table'),
      tableRows: blocks.reduce((n, b) => n + (b.type === 'table' ? (b.rows?.length ?? 0) : 0), 0),
      codeBlocks: countOf('code'),
      subheads: countOf('subhead'),
      dividers: countOf('hr'),
      bytes: Buffer.byteLength(html, 'utf8'),
    },
    warnings,
  }
}

/**
 * 一步渲染：Markdown → HTML。
 * @param {{ markdown: string, title?: string, skin?: object, imageUrls?: object, foot?: object, tail?: object, eyebrows?: string[]|false }} input
 * @returns {{ html: string, stats: object, warnings: string[], title: string }}
 */
export function renderArticle(input) {
  const parsed = parseArticle(input.markdown, { title: input.title })
  const built = buildHtml(parsed, input)
  return { ...built, title: parsed.title }
}
