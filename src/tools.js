/**
 * gzh_* 工具：发现 → 排版 → 审阅 → 推送 → 回读，一步一停，每步都能给人核对。
 * 面板（前端）不另写一套实现，全部通过 routes 的 `/call` 走这里同一份 handler。
 *
 * 设计约束（都来自产线脚本 push_draft.py 的fail-close 语义）：
 *   - 账号必须显式给，不给就用配置里的 defaultAccount；解析不到就报错，绝不猜号。
 *   - author / digest 缺失就报错（可用 autoDigest 自动摘一段）。
 *   - 推送前几道闸：同内容重复推（查本地台账）直接拒；草稿箱里已有同标题的草稿、
 *     正文里有非图床配图或站外链接（个人订阅号未认证，外链点了没反应）也拦，除非显式 force。
 *   - 任何返回值里都不出现 appsecret / proxyToken 原文。
 *
 * @module dsh-gzh-publisher/tools
 */

import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { compressImage, compressorStatus } from './image.js'
import { basename, dirname, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { SKINS, SKIN_FIELDS, resolveSkin, listSkins, parseArticle, buildHtml, textLength, clampText, auditWechatSafe, WECHAT_LINK } from './layout.js'
import { planImages } from './images.js'
import { createClient } from './wechat.js'
import {
  WECHAT_STICKER, DEFAULT_STICKER_RULES, DEFAULT_RULE_PROSE, STICKER_RULE_FIELDS, STICKER_RULE_BY_KEY,
  normalizeStickerRules, resolveStickerRules,
} from './sticker.js'

/** 工具错误：带上下一步怎么做。 */
function fail(message, hint = '') {
  const error = new Error(hint === '' ? message : `${message}｜${hint}`)
  return error
}

/**
 * 这个 DSH 版本要求每个工具都声明 output（否则注册即抛 `tool "x" must declare output { schema, render, presentationMeta? }`）：
 *   - `schema` 描述 execute 的返回值，宿主会拿它校验返回值（validateJsonSchemaValue），不合法就报 ToolOutputError；
 *   - `render(args, value)` 决定模型与界面看到什么 ContentBlock[]。
 * 我们所有工具都返回「一层普通对象」，所以统一用宽松的 object schema + JSON 文本渲染；
 * 某个工具想要更好看的呈现，自带 output 即可覆盖这里的默认值。
 * 两个由此而来的硬约束：
 *   1. 宿主先 snapshotJsonValue 再校验，返回值必须是**无损 JSON**——不能有 undefined、NaN、Infinity、函数、Error 实例；
 *   2. 校验后值会被 deepFreeze，工具不要把内部可变对象直接当结果返回。
 */
const defaultOutput = {
  schema: {
    type: 'object',
    additionalProperties: true,
    description: '结果对象。ok=true 表示成功；失败不返回结果而是抛错（错里带下一步怎么做）。',
  },
  render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

/** 数字入参兜底：脏值退回默认值，避免把 NaN 带进返回值（宿主按无损 JSON 校验会直接报错）。 */
function numArg(value, fallback, min, max) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

/** 文件名用的 slug：保留中英文数字，其余丢掉（按码点截，别把 emoji 切一半）。 */
function slugify(title) {
  const text = String(title ?? '').replace(/[\s《》「」【】（）()，。、,.：:；;！!？?"'"'“”‘’\-—_/\\]+/g, '-')
    .replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
  return Array.from(text).slice(0, 40).join('') || 'draft'
}

/**
 * 从 Markdown 兜一段摘要：去掉代码块、表格行与标题行，把剩下的正文从头串起来，
 * 截到 110 字（微信上限 120，按码点数）。整篇都摘不出东西时才退回标题。
 */
function autoDigest(markdown, fallbackTitle) {
  // 代码块和表格行不进摘要：推上去会变成一坨 `|---|` 或半行代码。
  const body = String(markdown ?? '')
    .replace(/^```[\s\S]*?^```[ \t]*$/gm, '')
    .replace(/^\s*\|.*$/gm, '')
    // 标题行也不进：微信列表里它已经显示在摘要上面，重复一遍只会把正文挤掉。
    .replace(/^#{1,6}\s.*$/gm, '')
  const paragraphs = body.split(/\n\s*\n/)
    .map(line => line.replace(/^#+\s*/, '').replace(/^>\s?/gm, '').replace(/^\s*[-*+]\s+/gm, '').trim())
    .filter(line => line !== '' && !/^!\[/.test(line))
  // 先去链接再去标记，最后把段内软换行压成空格：摘要在微信列表里是单行显示，带 \n 会露出奇怪的断行。
  const first = paragraphs.join(' ').replace(/!?\[[^\]]*\]\([^)]*\)/g, '').replace(/[*_`=]/g, '')
    .replace(/\s+/g, ' ').trim()
  const text = first === '' ? String(fallbackTitle ?? '') : first
  return clampText(text, 110)
}

/**
 * 评论区开关：账号上配 `comment: { open, fansOnly }`，push 可以用 commentOpen /
 * commentFansOnly 临时覆盖。缺省和线上一致（开放评论、不限粉丝），
 * 所以老账号的行为不会因为加了这两个字段而变。
 */
function commentSetting(account, pushArgs = {}) {
  const configured = account?.comment ?? {}
  const open = pushArgs.commentOpen ?? configured.open
  const fansOnly = pushArgs.commentFansOnly ?? configured.fansOnly
  return { open: open !== false, fansOnly: fansOnly === true }
}

/**
 * 贴图（图片消息 / newspic）的边界：**两档，别混为一谈**。数字本身在 `src/sticker.js`，
 * 这里只说清校验时怎么用它——因为「贴图被拦」绝大多数不是 bug，而是这两档被搞混了。
 *
 * 【微信硬上限 WECHAT_STICKER】官方 draft/add 文档 + 真机探针，改不了也 force 不掉：
 *   一次 1~20 张图（第一张当封面，不传 thumb_media_id）、标题 32 字（**比图文的 64 短一半**）、
 *   正文只支持纯文本、单张永久图片素材 10MB。
 *
 * 【本项目形式规范 sticker】比微信严，且**可以配**：
 *   单次调用参数 > 账号 `sticker` 块 > 全局配置 stickerXxx > 内置默认（见 DEFAULT_STICKER_RULES）。
 *   默认口径见 `DEFAULT_STICKER_RULES`（工具描述里的数由 `DEFAULT_RULE_PROSE` 注入，不在这手抄）——
 *   它是「一组内容」的经验值，不是普适真理：
 *   单图消息形式的号就该把自己的下限配成 1，而不是每天被闸门拦一次再去勾 force。
 *   所以：拦下来时，报错里必须同时出现**我们的数、这个数来自哪一层、微信的天花板**，
 *   否则被拦的人只能看到「少于 6 张」，猜不到该去改哪个号。
 *   形式规范可被 force=true + reason 绕过；微信硬上限永远绕不过。
 */

/**
 * Markdown → 贴图说明（纯文本）。
 *
 * 洗掉的每一样都是「在贴图里会变成噪音」的东西：HTML 标签会原样显示；`##`、`==`、`-`
 * 这些标记同理；图片引用丢掉（图本身就在上面，重复引一次只会占行）；链接**只留文字**——
 * 未认证号贴图里的裸链接点了没反应，留着等于骗人点。表格分隔行是纯符号，也丢。
 * 段落换行保留（最多一个空行）：贴图说明是支持换行的，全压成一行反而读不下去。
 */
function plainTextFromMarkdown(markdown) {
  return String(markdown ?? '')
    // 代码块整段丢：贴图没有等宽字体，一段代码在这里就是一堆对不齐的符号。
    .replace(/^```[\s\S]*?^```[ \t]*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]{1,300}>/g, '')
    .replace(/^\s*\|[\s:|-]+\|\s*$/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>+\s?/gm, '')
    .replace(/==|~~|`/g, '')
    .replace(/\*{1,2}/g, '')
    // 下划线只成对去掉：snake_case 文件名里的单个下划线不是斜体标记。
    .replace(/__([^_\n]+)__|\B_([^_\n]+)_\B/g, '$1$2')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 贴图正文的外链与「图片残留」扫描。`auditWechatSafe` 挑的是 `<a href>`，纯文本里没有标签，
 * 所以这里扫裸链接——个人订阅号未认证，贴图说明里的站外链接一样点不开。
 *
 * 顺带把「说明里冒出的图片」也当错误挑出来：贴图没有正文，图片引用洗掉之后剩下的
 * `![` / `<img` / 一串本地路径，会当成字面量显示在说明里——那是肉眼可见的事故，
 * 不是能忽略的格式问题。图片只能走配图（image_list）。
 * @param {string} text 纯文本正文。
 * @returns {Array<{kind: string, value: string, why: string}>}
 */
function auditStickerText(text) {
  const findings = []
  const seen = new Set()
  const push = (kind, value, why) => {
    const cut = String(value ?? '').trim().slice(0, 80)
    if (cut === '' || seen.has(`${kind}|${cut}`)) return
    seen.add(`${kind}|${cut}`)
    findings.push({ kind, value: cut, why })
  }
  for (const match of String(text ?? '').matchAll(/!\[[^\]\n]{0,80}\]?(?:\([^)\n]{0,200}\))?|<img\b[^>\n]{0,300}>?/gi)) {
    push('image', match[0], '贴图正文只有纯文本，图片要当配图传上去；这句里的图片标记会原样显示成 ! [ … 这样的字')
  }
  for (const match of String(text ?? '').matchAll(/[\w.\-/\\]{2,}\.(?:png|jpe?g|gif|webp|bmp|heic)\b/gi)) {
    push('path', match[0], '说明里出现了图片文件名/路径（贴图没有正文，图就在上面，这串字没人看得懂）；删掉它，或把这张图加进配图')
  }
  for (const match of String(text ?? '').matchAll(/https?:\/\/\S+|www\.[\w-]+(?:\.[\w-]+)+/gi)) {
    // 结尾的中文/英文标点是句子的一部分，不该算进链接里。
    const value = match[0].replace(/[)）\]】.,;:!?。，；：！？]+$/, '')
    if (value === '') continue
    const absolute = /^https?:\/\//i.test(value) ? value : `http://${value}`
    if (WECHAT_LINK.test(absolute)) continue
    push('link', value, '贴图说明里的站外链接在未认证订阅号上点不开，删掉或改成截图')
  }
  return findings
}

/**
 * 贴图配图 → 永久图片素材 media_id。
 *
 * 为什么不用现成的 `uploadOne`：它走 `/cgi-bin/media/uploadimg`，只回一个 mmbiz **URL**，
 * 而贴图的 `image_info` 要的是 **media_id**，两者不通用。永久素材占素材库名额
 * （图片+图文类共 10 万），所以按「号 + 图片字节 sha256」缓存，同一张图在同一个号上只传一次。
 * 串行上传：代理是单实例，十几张图并发打过去更容易超时，超时的代价是白占一格素材库。
 *
 * @param {object} client wechat.js 的客户端。
 * @param {object} store 插件数据层（用 findMaterial / appendMaterial）。
 * @param {Array<{localPath: string, fileName: string}>} files 选定顺序的图。
 * @param {{outDir: string, maxEdge: number, timeoutMs: number, config: object}} options
 * @returns {Promise<{mediaIds: string[], rows: Array, error?: string}>}
 */
async function uploadStickerImages(client, store, files, options) {
  const rows = []
  const mediaIds = []
  for (const [index, file] of files.entries()) {
    const label = `第 ${index + 1} 张（${file.fileName || basename(file.localPath)}）`
    // 选图阶段已经按内容算过一次 sha：带着它就能先查缓存，命中的图连文件都不必读。
    // 传 20 张图时，重复推一条改过说明文字的贴图只重传真正变了的那几张。
    if (String(file.sha ?? '') !== '') {
      const cached = store.findMaterial({ appid: client.appid, sha: file.sha })
      if (cached !== null && String(cached.mediaId ?? '') !== '') {
        mediaIds.push(cached.mediaId)
        rows.push({ index, fileName: file.fileName, bytes: file.bytes ?? 0, sha: file.sha.slice(0, 12), mediaId: cached.mediaId, uploaded: false, note: '命中缓存，复用已上传的永久素材' })
        continue
      }
    }
    let buffer
    try {
      buffer = readFileSync(file.localPath)
    } catch (cause) {
      return { mediaIds, rows, error: `${label} 读不出来：${cause.message}` }
    }
    const sha = String(file.sha ?? '') !== '' ? file.sha : createHash('sha256').update(buffer).digest('hex')
    let payload = buffer
    let note = `${(buffer.byteLength / 1048576).toFixed(2)}MB 直接上传`
    if (buffer.byteLength > options.maxBytes) {
      mkdirSync(options.outDir, { recursive: true })
      const temp = join(options.outDir, `sticker-${sha.slice(0, 16)}${extname(file.localPath) || '.jpg'}`)
      writeFileSync(temp, buffer)
      const compressed = await compressImage(temp, { outDir: options.outDir, maxBytes: options.maxBytes, maxEdge: options.maxEdge, timeoutMs: options.timeoutMs, config: options.config })
      if (!compressed.ok) {
        return { mediaIds, rows, error: `${label} ${(buffer.byteLength / 1048576).toFixed(2)}MB 超过永久素材 10MB 上限，自动压缩失败：${compressed.error}` }
      }
      payload = readFileSync(compressed.path)
      note = `${(buffer.byteLength / 1048576).toFixed(2)}MB → ${(compressed.bytes / 1048576).toFixed(2)}MB（JPEG q${compressed.quality} ${compressed.width}×${compressed.height}）`
    }
    try {
      const mediaId = await client.addImageMaterial(payload, file.fileName || basename(file.localPath))
      store.appendMaterial({ appid: client.appid, sha, mediaId, fileName: file.fileName || basename(file.localPath), bytes: payload.byteLength })
      mediaIds.push(mediaId)
      rows.push({ index, fileName: file.fileName, bytes: payload.byteLength, sha: sha.slice(0, 12), mediaId, uploaded: true, note })
    } catch (cause) {
      // 已经传上去的图不回滚（素材库没有删除接口可用在这里），但必须说清停在哪一张：
      // 重推时前面的会命中缓存，只有失败这张会再传一次。
      return { mediaIds, rows, error: `${label} 上传永久素材失败：${cause.message}${cause.hint ? `｜${cause.hint}` : ''}` }
    }
  }
  return { mediaIds, rows }
}

/**
 * 内置样稿：只用来验证排版结构（看点卡 / 节标题 / 正文 / 配图 / 金句 / 落款），
 * 内容是中性的占位文字，不含任何人的号名、自我介绍或资料领取文案。
 * `gzh_layout_preview` 默认用它；也可以传自己的 Markdown 来预览真实稿件。
 */
const SAMPLE_MARKDOWN = [
  '## 本文看点',
  '',
  '- 看点一：检查看点卡片的编号、等宽与长标题截断',
  '- 看点二：检查金句卡与配图卡的顺序',
  '- 看点三：检查节标题的编号方块与小标签',
  '',
  '## INSIGHT｜第一节标题：检查编号方块、小标签与下划线',
  '',
  '这是一段普通正文，用来检查 15px 字号、1.8 行高与两端对齐。这里有 ==下划线强调==，也有 **主色加粗**，还有 `行内代码`。',
  '',
  '![配图说明：检查图片外卡与圆角](https://mmbiz.qpic.cn/sample/0?from=appmsg)',
  '',
  '下面这段是「一行一句」的写法：每行一个换行，排版应该逐行分段，而不是糊成一整段。',
  '第一行短句。',
  '第二行短句。',
  '',
  '## WHY｜第二节标题：检查节与节之间的 48px 间距',
  '',
  '> 这是一句金句，检查左侧主色竖条与浅色底。',
  '',
  '第二节的正文段落，用来确认金句卡之后的段落间距。',
].join('\n')

/** 皮肤字段的中文说明：面板按这张表渲染表单，工具按它给提示。 */
const SKIN_FIELD_DESC = {
  accent: '主色：编号方块、==重点==下划线、金句竖条、**加粗**字色',
  cardBg: '「本文看点」卡片底色',
  cardBorder: '「本文看点」卡片边框',
  underline: '==重点== 的下划线色',
  quoteBg: '金句卡底色',
  quoteText: '金句字色',
  heading: '节标题与看点标题字色',
}

/**
 * 全局参数的说明表（键名与 host.js 的 Config 一一对应）。
 * `gzh_config_get` 按它挑字段、给提示；这些参数只能在宿主插件详情页改。
 */
const CONFIG_HINTS = {
  enabled: '插件总开关；false 时所有 gzh_* 工具拒绝执行',
  defaultAccount: '不带 account 参数时用的账号 key；留空 = 必须显式指定（防串号）',
  defaultLayout: '账号没配 layout 时的皮肤 key',
  mediaDeskDir: '自媒体工作台数据目录，留空 = ~/.dsh/media-desk',
  dataDir: '插件数据目录（账号表/皮肤表/台账/渲染产物），留空 = ~/.dsh/gzh-publisher',
  autoDigest: '缺摘要时自动摘正文第一段（≤110 字）；关掉则缺摘要直接报错',
  allowDirectApi: '允许 proxyUrl 留空时直连 api.weixin.qq.com（需把本机出口 IP 加进公众号白名单）',
  maxImageMb: '配图上传上限（MB），微信 uploadimg 硬限制 1MB',
  imageMaxEdge: '压缩长边上限（像素），公众号正文显示宽约 677px',
  pythonPath: '压图用的 Python（需 Pillow），留空 = 自动找 DSH 自带 runtime',
  compressTimeoutMs: '单张图压缩超时（毫秒）',
  timeoutMs: '单次微信接口请求超时（毫秒）',
}
// 贴图规则的全局档：文案由字段表生成，免得这里写一份「默认 20」而内置默认已经被改了。
for (const row of STICKER_RULE_FIELDS) {
  if (row.globalKey === undefined) continue
  CONFIG_HINTS[row.globalKey] = `贴图形式规范（${row.label}）的全局默认，内置默认 ${DEFAULT_STICKER_RULES[row.key]}；账号 sticker.${row.key} 覆盖它。可配范围 ${row.min}~${row.max}${row.max === WECHAT_STICKER.imageMax || row.max === WECHAT_STICKER.titleMax ? '（上限就是微信硬上限）' : ''}`
}

/**
 * 图片字节 → 微信可用的上传。
 * 超过 1MB 的图先压（长边收到 maxEdge、质量阶梯降档），压完再传；压不动才报错并说清原因。
 */
async function uploadOne(client, source, { maxBytes, maxEdge, upload, outDir, config, timeoutMs = 120_000 }) {
  if (source.kind === 'remote') {
    if (/mmbiz\.qpic\.cn/i.test(source.src)) return { url: source.src, note: '已是微信图床，直接引用' }
    if (upload !== true) return { error: '非微信图床的外链图片，upload=false 时不下载上传' }
    try {
      const response = await fetch(source.src, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) return { error: `下载失败 HTTP ${response.status}` }
      const buffer = Buffer.from(await response.arrayBuffer())
      const name = `${createHash('sha1').update(source.src).digest('hex').slice(0, 12)}${extname(source.src.split('?')[0]) || '.png'}`
      if (buffer.byteLength <= maxBytes) {
        return { url: await client.uploadImage(buffer, name), note: `已下载 ${(buffer.byteLength / 1048576).toFixed(2)}MB 并上传到微信图床` }
      }
      // 下载下来的图也要过压图这一关：先落到压缩目录再走同一条路
      mkdirSync(outDir, { recursive: true })
      const temp = join(outDir, `${createHash('sha1').update(`${source.src}|${buffer.byteLength}`).digest('hex').slice(0, 16)}.src`)
      writeFileSync(temp, buffer)
      const compressed = await compressImage(temp, { outDir, maxBytes, maxEdge, timeoutMs, config })
      if (!compressed.ok) {
        return { error: `下载后 ${(buffer.byteLength / 1048576).toFixed(2)}MB 超 1MB 且压缩失败：${compressed.error}` }
      }
      const url = await client.uploadImage(readFileSync(compressed.path), `${compressed.path.slice(-12)}.jpg`)
      return { url, note: `已下载并压缩 ${(buffer.byteLength / 1048576).toFixed(2)}MB → ${(compressed.bytes / 1048576).toFixed(2)}MB（JPEG q${compressed.quality} ${compressed.width}×${compressed.height}）` }
    } catch (cause) {
      return { error: `下载失败：${cause.message}` }
    }
  }
  if (source.localPath === '' || !existsSync(source.localPath)) {
    const tried = String(source.tried ?? '')
    // 正文里写的是相对路径时，只报「配图1.png 不存在」等于没说——要报我们到底去哪个目录找的。
    const where = tried === '' || tried === source.src ? '' : `（按正文所在目录找：${tried}）`
    const pasteHint = tried === '' && source.kind === 'unknown'
      ? '；正文是粘进来的，相对路径没法定位——改成绝对路径，或者用 itemId 走工作台条目'
      : ''
    return { error: `本地素材不存在：${source.src}${where}${pasteHint}` }
  }
  const bytes = statSync(source.localPath).size
  if (upload !== true) {
    const over = bytes > maxBytes ? `，超过 1MB 上限，推之前会自动压` : ''
    return { error: `upload=false，未上传（${(bytes / 1048576).toFixed(2)}MB${over}）` }
  }
  if (bytes <= maxBytes) {
    const url = await client.uploadImage(readFileSync(source.localPath), basename(source.localPath))
    return { url, note: `${(bytes / 1048576).toFixed(2)}MB 已上传` }
  }
  const compressed = await compressImage(source.localPath, { outDir, maxBytes, maxEdge, timeoutMs, config })
  if (!compressed.ok) {
    return { error: `${(bytes / 1048576).toFixed(2)}MB 超过微信正文配图 1MB 限制，自动压缩失败：${compressed.error}` }
  }
  const url = await client.uploadImage(readFileSync(compressed.path), basename(compressed.path))
  const from = `${(bytes / 1048576).toFixed(2)}MB`
  const to = `${(compressed.bytes / 1048576).toFixed(2)}MB`
  const how = compressed.note === '' ? `JPEG q${compressed.quality} ${compressed.width}×${compressed.height}` : compressed.note
  return { url, note: `${from} → ${to} 已上传（${how}）` }
}

/**
 * 注册工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ config: () => object, store: object, desk: object, log: (...a: any[]) => void }} deps
 */
export function registerTools(ctx, deps) {
  const { store, desk } = deps
  const cfg = () => deps.config()

  /** 账号解析：显式 key → defaultAccount；缺关键字段直接拒。 */
  function resolveAccount(key, { needSecret = false } = {}) {
    const accounts = store.readAccounts()
    const wanted = String(key ?? '').trim() || String(cfg().defaultAccount ?? '').trim()
    if (wanted === '') {
      throw fail('没有指定公众号账号', 'gzh_account_set 建一个并填 appid/appsecret/proxyUrl，或用 defaultAccount 指定默认号；每次调用都显式带 account 最保险（防串号）')
    }
    const account = accounts[wanted]
    if (account === undefined) {
      throw fail(`账号「${wanted}」不存在`, `已有账号：${Object.keys(accounts).join('、') || '（一个都还没有）'}`)
    }
    if (account.enabled === false) throw fail(`账号「${wanted}」已停用`, 'gzh_account_set 传 enabled=true 恢复')
    if (String(account.proxyUrl ?? '') === '' && cfg().allowDirectApi !== true) {
      throw fail(`账号「${wanted}」没配 proxyUrl`, '填 proxyUrl 走代理；确实要直连 api.weixin.qq.com 就打开 allowDirectApi，并确保本机出口 IP 已进公众号后台白名单')
    }
    const missing = ['appid'].filter(field => String(account[field] ?? '') === '')
    if (needSecret && String(account.appsecret ?? '') === '') missing.push('appsecret')
    if (missing.length > 0) {
      throw fail(`账号「${wanted}」缺 ${missing.join(' / ')}`, '用 gzh_account_set 补齐；appid/appsecret 在公众号后台「设置与开发 → 基本配置」里')
    }
    return { key: wanted, ...account }
  }

  /**
   * 注册并记录 disposer，remount 时统一释放。
   * enabled 是 volatile 字段（改它不触发 remount），所以停用判断放在每次调用入口。
   */
  const disposers = []
  /** name → 带闸门的可调用体。工具调用和面板路由调用走的是同一份，杜绝两套实现漂移。 */
  const handlers = new Map()
  const register = tool => {
    const guarded = async args => {
      if (cfg().enabled !== true) throw fail('本插件在设置里已停用（enabled=false）', '在「公众号草稿推送」设置里打开 enabled 再调用')
      return tool.execute(args)
    }
    handlers.set(tool.name, guarded)
    disposers.push(ctx.tools.register({ ...tool, output: tool.output ?? defaultOutput, execute: guarded }))
  }

  register({
    name: 'gzh_account_list',
    description: '看已配置的公众号账号（appid/代理地址掩码显示，密钥永不回显）、默认账号、可用皮肤（内置 + 用户在设置里新建的），以及最近 5 条推送台账。开始任何推送前先调它。',
    parameters: {},
    async execute() {
      const accounts = store.readAccounts()
      const skins = listSkins(store.readSkins())
      return {
        ok: true,
        defaultAccount: cfg().defaultAccount || null,
        defaultLayout: cfg().defaultLayout,
        allowDirectApi: cfg().allowDirectApi === true,
        outDir: store.outDir,
        accountsFile: store.accountsFile,
        skinsFile: store.skinsFile,
        // 皮肤是「可增删的表」，不是四个常量：这里合并内置与用户自定义，前端只认这一份。
        skins: skins.map(row => ({ key: row.key, label: row.label, builtIn: row.builtIn, accent: row.colors.accent })),
        accounts: Object.entries(accounts).map(([key, account]) => {
          const resolved = resolveSkin(account.layout ?? cfg().defaultLayout, { custom: store.readSkins() })
          // 贴图规则一并按「这个号真正会用的数」给出：只回显 sticker 原始值的话，
          // 面板和模型还是得自己脑补优先级，最容易补出来的错是「号里没写 = 不能少于 6 张」。
          const sticker = resolveStickerRules({ account: { key, ...account }, config: cfg() })
          return {
            ...store.publicAccount(key, account),
            layout: String(account.layout ?? ''),
            layoutLabel: resolved.skin.label,
            layoutKnown: String(account.layout ?? '') === '' ? null : resolved.name === String(account.layout),
            sticker: {
              summary: sticker.summary,
              values: sticker.rules,
              sources: sticker.sources,
              configured: account.sticker ?? null,
              violations: sticker.violations,
            },
          }
        }),
        recentPushes: store.readLedger().slice(0, 5),
      }
    },
  })

  register({
    name: 'gzh_account_set',
    description: `新建或修改一个公众号账号（合并式，只改传入字段）。字段：name/alias/appid/appsecret/proxyUrl/proxyToken/author/digest/thumbMediaId/contentSourceUrl/layout/skin/eyebrows/foot/tail/enabled/note/comment/sticker。layout 填皮肤 key（用 gzh_skin_list 查，内置四套 + 你自己新建的）。comment 是评论区开关 {"open":true,"fansOnly":false}。sticker 是**这个号的贴图形式规范**：{"minImages":6,"maxImages":20,"titleMax":20,"textMax":1000,"coverFirst":true}，也是块内合并（只改 minImages 不会把 titleMax 悄悄抹回默认）。它是 gzh_push_sticker 的长期口径，改在这里面板才会跟着变；只放宽某一次请用 push 参数。合法范围见 sticker 字段说明，越界或不认识的键会在写入前直接报错（不会存进去一半）。appsecret 与 proxyToken 按密钥处理：写一次、只回显尾 4 位、传空串删除。`,
    parameters: {
      account: { type: 'string', required: true, description: '账号 key，小写字母数字与 -/_，例如 my-gzh。推送时用它选号。' },
      name: { type: 'string', description: '账号显示名，例如 我的日更号。' },
      appid: { type: 'string', description: '公众号 AppID（wx 开头）。' },
      appsecret: { type: 'string', description: '公众号 AppSecret。只写不回显。' },
      proxyUrl: { type: 'string', description: '微信接口代理根地址，例如 https://proxy.example.com/wxproxy（请一定用 https：appsecret 与 proxyToken 会经过这个地址）。留空 = 直连 api.weixin.qq.com（需 allowDirectApi 且本机 IP 已加白名单）。' },
      proxyToken: { type: 'string', description: '代理鉴权令牌，放进请求头 X-Proxy-Token。只写不回显。' },
      author: { type: 'string', description: '默认作者。push 时没给 author 就用它；两者都空会 fail-close。' },
      digest: { type: 'string', description: `默认摘要（≤${WECHAT_STICKER.digestMax} 字）。` },
      thumbMediaId: { type: 'string', description: '默认封面素材 media_id。' },
      contentSourceUrl: { type: 'string', description: '「阅读原文」链接。' },
      layout: { type: 'string', description: '排版皮肤 key（gzh_skin_list 可查）。留空 = 用全局 defaultLayout。' },
      skin: { type: 'object', additionalProperties: true, description: '在皮肤上再覆盖配色，例如 {"accent":"#1F6FEB"}。' },
      eyebrows: { type: 'array', items: { type: 'string' }, description: '每节小标签序列，例如 ["INSIGHT","WHY","ACTION"]；传 ["none"] 表示不加。' },
      foot: { type: 'object', additionalProperties: true, description: '落款：{"intro":"我是 …","cta":"点赞、在看、转发","closing":"我们下篇见。"}' },
      tail: { type: 'object', additionalProperties: true, description: '文末「资料领取」：{"title":"资料领取","body":"后台回复关键词「XX」领取 …"}' },
      comment: { type: 'object', additionalProperties: true, description: '评论区默认开关：{"open":true,"fansOnly":false}。单次推送的 commentOpen / commentFansOnly 覆盖它。' },
      sticker: {
        type: 'object',
        additionalProperties: true,
        description: `该号的贴图形式规范（gzh_push_sticker 长期口径，块内合并）：{"minImages":6,"maxImages":20,"titleMax":20,"textMax":1000,"coverFirst":true}。minImages/maxImages ${WECHAT_STICKER.imageMin}~${WECHAT_STICKER.imageMax}（${WECHAT_STICKER.imageMax} 就是微信硬上限，配不出更高的）；titleMax 1~${WECHAT_STICKER.titleMax}；textMax 0~5000（0 = 这个号发纯图贴图，说明必须留空）；coverFirst=false 表示首图自己就是封面，不把工作台的 cover 挪到第一位。想按号放宽的合理理由是这个号的形式确实不是 ${DEFAULT_RULE_PROSE}，不是「这条稿子凑不够」。`,
        properties: {
          minImages: { type: 'integer', minimum: WECHAT_STICKER.imageMin, maximum: WECHAT_STICKER.imageMax, description: '每条贴图最少几张图。' },
          maxImages: { type: 'integer', minimum: WECHAT_STICKER.imageMin, maximum: WECHAT_STICKER.imageMax, description: `每条贴图最多几张图（天花板 ${WECHAT_STICKER.imageMax} = 微信硬上限）。` },
          titleMax: { type: 'integer', minimum: 1, maximum: WECHAT_STICKER.titleMax, description: `标题字数上限（≤${WECHAT_STICKER.titleMax}，微信硬上限）。` },
          textMax: { type: 'integer', minimum: 0, maximum: 5000, description: '说明字数上限；0 = 说明必须留空。' },
          coverFirst: { type: 'boolean', description: 'true = 把工作台登记的 cover 当第一张（封面）。' },
        },
      },
      enabled: { type: 'boolean', description: 'false = 停用该号（推送时直接拒）。' },
      note: { type: 'string', description: '备注，例如出口 IP、号主体。' },
    },
    async execute(args) {
      const { account: key, ...patch } = args
      // appsecret / proxyToken 是密钥：落盘可以，回显只留尾 4 位（publicAccount 负责掩码）。
      const saved = store.writeAccount(key, patch)
      const touched = ['appsecret', 'proxyToken'].filter(field => Object.prototype.hasOwnProperty.call(patch, field))
      // 改完立刻回显**生效值**（含来源层）：贴图的闸门按生效值跑，让人确认「我到底改成了什么」，
      // 而不是让人再调一次 gzh_account_list 去猜合并后的结果。
      const effective = resolveStickerRules({ account: { key, ...saved }, config: cfg() })
      return {
        ok: true,
        account: saved,
        sticker: { summary: effective.summary, values: effective.rules, sources: effective.sources, violations: effective.violations },
        file: store.accountsFile,
        wrote: Object.keys(patch),
        secretFields: touched.length === 0 ? [] : touched.map(field => `${field}（已写入，不再回显；传空串可删除）`),
      }
    },
  })

  register({
    name: 'gzh_account_remove',
    description: '删除一个公众号账号（推送台账保留，它是历史事实）。',
    parameters: { account: { type: 'string', required: true, description: '账号 key。' } },
    async execute(args) {
      const removed = store.deleteAccount(args.account)
      return { ok: true, removed, accountsFile: store.accountsFile }
    },
  })

  /* -------------------------------- 皮肤（使用者可自建） -------------------------------- */

  register({
    name: 'gzh_skin_list',
    description: '列出可用排版皮肤：内置四套（teal｜sage｜redwhite｜graphite，只读）与用户在 skins.json 里自建的，附每套的 7 个颜色字段与默认值。新建皮肤前先调它。',
    parameters: {},
    async execute() {
      const custom = store.readSkins()
      return {
        ok: true,
        defaultLayout: cfg().defaultLayout,
        skinsFile: store.skinsFile,
        fields: Object.entries(SKIN_FIELDS).map(([key, value]) => ({ key, default: value, desc: SKIN_FIELD_DESC[key] ?? '' })),
        skins: listSkins(custom).map(row => ({ ...row, colors: { ...row.colors } })),
        hint: Object.keys(custom).length === 0
          ? '还没有自定义皮肤：gzh_skin_set 传 skin=<key> 和任意几个颜色字段即可新建（不填的字段用默认值）'
          : '改自定义皮肤同样用 gzh_skin_set（合并式）；内置四套改不了，想微调就复制一份 key',
      }
    },
  })

  register({
    name: 'gzh_skin_set',
    description: '新建或修改一套自定义排版皮肤（合并式，只改传入字段）。key 不能和内置四套同名。颜色字段：accent（主色：编号方块/下划线/竖条/加粗）、cardBg、cardBorder、underline、quoteBg、quoteText、heading；不填的走默认值。',
    parameters: {
      skin: { type: 'string', required: true, description: '皮肤 key，小写字母数字与 -/_，2-32 位，例如 my-dark。账号的 layout 就填它。' },
      label: { type: 'string', description: '皮肤显示名，例如 深夜蓝。传空串 = 不显示名字只显示 key。' },
      accent: { type: 'string', description: '主色（十六进制，如 #1F6FEB）。' },
      cardBg: { type: 'string', description: '「本文看点」卡片底色。' },
      cardBorder: { type: 'string', description: '看点卡片边框色。' },
      underline: { type: 'string', description: '==重点== 的下划线色。' },
      quoteBg: { type: 'string', description: '金句卡底色。' },
      quoteText: { type: 'string', description: '金句字色。' },
      heading: { type: 'string', description: '节标题与看点标题字色。' },
    },
    async execute(args) {
      const { skin: key, ...patch } = args
      const saved = store.writeSkin(key, patch)
      return { ok: true, skin: saved, skinsFile: store.skinsFile, wrote: Object.keys(patch) }
    },
  })

  register({
    name: 'gzh_skin_remove',
    description: '删除一套自定义排版皮肤（内置四套删不掉）。删之前先看有哪些账号的 layout 指着它——那些账号会退回全局 defaultLayout。',
    parameters: {
      skin: { type: 'string', required: true, description: '皮肤 key。' },
    },
    async execute(args) {
      const key = String(args.skin ?? '').trim()
      const result = store.deleteSkin(key)
      // 删掉还在被引用的皮肤不算错，但必须说清哪些号会退回默认皮肤
      const using = Object.entries(store.readAccounts())
        .filter(([, account]) => String(account?.layout ?? '') === key)
        .map(([accountKey]) => accountKey)
      return { ok: true, ...result, accountsUsingIt: using }
    },
  })

  /* -------------------------------- 全局参数（只读） -------------------------------- */

  register({
    name: 'gzh_config_get',
    description: '读插件全局参数（enabled/defaultAccount/defaultLayout/mediaDeskDir/dataDir/autoDigest/allowDirectApi/maxImageMb/imageMaxEdge/pythonPath/timeoutMs，以及贴图形式规范的全局默认 stickerMinImages/stickerMaxImages/stickerTitleMax/stickerTextMax）、各数据文件位置、以及压图引擎是否可用。这些参数不在这里改——它们在宿主「插件详情页 → 配置」里；本工具只读，给面板和排障用。',
    parameters: {},
    async execute() {
      const config = cfg()
      const picked = {}
      for (const key of Object.keys(CONFIG_HINTS)) picked[key] = config[key] ?? null
      return {
        ok: true,
        config: picked,
        hints: CONFIG_HINTS,
        files: {
          accountsFile: store.accountsFile, skinsFile: store.skinsFile,
          rendersFile: store.rendersFile, ledgerFile: store.ledgerFile, outDir: store.outDir,
        },
        engine: compressorStatus(config),
        editableAt: 'DSH 设置 → 插件 → 公众号草稿推送 → 配置',
        hint: '账号与皮肤在这里改（gzh_account_set / gzh_skin_set）；全局参数只能在宿主插件详情页改，改完自动生效。',
      }
    },
  })

  register({
    name: 'gzh_media_desk',
    description: '读「自媒体工作台」的产出。action=list 列出已有正文的条目（id/标题/配图数/是否已导出）；action=read 按 id 取正文 Markdown 与素材清单（本地素材解析成绝对路径 + 大小，方便判断能不能直接上传）。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | read' },
      id: { type: 'string', description: 'action=read 时的条目 id（可给前缀，但必须唯一）。' },
    },
    async execute(args) {
      const action = String(args.action ?? '')
      if (action === 'list') {
        const listed = desk.list()
        return {
          ok: true, ...listed,
          hint: listed.missing
            ? `没找到 ${listed.stateFile}；先在工作台里产出文章，或用 gzh_render 的 markdown 参数直接传正文`
            : (listed.items.length === 0 ? '工作台里还没有可直接推送的正文（production.article 需要非空）' : '用 action=read + id 取正文'),
        }
      }
      if (action === 'read') {
        const item = desk.read(args.id)
        // 完整 .md 正文不进工具输出（一份稿子几百 KB，白烧 token）：只报路径与长度，
        // 真要那份就用 gzh_render 的 markdownFrom="saved"。
        const { savedMarkdown, ...rest } = item
        return {
          ok: true, ...rest,
          markdownPreview: item.markdown.slice(0, 400),
          hint: savedMarkdown === ''
            ? '这个条目没有导出的 .md，gzh_render 会用 state.json 里的正文'
            : '工作台目录里还有一份导出的 .md：两边可能不一样。默认推 state.json 这份；要推导出那份就 gzh_render 传 markdownFrom="saved"。',
        }
      }
      throw fail(`action「${args.action}」不认识`, '只能是 list 或 read')
    },
  })

  register({
    name: 'gzh_layout_preview',
    description: '把排版皮肤渲染成 HTML 落到本地（不联网、不上传、不推送），用来给人审阅。默认用一篇内置中性样稿（覆盖看点卡/节标题/正文/配图/金句/落款每一种结构）；传 markdown 就用你自己的稿子看结构。返回文件路径、结构统计与告警。',
    parameters: {
      layout: { type: 'string', description: '皮肤 key（gzh_skin_list 可查）。默认取 account 的皮肤，再退到全局 defaultLayout。' },
      account: { type: 'string', description: '按某个账号的排版配置渲染（用它验证 tail/foot/配色）。' },
      markdown: { type: 'string', description: '可选：用自己的 Markdown 当样稿（只看排版结构，配图会被丢弃）。' },
    },
    async execute(args) {
      let account = null
      if (args.account !== undefined && args.account !== '') account = resolveAccount(args.account)
      const requested = String(args.layout ?? '') || String(account?.layout ?? '') || cfg().defaultLayout
      const { skin, name, unknown, invalid } = resolveSkin(
        account !== null ? { layout: requested, skin: account.skin } : requested,
        { custom: store.readSkins() },
      )
      const own = String(args.markdown ?? '').trim() !== ''
      const parsed = parseArticle(own ? String(args.markdown) : SAMPLE_MARKDOWN)
      const built = buildHtml(parsed, {
        skin,
        imageUrls: { 'https://mmbiz.qpic.cn/sample/0?from=appmsg': 'https://mmbiz.qpic.cn/sample/0?from=appmsg' },
        foot: account?.foot,
        tail: account?.tail,
        eyebrows: account?.eyebrows ?? (requested === 'none' ? false : undefined),
      })
      const file = join(store.outDir, `preview-${slugify(`${name}-${own ? 'custom' : 'sample'}`)}.html`)
      store.atomicWrite(file, wrapPreviewDocument(built.html, `排版预览 · ${skin.label}`))
      const warnings = [...built.warnings]
      if (name !== String(args.layout ?? '') && String(args.layout ?? '') !== '') {
        warnings.push(`皮肤「${args.layout}」不存在，已退回「${name}」；gzh_skin_list 看有哪些皮肤`)
      }
      return {
        ok: true, layout: name, skin: skin.label, requested: String(args.layout ?? '') || null,
        file, stats: built.stats, warnings, unknownSkinKeys: unknown, invalidSkinKeys: invalid,
        note: '预览多包了一层 HTML 外壳方便浏览器打开；真正推微信的只有里面那段 <section>，所以这个文件推不出去（这是有意的）。',
      }
    },
  })

  register({
    name: 'gzh_render',
    description: '把一篇文章按指定账号的排版渲染成公众号 HTML 并落到本地（这一步的产物就是最终要推的东西，先在面板中间审阅），可选把配图上传到微信图床（正文里的图必须是 mmbiz 图床，所以这一步通常是必须的）。文章来源三选一：itemId（自媒体工作台）、markdown（直接给 Markdown）、markdownPath（给 .md 文件路径）。不推送草稿箱——那步是 gzh_push_draft。',
    parameters: {
      account: { type: 'string', required: true, description: '用哪个号（决定配色/落款/资料领取/默认作者摘要）。' },
      itemId: { type: 'string', description: '自媒体工作台条目 id。' },
      markdown: { type: 'string', description: '直接给 Markdown 正文。' },
      markdownPath: { type: 'string', description: 'Markdown 文件的本地路径。' },
      markdownFrom: { type: 'string', description: 'itemId 来源时取哪份正文：state（默认，state.json 的 production.article）｜saved（工作台目录里导出的 .md）。两份长度差很多时会告警，避免推错版本。' },
      layout: { type: 'string', description: '临时换皮肤看效果（皮肤 key，gzh_skin_list 可查）；留空用账号自己的 layout。' },
      title: { type: 'string', description: '标题；不传则取 Markdown 的第一个 # 或工作台标题。' },
      digest: { type: 'string', description: '摘要（≤120 字，超长截到 120）：由模型或人**读完正文写**的那一句，比自动摘的第一段更像摘要。传了就用它并记进渲染台账，面板点「推送到草稿箱」会直接带上，不用再传一次；不传则退到账号默认摘要，再退到 autoDigest 摘正文第一段。' },
      upload: { type: 'boolean', description: '是否上传配图，默认 true。false = 只渲染（非微信图床的图会被丢弃并告警）。' },
      cover: { type: 'string', description: '封面：留空 = 自动（用工作台登记的 cover，没登记就从配图里挑一张，并在 coverNote 里说清凭什么挑它）；mediaDesk = 强制用工作台封面；也可以直接给本地图片路径。' },
      autoPlace: { type: 'boolean', description: '自动配图，默认 true：条目登记了但正文没引用的图按节插进去；正文末尾甩成一串的挪回各节后面。false = 完全按原稿顺序，一个字不动。你自己写的 ![]() 位置永远不动。' },
    },
    async execute(args) {
      const account = resolveAccount(args.account)
      const custom = store.readSkins()
      const wantedLayout = String(args.layout ?? '') || String(account.layout ?? '') || cfg().defaultLayout
      const { skin, name: layoutName, unknown, invalid } = resolveSkin({ layout: wantedLayout, skin: account.skin }, { custom })

      let markdown = ''
      const explicitTitle = String(args.title ?? '').trim()
      /** 来源标题：工作台条目标题 / 文件名 / 账号名。只在正文里没有 `#` 一级标题时才用它当标题。 */
      let titleFallback = ''
      let titleFallbackFrom = ''
      let cover = null
      let markdownSource = { from: '', path: '', bytes: 0 }
      /** 正文里 `![](相对路径)` 的基准目录 —— Markdown 的相对路径本来就以稿子自己所在目录为准。 */
      let imageBaseDir = ''
      /** 工作台条目登记的配图清单，用来发现「有条目有图、正文没引用」这种静默丢失。 */
      let deskImages = []
      const sourceWarnings = []
      const sources = ['itemId', 'markdown', 'markdownPath'].filter(key => String(args[key] ?? '') !== '')
      if (sources.length !== 1) {
        throw fail('文章来源必须三选一：itemId / markdown / markdownPath', `传了 ${sources.length} 个`)
      }
      if (args.itemId !== undefined && String(args.itemId) !== '') {
        const item = desk.read(args.itemId)
        const fromSaved = String(args.markdownFrom ?? '') === 'saved'
        if (fromSaved && item.savedMarkdown === '') {
          throw fail(`条目「${item.id}」的 savedPath 里没找到导出的 .md`, '去掉 markdownFrom 用 state.json 里的正文，或先在工作台点导出')
        }
        markdown = fromSaved ? item.savedMarkdown : item.markdown
        markdownSource = {
          from: fromSaved ? 'saved' : 'state',
          path: fromSaved ? item.savedMarkdownPath : desk.stateFile,
          bytes: Buffer.byteLength(markdown, 'utf8'),
        }
        // 相对路径的配图按稿子所在目录解析：saved 就是那份 .md 的目录；
        // state.json 那份正文没有自己的目录，退到条目导出的目录（图就存在那儿）。
        const savedDir = String(item.savedMarkdownPath ?? '') === '' ? '' : dirname(String(item.savedMarkdownPath))
        const exportDir = existsSync(String(item.savedPath ?? '')) && statSync(String(item.savedPath ?? '')).isDirectory() ? String(item.savedPath) : ''
        imageBaseDir = fromSaved ? dirname(markdownSource.path) : (exportDir !== '' ? exportDir : savedDir)
        deskImages = Array.isArray(item.images) ? item.images : []
        // 两份差得多就必须说清楚：推出去的是哪一版，出错时全靠这句话定位。
        if (item.savedMarkdown !== '' && Math.abs(item.savedMarkdownBytes - item.markdownBytes) > Math.max(200, item.markdownBytes * 0.1)) {
          sourceWarnings.push(`state.json 里是 ${item.markdownBytes}B，导出的 .md 是 ${item.savedMarkdownBytes}B，两份不一样：这次用的是 ${markdownSource.from}（${markdownSource.path}）。要另一份就改 markdownFrom 重新渲染。`)
        }
        if (explicitTitle === '') { titleFallback = item.title; titleFallbackFrom = '工作台条目标题' }
        cover = item.cover
      } else if (args.markdownPath !== undefined && String(args.markdownPath) !== '') {
        if (!existsSync(args.markdownPath)) throw fail(`读不到 Markdown 文件：${args.markdownPath}`)
        markdown = readFileSync(args.markdownPath, 'utf8')
        markdownSource = { from: 'markdownPath', path: args.markdownPath, bytes: Buffer.byteLength(markdown, 'utf8') }
        imageBaseDir = dirname(args.markdownPath)
        if (explicitTitle === '') { titleFallback = basename(args.markdownPath, extname(args.markdownPath)); titleFallbackFrom = '文件名' }
      } else {
        markdown = String(args.markdown)
        markdownSource = { from: 'markdown', path: '', bytes: Buffer.byteLength(markdown, 'utf8') }
      }
      if (markdown.trim() === '') throw fail('正文是空的')

      // ── 配图规划：定下哪张当封面、剩下的插图插在哪一节后面 ───────────────
      // 必须在 parseArticle 之前：插出来的 `![]()` 要走正常的上传 + 渲染链路，
      // 不能另开一套「事后往 HTML 里塞 img」的旁路（那样图床、图注、统计全都对不上）。
      const autoPlace = args.autoPlace !== false
      const digestCache = new Map()
      /** 同一张图在工作台里有两处寻址（稿子里写 `配图1.png`、台账登记 `files/g_xxx.png`），按内容认。 */
      const keyOf = path => {
        if (digestCache.has(path)) return digestCache.get(path)
        let key = ''
        try {
          const buffer = readFileSync(path)
          key = `${buffer.byteLength}:${createHash('sha256').update(buffer).digest('hex')}`
        } catch { /* 读不到就按「没引用」算，宁可多说一句 */ }
        digestCache.set(path, key)
        return key
      }
      const resolveLocal = src => {
        const target = desk.resolveAsset(src, imageBaseDir).localPath
        return target !== '' && existsSync(target) ? target : ''
      }
      let plan = { markdown, cover: null, placed: [], kept: 0, relocated: 0, skipped: [], notes: [] }
      const localBySrc = new Map()
      if (deskImages.length > 0 || cover !== null) {
        const enrich = entry => {
          const src = String(entry?.src ?? '')
          const recorded = String(entry?.localPath ?? '')
          const local = recorded !== '' && existsSync(recorded) ? recorded : resolveLocal(src)
          if (src !== '') localBySrc.set(src, local)
          return { ...entry, src, localPath: local, bytes: local === '' ? 0 : statSync(local).size }
        }
        plan = planImages({
          markdown,
          images: deskImages.map(enrich),
          cover: cover === null ? null : enrich(cover),
          autoPlace,
          resolveLocal,
          digestOf: keyOf,
        })
        if (plan.markdown !== markdown) markdown = plan.markdown
      }

      const parsed = parseArticle(markdown, { title: explicitTitle })
      // 标题优先级：显式 title → 正文里的 `#` → 来源标题（条目标题 / 文件名 / 账号名）。
      // 以前来源标题在解析之前就顶上了正文里的 `#`，而解析器认「标题已知」后会把每个 `#` 行丢掉——
      // 用户写在稿子里的标题就这样从正文里悄悄消失，两头都没了。
      if (parsed.title === '') {
        if (titleFallback === '') throw fail('没有标题：正文里没有 # 一级标题，也没传 title')
        parsed.title = titleFallback
        sourceWarnings.push(`标题取自${titleFallbackFrom}「${titleFallback}」（正文里没有 \`#\` 一级标题）。要用它自己的标题：正文开头写一行 \`# 标题\`，或调本工具时传 title。`)
      }

      // 插了图必须说清插在哪：位置是机器定的，人要能一眼看出它把哪张放到了哪一节，
      // 不满意就直接在稿子里写 `![]()`——用户写的位置我们一个字都不动。
      if (plan.placed.length > 0) {
        sourceWarnings.push(`自动插了 ${plan.placed.length} 张配图：${plan.placed.map(item => `${item.file} →「${item.section}」`).join('；')}。`
          + '位置不满意就在稿子里对应位置自己写一行 `![](src)`，你写的位置我们不动。')
      }
      plan.notes.forEach(note => sourceWarnings.push(note))
      // 规划完还剩没用上的图，逐个点名带原因 —— 「静默 0 张」就是从这里翻车的。
      const lost = plan.skipped.filter(item => item.reason.indexOf('当封面') < 0)
      if (lost.length > 0) {
        const base = markdownSource.from === 'state' ? '条目导出目录' : '正文所在目录'
        const names = lost.map(item => `${item.src}（${item.reason}）`).join('、')
        const tail = `要它们进正文：在稿子对应位置写一行 \`![](${lost[0].src})\`（相对路径按${base}解析），或直接写绝对路径。`
        sourceWarnings.push(plan.placed.length > 0
          ? `另外 ${lost.length} 张图没能进正文：${names}。${tail}`
          : `工作台这条登记了 ${deskImages.length} 张配图，正文里只引用了 ${deskImages.length - lost.length} 张，没引用的这 ${lost.length} 张这次不会出现：${names}。${tail}`)
      }

      // 配图：先收集再上传，同一 src 只传一次
      const upload = args.upload !== false
      const client = createClient({
        baseUrl: account.proxyUrl, token: account.proxyToken,
        appid: account.appid, secret: account.appsecret ?? '', timeoutMs: cfg().timeoutMs,
      })
      const maxBytes = numArg(cfg().maxImageMb, 1, 0.1, 10) * 1048576
      const imageUrls = {}
      const imageReport = []
      const cache = new Map()
      for (const image of parsed.images) {
        if (Object.prototype.hasOwnProperty.call(imageUrls, image.src)) continue
        const asset = desk.resolveAsset(image.src, imageBaseDir)
        let outcome = cache.get(image.src)
        if (outcome === undefined) {
          try {
            outcome = await uploadOne(client, asset, {
              maxBytes, upload, config: cfg(),
              maxEdge: numArg(cfg().imageMaxEdge, 1440, 320, 4096),
              outDir: join(store.outDir, 'images'),
              timeoutMs: numArg(cfg().compressTimeoutMs, 120_000, 10_000, 600_000),
            })
          } catch (cause) {
            outcome = { error: cause.message + (cause.hint === undefined ? '' : `｜${cause.hint}`) }
          }
          cache.set(image.src, outcome)
        }
        if (outcome.url !== undefined) imageUrls[image.src] = outcome.url
        imageReport.push({ src: image.src, url: outcome.url ?? '', bytes: asset.localPath !== '' && existsSync(asset.localPath) ? statSync(asset.localPath).size : 0, note: outcome.note ?? '', error: outcome.error ?? '' })
      }

      // 封面：显式 cover 参数 > 这次规划出来的封面（工作台登记的，没登记就从配图里挑一张）> 账号默认。
      // 以前只有手工传 cover 才会去传素材，工作台明明生成好封面也照样推成一张白封面。
      let thumbMediaId = String(account.thumbMediaId ?? '')
      const coverNote = []
      const coverSource = String(args.cover ?? '')
      const plannedLocal = plan.cover === null ? '' : (localBySrc.get(plan.cover.src) ?? resolveLocal(plan.cover.src))
      const plannedCover = plan.cover === null || plannedLocal === '' ? null : { src: plan.cover.src, localPath: plannedLocal, reason: plan.cover.reason }
      const coverTarget = coverSource === ''
        ? (plannedCover === null ? '' : { kind: 'planned', localPath: plannedCover.localPath, src: plannedCover.src })
        : (coverSource === 'mediaDesk' ? (cover ?? {}) : { kind: 'local', localPath: coverSource, src: coverSource })
      const coverHasFile = coverTarget !== '' && coverTarget !== null && String(coverTarget.localPath ?? coverTarget.src ?? '') !== ''
      if (plannedCover !== null && coverSource === '') coverNote.push(plannedCover.reason)
      if (upload === false && coverHasFile) {
        coverNote.push('upload=false：这次没有上传封面素材（用的账号默认 thumbMediaId）')
      } else if (coverHasFile) {
        const local = coverTarget.localPath
        if (local === undefined || local === '' || !existsSync(local)) {
          coverNote.push(`封面不可用：${local || coverTarget.src || '工作台没有封面'}`)
        } else {
          // 封面走「永久素材」接口：超过 1MB、或者 webp/bmp 这种它不收的格式，微信直接拒。
          // 所以先过一遍压缩引擎（输出统一 jpg，顺带拿到宽高好提示裁切比例），压不动再退回原图。
          const compressed = await compressImage(local, {
            maxBytes: 1_048_576,
            maxEdge: numArg(cfg().imageMaxEdge, 1440, 320, 4096),
            outDir: join(store.outDir, 'images'),
            config: cfg(),
            timeoutMs: numArg(cfg().compressTimeoutMs, 120_000, 10_000, 600_000),
          })
          let uploadPath = local
          if (compressed.ok) {
            uploadPath = compressed.path
            if (compressed.srcFormat !== '' && compressed.srcFormat.toLowerCase() !== 'jpg') {
              coverNote.push(`封面从 ${compressed.srcFormat} 转成 jpg（素材接口不收 ${compressed.srcFormat}）`)
            }
            const ratio = compressed.width > 0 && compressed.height > 0 ? compressed.width / compressed.height : 0
            if (ratio > 0 && (ratio < 1.6 || ratio > 3.4)) {
              coverNote.push(`封面 ${compressed.width}×${compressed.height}（${ratio.toFixed(2)}:1），微信列表位按 2.35:1 居中裁切，上下会被切掉`)
            }
          } else {
            coverNote.push(`封面没压缩（${compressed.error}），按原图上传`)
          }
          const bytes = statSync(uploadPath).size
          try {
            thumbMediaId = await client.addImageMaterial(readFileSync(uploadPath), basename(uploadPath))
            coverNote.push(`封面 ${(bytes / 1048576).toFixed(2)}MB 已上传，media_id=${thumbMediaId}`)
          } catch (cause) {
            coverNote.push(`封面上传失败：${cause.message}${cause.hint === undefined ? '' : `｜${cause.hint}`}`)
          }
        }
      } else if (thumbMediaId !== '') {
        coverNote.push('使用账号默认封面 thumbMediaId')
      } else {
        coverNote.push('没有可用封面：这条没登记 cover、配图里也没一张能用、账号也没配默认封面 —— 推送时会被封面闸门拦住')
      }
      /**
       * 这次究竟拿哪张当封面，落到结果与渲染台账里：推送时靠台账这条把 thumbMediaId 自动带过去，
       * 不让人在渲染和推送之间把封面丢了。
       */
      const coverDecision = {
        src: coverHasFile ? String(coverTarget.src ?? coverTarget.localPath ?? '') : '',
        from: coverHasFile ? (coverSource === '' ? 'auto' : 'arg') : (thumbMediaId === '' ? 'none' : 'account'),
        reason: coverHasFile ? (plannedCover === null ? `用了你传的 cover（${coverSource}）` : plannedCover.reason) : (thumbMediaId === '' ? '没有任何可用封面' : '账号默认封面 thumbMediaId'),
        thumbMediaId,
      }

      /**
       * 摘要和封面一样，在渲染这一步就定下来：这次传了 digest（模型/人读完正文写的那一句）就用它，
       * 其次账号配了默认摘要用它，否则摘正文第一段。
       * 定下来的值进渲染台账（下面 appendRender），推送时靠台账把它带过去——
       * 面板的推送按钮故意不传 digest（传空串反而会顶掉默认值），凡是没配默认摘要的号
       * 都会在推送侧撞「缺少 digest」，而人在中间看到的是已经排好的稿子，根本无从下手。
       */
      const givenDigest = clampText(String(args.digest ?? '').trim(), 120)
      const accountDigest = String(account.digest ?? '').trim()
      const digest = givenDigest !== '' ? givenDigest
        : accountDigest !== '' ? accountDigest
          : (cfg().autoDigest === true ? autoDigest(markdown, parsed.title) : '')
      const digestFrom = digest === '' ? ''
        : givenDigest !== '' ? '读完正文写的摘要'
          : accountDigest !== '' ? '账号默认摘要' : '自动摘正文第一段'
      const built = buildHtml(parsed, {
        skin,
        imageUrls,
        foot: account.foot,
        tail: account.tail,
        eyebrows: account.eyebrows ?? undefined,
      })

      const html = built.html
      const file = join(store.outDir, `${slugify(parsed.title)}-${createHash('sha256').update(markdown + account.key, 'utf8').digest('hex').slice(0, 8)}.html`)
      store.atomicWrite(file, html)
      // 顺带写一份带 HTML 外壳的预览文件：面板 iframe srcDoc 用它，浏览器双击也能看。
      // 它推不出去（push 只收内层 <section>），所以「看的东西」和「推的东西」不可能被搞混。
      const previewFile = join(store.outDir, `${slugify(parsed.title)}-preview.html`)
      store.atomicWrite(previewFile, wrapPreviewDocument(html, `${parsed.title} · ${skin.label}`))

      const warnings = [...sourceWarnings, ...built.warnings]
      if (wantedLayout !== layoutName) {
        warnings.push(`皮肤「${wantedLayout}」不存在，这次用的是「${layoutName}」；gzh_skin_list 看可用皮肤`)
      }
      if (digest === '') warnings.push('没有摘要：点「推送到草稿箱」会被 fail-close 拦住（重新 gzh_render 时传 digest，或插件配置里打开 autoDigest，或 gzh_account_set 给这个号配默认摘要）')
      if (givenDigest !== '' && Array.from(String(args.digest ?? '').trim()).length > 120) {
        warnings.push(`传的摘要超过微信上限 120 字，已经截到 ${Array.from(digest).length} 字：摘要在列表里就一行，自己收一下尾巴更好。`)
      }
      if (String(account.author ?? '') === '') warnings.push('账号没有默认作者：push 时必须显式带 author')
      const engine = compressorStatus(cfg())
      if (!engine.ready && imageReport.some(item => item.error.indexOf('压缩') >= 0)) {
        warnings.push(`有配图超 1MB 但压不了：${engine.error}。要么在设置里填 pythonPath，要么在工作台把生图尺寸调小。`)
      }
      if (coverDecision.from === 'none') {
        warnings.push('这篇没有可用封面：gzh_push_draft 会拦住（草稿箱里是白封面，列表很难看）。补法：渲染时传 cover=<图片路径> 或 cover=mediaDesk，或 gzh_account_set 给账号配 thumbMediaId。')
      }
      if (built.stats.images === 0 && imageReport.length === 0 && upload === false) {
        warnings.push('这次是「只渲染」：没有上传任何配图，正文里也不会有图。要带图就点「渲染并上传配图」（upload=true）。')
      }

      // 渲染台账：push 靠它证明「推的这份确实是排版渲染出来的」，而不是手贴的 HTML。
      // 顺手记下这次排出来的封面与正文图数 —— 推送时的「必须有封面、必须有插图」两道闸就读这两个字段。
      const sha = createHash('sha256').update(html, 'utf8').digest('hex')
      const renderId = sha.slice(0, 12)
      const saved = store.appendRender({
        renderId, sha, account: account.key, title: parsed.title, file, previewFile,
        layout: layoutName, layoutLabel: skin.label, bytes: Buffer.byteLength(html, 'utf8'),
        markdownFrom: markdownSource.from, markdownPath: markdownSource.path,
        digest, digestFrom,
        images: imageReport.length, warnings: warnings.length,
        bodyImages: built.stats.images, placed: plan.placed.length,
        thumbMediaId: coverDecision.thumbMediaId, coverFrom: coverDecision.from, coverSrc: coverDecision.src,
      })
      if (saved === null) warnings.push('渲染台账写不进去（renders.json 可能被手工改坏），推送时无法校验来源')

      return {
        ok: true,
        renderId,
        file,
        previewFile,
        account: account.key,
        title: parsed.title,
        author: String(args.author ?? account.author ?? ''),
        digest, digestFrom,
        thumbMediaId,
        layout: layoutName,
        skin: skin.label,
        markdownSource,
        endpoint: client.endpoint,
        stats: built.stats,
        images: imageReport,
        placement: { autoPlace, placed: plan.placed, relocated: plan.relocated, skipped: plan.skipped },
        cover: coverDecision,
        imageEngine: engine,
        coverNote,
        warnings: [
          ...warnings,
          ...unknown.map(key => `皮肤覆盖字段不认识：${key}`),
          ...invalid.map(key => `皮肤字段「${key}」不是 #RRGGBB，这次没采用（gzh_skin_set 改一下）`),
        ],
        next: '先在面板中间审阅 previewFile（或直接看 file），确认排版没问题再调 gzh_push_draft：account、htmlPath=file、renderId 都用这里的值',
      }
    },
  })

  /**
   * 摘要兜底要找的是「那次渲染真正用的那份正文」，不能照着台账里的 markdownPath 硬读：
   * 工作台来源（itemId + markdownFrom=state）的 markdownPath 记的是 state.json 整份文件，
   * 那里面是 JSON —— 硬读等于把半行 `{"items":[…` 当摘要推到微信列表上，比报错更糟，
   * 因为它在台账里看起来是「推送成功」。所以 state 来源按标题回工作台取
   * production.article，saved / markdownPath 来源才是那份 .md。
   * 认不出正文就返回空串，让 push 报「缺少 digest」去指重新渲染，绝不硬凑一段。
   */
  function digestSource(render, args) {
    const readText = path => { try { return readFileSync(path, 'utf8') } catch { return '' } }
    const markdownAt = path => {
      const p = String(path ?? '').trim()
      return p !== '' && /\.(md|markdown)$/i.test(p) && existsSync(p) ? readText(p) : ''
    }
    const explicit = markdownAt(args?.markdownPath)
    if (explicit !== '') return explicit
    const from = String(render?.markdownFrom ?? '')
    if (from === 'saved' || from === 'markdownPath') return markdownAt(render?.markdownPath)
    if (from === 'state') {
      // 台账没记条目 id，只有标题：按标题回工作台找那一条（命中多条就当找不到，不猜）。
      const want = String(render?.title ?? '').trim()
      if (want === '') return ''
      try {
        const hits = desk.list().items.filter(item => String(item.title ?? '').trim() === want)
        if (hits.length !== 1) return ''
        return String(desk.read(hits[0].id).markdown ?? '')
      } catch { return '' }
    }
    return ''
  }

  register({
    name: 'gzh_push_draft',
    description: '把 gzh_render 产出的 HTML 推到该号的微信草稿箱。只收排版产物（内层 <section> 开头）并且必须对上渲染台账的 renderId——这就是「推出去的草稿没排版」的最后一道闸。推前还会扫正文：非 mmbiz 图床的配图、微信里点不开的站外链接、草稿箱里已有的同标题草稿，都会拦下来（个人订阅号未认证，外链是被屏蔽的）。**封面和正文插图是硬要求**：没有封面（thumb_media_id）、或者渲染时登记了配图但正文里一张都没进去，都会在联网前被拦——白封面、纯文字的草稿推到列表里就是事故。封面一般不用你管：gzh_render 会自动用工作台的 cover（没登记就从配图里挑一张）。**不会重试**；同内容推过就直接拒，绕过任何一道闸都要 force=true 并说明原因。成功返回草稿 media_id，请立即用 gzh_draft_verify 回读。',
    parameters: {
      account: { type: 'string', required: true, description: '推到哪个号。' },
      htmlPath: { type: 'string', required: true, description: 'gzh_render 返回的 file（不是 previewFile，也不是 preview-*.html）。' },
      renderId: { type: 'string', description: 'gzh_render 返回的 renderId。带上它才能证明 htmlPath 就是那次排版的产物，正常流程必须带。' },
      title: { type: 'string', description: '标题（≤64 字，emoji 按 1 字算）；不传则取 HTML 里第一个 h3 前…（建议显式传，用 render 返回的 title）。' },
      author: { type: 'string', description: '作者；不传用账号默认作者，两者都空则拒绝推送。' },
      digest: { type: 'string', description: '摘要（≤120 字，按字算，超长截到 120）；不传就用这次渲染定下的摘要（台账里记着：渲染时读完正文写的那句 > 账号默认摘要 > 摘正文第一段），再退到账号默认与 autoDigest。' },
      markdownPath: { type: 'string', description: '可选：这篇对应的 .md 稿子路径，只在渲染台账里也没有摘要时用来现摘一段（不传就用台账记着的那份正文；工作台来源会回工作台取正文，不会去读 state.json）。' },
      thumbMediaId: { type: 'string', description: '封面素材 id；不传用账号 thumbMediaId。' },
      contentSourceUrl: { type: 'string', description: '「阅读原文」链接。' },
      commentOpen: { type: 'boolean', description: '这篇是否开放评论；不传用账号的 comment.open（默认开放）。' },
      commentFansOnly: { type: 'boolean', description: '这篇是否仅关注者可评论；不传用账号的 comment.fansOnly（默认不限）。' },
      checkDraftBox: { type: 'boolean', description: '推前回读草稿箱最近 20 条查同名草稿，默认 true。离线调试或代理慢可传 false。' },
      force: { type: 'boolean', description: 'true = 明知重复（本地台账 / 草稿箱同名 / 正文有外链）仍推，必须带 reason，会留台账记录。' },
      allowRawHtml: { type: 'boolean', description: 'true = 明知没有渲染台账（手改过 HTML）仍推送，必须带 reason。正常流程用不到。' },
      reason: { type: 'string', description: 'force=true 或 allowRawHtml=true 时必填：为什么要绕过这道闸。' },
    },
    async execute(args) {
      const account = resolveAccount(args.account, { needSecret: true })
      if (!existsSync(args.htmlPath)) throw fail(`读不到 HTML：${args.htmlPath}`, '先跑 gzh_render')
      const content = readFileSync(args.htmlPath, 'utf8')
      const htmlSha = createHash('sha256').update(content, 'utf8').digest('hex')
      // 闸 1 · 形状：排版产物的最外层就是那一个 <section>。带外壳的预览文件推出去，
      // 公众号里就变成一整页没样式的裸内容 —— 以前就是这么翻车的。
      if (!/^<section/.test(content.trim()) && args.allowRawHtml !== true) {
        throw fail('要推的东西不是排版产物（应以内层 <section> 开头）', '用 gzh_render 返回的 file；别用 previewFile / preview-*.html，也不要手贴 HTML')
      }
      // 闸 2 · 来源：必须对得上一次 gzh_render。谁都能塞一段 HTML 进来是根因，
      // 现在得说清它是哪一次渲染出来的，并且内容没被改过、没串号。
      const render = String(args.renderId ?? '') === '' ? null : store.findRender(args.renderId)
      if (render === null && args.allowRawHtml !== true) {
        throw fail('renderId 缺失或找不到，无法证明这份 HTML 出自排版渲染', '把 gzh_render 返回的 renderId 一起传进来；确实要推手改过的 HTML 就带 allowRawHtml=true 和 reason')
      }
      if (render !== null && render.sha !== htmlSha) {
        throw fail(`renderId「${render.renderId}」与 htmlPath 内容对不上（渲染后文件被改过，或路径指错）`, '重新 gzh_render，用新返回的 file + renderId')
      }
      if (render !== null && String(render.account ?? '') !== account.key) {
        throw fail(`这份渲染是给「${render.account}」排的，现在要推到「${account.key}」`, '换号请重新渲染：皮肤、落款、资料领取都不一样')
      }
      if (args.allowRawHtml === true && String(args.reason ?? '').trim() === '') throw fail('allowRawHtml=true 必须带 reason', '写清为什么要绕过渲染台账')

      const title = String(args.title ?? '').trim()
      if (title === '') throw fail('缺少 title', '把 gzh_render 返回的 title 传进来')
      // 64 / 120 都按「字」算：emoji 在 String.length 里是 2，会把合法标题判成超长。
      if (textLength(title) > 64) throw fail(`标题 ${textLength(title)} 字，超过微信 64 字上限`, '改短再渲染')
      const author = String(args.author ?? account.author ?? '').trim()
      if (author === '') throw fail('缺少 author', 'push 传 author，或给账号配 author（产线脚本也是这么 fail-close 的）')
      /**
       * 摘要的优先级和封面那道闸保持一致：push 显式传 > 这次渲染定下的（台账里记着）
       * > 账号默认 > 按 Markdown 现摘一段。
       * 中间那档是补上的关键一环：渲染阶段已经按「账号默认优先、没有就摘正文第一段」把摘要
       * 定下来并记进台账，而面板的推送按钮不传 digest（传空串反而会顶掉默认值）。以前这里
       * 只看到账号默认，于是凡是没配默认摘要的号在面板上必然推不出去，报「缺少 digest」——
       * 可稿子明明已经排在中间给人看过了，谁也想不通缺的是什么。
       * 最后一档覆盖两种情况：升级前存的渲染记录（台账里没有 digest 字段）、以及
       * allowRawHtml 的手工路径，都还能按 Markdown 现摘。
       */
      let digest = String(args.digest ?? '').trim()
      let digestFrom = digest === '' ? '' : 'push 参数'
      if (digest === '') {
        const fromRender = String(render?.digest ?? '').trim()
        if (fromRender !== '') {
          digest = fromRender
          const why = String(render?.digestFrom ?? '').trim()
          digestFrom = `渲染时定下的摘要${why === '' ? '' : `（${why}）`}`
        }
      }
      if (digest === '' && String(account.digest ?? '').trim() !== '') {
        digest = String(account.digest).trim()
        digestFrom = '账号默认摘要'
      }
      if (digest === '' && cfg().autoDigest === true) {
        const source = digestSource(render, args)
        if (source !== '') {
          digest = autoDigest(source, title)
          digestFrom = '按 Markdown 现摘的第一段'
        }
      }
      // autoDigest 开着还走到这里，说明不是没开开关，而是这份渲染认不出它用的是哪份正文
      // （多半是摘要进台账之前存的渲染记录）——提示要照着真实原因说，否则人只会去翻那个本来就开着的开关。
      if (digest === '') throw fail('缺少 digest（摘要）', cfg().autoDigest === true
        ? '这份渲染的台账里没有摘要，插件也认不出它用的是哪份正文（早于摘要兜底的渲染记录就是这样）：重新 gzh_render 一次就定下来并记进台账；也可以 push 传 digest，或 gzh_account_set 给这个号配默认摘要'
        : '重新 gzh_render 就把摘要定下来了（账号默认摘要，没有就摘正文第一段）；也可以 push 传 digest，或 gzh_account_set 给这个号配默认摘要，或在插件配置里打开 autoDigest')
      // 截断同样按码点：按 UTF-16 切会切在 emoji 中间，摘要里就多出一个乱码字符。
      if (textLength(digest) > 120) digest = clampText(digest, 120)

      // 闸 3 · 内容：非图床的图显示不出来，站外链接在未认证订阅号正文里点了没反应。
      const audit = auditWechatSafe(content)
      if (audit.findings.length > 0 && args.force !== true) {
        const list = audit.findings.slice(0, 5).map(item => `${item.kind === 'image' ? '图' : '链接'} ${item.value} —— ${item.why}`)
        throw fail(
          `正文里有 ${audit.findings.length} 处微信会静默处理掉的东西：\n${list.join('\n')}`,
          '配图请用 gzh_render 上传（会换成 mmbiz 图床地址）；链接改成贴图或放「阅读原文」。确认这些链接你的号能点，就带 force=true 和 reason',
        )
      }

      // 闸 4 · 封面：草稿没有 thumb_media_id，公众号列表里就是一块白图。这种草稿推出去
      // 往往要到手机上才发现，所以在联网前就拦下来。
      // 优先级：push 显式传 > 这次渲染定下来的封面（台账里记着）> 账号默认。
      const thumb = String(args.thumbMediaId ?? '') !== '' ? String(args.thumbMediaId)
        : (String(render?.thumbMediaId ?? '') !== '' ? String(render.thumbMediaId) : String(account.thumbMediaId ?? ''))
      const thumbFrom = String(args.thumbMediaId ?? '') !== '' ? 'push 参数'
        : (String(render?.thumbMediaId ?? '') !== '' ? `渲染时定下的封面（${render.coverFrom === 'auto' ? '工作台封面或自动挑的' : '你传的 cover'}）` : '账号默认 thumbMediaId')
      if (thumb === '' && args.force !== true) {
        throw fail('这篇没有封面图，不给推', '重新 gzh_render 就会自动带上（工作台登记的 cover，没登记就从配图里挑一张）；也可以 push 传 thumbMediaId，或 gzh_account_set 配个账号默认封面。确实要推无封面版，带 force=true 和 reason')
      }
      // 闸 5 · 正文插图：渲染时明明登记了配图，正文里却一张都没进去，十有八九是走了
      // 「只渲染（不上传图床）」——推出去就是一篇纯文字草稿，这个坑我们真踩过。
      const bodyImages = Number(render?.bodyImages ?? -1)
      if (render !== null && bodyImages === 0 && Number(render.images ?? 0) > 0 && args.force !== true) {
        throw fail(`这次渲染登记了 ${render.images} 张配图，正文里却一张都没有（多半是 upload=false 只渲染，图没上传图床）`, '重新 gzh_render 上传配图（面板点「渲染并上传配图」）；就是要推无图版，带 force=true 和 reason')
      }

      const identity = { account: account.key, title, content }
      const fp = store.fingerprint(identity)
      const prior = store.readLedger().find(entry => entry.fingerprint === fp)
      if (prior !== undefined && args.force !== true) {
        throw fail(`这篇已经推过一次（${prior.at}，草稿 media_id=${prior.mediaId}）`, '重复草稿是线上事故。确认要再推一份，就带 force=true 和 reason')
      }
      if (args.force === true && String(args.reason ?? '').trim() === '') throw fail('force=true 必须带 reason', '写清为什么重复推')

      const client = createClient({
        baseUrl: account.proxyUrl, token: account.proxyToken,
        appid: account.appid, secret: account.appsecret, timeoutMs: cfg().timeoutMs,
      })

      // 闸 6 · 草稿箱：台账只记得「这个插件推过什么」，日更产线（Dify）推的它看不见。
      // 回读最近 20 条，同标题就拦——多一条重复草稿是给人收拾残局的。探测本身失败不拦推送。
      let mediaId = ''
      let draftBox = { checked: false, hits: [], error: '' }
      if (args.checkDraftBox !== false) {
        try {
          const norm = value => String(value ?? '').replace(/\s+/g, '')
          const drafts = await client.listDrafts(0, 20)
          draftBox = {
            checked: true,
            hits: drafts.filter(entry => norm(entry.title) === norm(title)).map(entry => ({ mediaId: entry.mediaId, title: entry.title, updatedAt: entry.updatedAt ?? null })),
            error: '',
          }
        } catch (cause) {
          draftBox = { checked: false, hits: [], error: cause.message }
        }
        if (draftBox.checked && draftBox.hits.length > 0 && args.force !== true) {
          throw fail(
            `草稿箱里已经有 ${draftBox.hits.length} 条同名草稿：${draftBox.hits.map(hit => `${hit.mediaId}（${hit.title}）`).join('、')}`,
            '本插件的台账只记得自己推过的，产线/后台推的看不见。要么先去后台删掉旧草稿，要么确认要再建一条就带 force=true 和 reason',
          )
        }
      }

      try {
        mediaId = await client.addDraft({
          title, author, digest, content,
          thumbMediaId: thumb === '' ? undefined : thumb,
          contentSourceUrl: String(args.contentSourceUrl ?? account.contentSourceUrl ?? ''),
          comment: commentSetting(account, args),
        })
      } catch (cause) {
        // 失败也要留痕：能区分「明确被微信拒绝」和「请求发出去但没拿到 media_id」
        store.appendLedger({ fingerprint: fp, account: account.key, title, htmlPath: args.htmlPath, renderId: render?.renderId ?? '', rawHtml: args.allowRawHtml === true, mediaId: null, error: cause.message, hint: cause.hint ?? '', endpoint: client.endpoint, bytes: Buffer.byteLength(content, 'utf8'), audit: audit.findings, draftBox: draftBox.hits, thumbMediaId: thumb, bodyImages, digest, digestFrom })
        throw fail(cause.message, (cause.hint ?? '') + ' 先别重推：用 gzh_draft_verify 看草稿箱里到底有没有建出来。')
      }
      store.appendLedger({ fingerprint: fp, account: account.key, title, htmlPath: args.htmlPath, renderId: render?.renderId ?? '', rawHtml: args.allowRawHtml === true, mediaId, endpoint: client.endpoint, bytes: Buffer.byteLength(content, 'utf8'), forced: args.force === true, reason: args.reason ?? '', audit: audit.findings, draftBox: draftBox.hits, comment: commentSetting(account, args), thumbMediaId: thumb, coverFrom: thumbFrom, bodyImages, digest, digestFrom })
      return {
        ok: true,
        mediaId,
        account: account.key,
        title,
        digest, digestFrom,
        renderId: render?.renderId ?? null,
        endpoint: client.endpoint,
        stats: { bytes: Buffer.byteLength(content, 'utf8'), bodyImages },
        cover: { thumbMediaId: thumb, from: thumbFrom },
        skippedChecks: {
          contentAudit: audit.findings.length === 0 ? null : `绕过 ${audit.findings.length} 处（force）`,
          draftBox: draftBox.checked ? `${draftBox.hits.length} 条同名草稿（推前已确认）` : `没查成：${draftBox.error || '已关闭'}`,
          cover: thumb === '' ? '没有封面（force 绕过的，记得回后台补一张）' : null,
          bodyImages: bodyImages === 0 && Number(render?.images ?? 0) > 0 ? '这次登记了配图但正文没有图（force 绕过的）' : null,
        },
        next: '用 gzh_draft_verify 回读确认（会比对标题）',
      }
    },
  })

  register({
    name: 'gzh_push_sticker',
    description: `把一组图推成**贴图**（图片消息，article_type=newspic）草稿。这是与 gzh_push_draft 平行的一条链路，不是它的一个开关：贴图**没有排版**（官方只支持纯文本，皮肤/落款/资料领取/看点卡一概用不上），也**没有独立封面**——\`image_list\` 第一张就是封面，微信建成后会自己回填 thumb_media_id。图默认取自**自媒体工作台条目**的配图（它登记的 cover 排第一张当封面，\`includeCover=false\` 关掉），也可以直接传 images 给一组本地图片路径。**每张图都要上传成永久图片素材**（占素材库一格，插件按「号+图片内容」缓存，同一张图同一个号只传一次；名额体检见 gzh_material_audit）。
**形式规范是可配置的**，默认 ${DEFAULT_RULE_PROSE}；生效优先级：本次调用参数（minImages/maxImages/titleMax/textMax）> 账号 \`sticker\` 块（gzh_account_set，长期口径）> 宿主插件配置 stickerXxx（全局）> 内置默认。返回值里的 \`rules\` 会写清每个数**从哪一层来**——被拦时先读它再决定改哪。改配置的理由应当是「这个号的形式本来就不是 6 张」，而不是「这条稿子凑不够图」：后者是稿子没做完。
**微信硬上限不可配、force 也绕不过**：标题 ${WECHAT_STICKER.titleMax} 字（图文才是 64）、一次 ${WECHAT_STICKER.imageMin}~${WECHAT_STICKER.imageMax} 张图、正文只支持纯文本。形式规范可被 force=true + reason 绕过。
说明里**不许出现图片**（图片标记、图片路径、站外链接都拦）。不传 cover_info，裁剪比例交给微信算（自己算坐标会撞 53401）。先用 planOnly=true 看一遍选图、文案、生效规则与「会净增几格素材」，再真推。同标题/同内容会拦，绕过要 force+reason。`,
    parameters: {
      account: { type: 'string', required: true, description: '推到哪个号。' },
      itemId: { type: 'string', description: '自媒体工作台条目 id：贴图就用它的配图（cover 当第一张）。与 images 至少要给一个。' },
      images: { type: 'array', items: { type: 'string' }, description: '直接给一组本地图片路径，顺序就是展示顺序、第一张当封面。给了就完全用它，不再读条目配图。' },
      includeCover: { type: 'boolean', description: 'itemId 来源时，是否把条目登记的 cover 放在第一张当封面。不传 = 用账号 sticker.coverFirst（内置默认 true）；false = 首图自己就是封面（配图成套的日更形式）。' },
      coverIndex: { type: 'number', description: '把选中的第 N 张（1 基，排除之后数）挪到第一张当封面。用于「图都在，但首图不对」；重排会改变这条贴图的身份（去重按顺序算）。' },
      dropImages: { type: 'array', items: { type: 'string' }, description: '从这次要发的图里排除哪几张：填 1 基序号或文件名（如 "3"、"cover.png"）。用于「条目里混了一张不能发的」，比手抄一遍剩下的路径省事。' },
      title: { type: 'string', description: '标题。字数上限见返回的 rules.titleMax（默认 20，微信硬上限 32，图文才是 64）。不传用条目标题；超了会被拒，不截断。' },
      content: { type: 'string', description: '贴图说明（纯文本）。字数上限见 rules.textMax（默认 1000）。不传则把条目正文洗成纯文本（去掉 Markdown 标记、HTML 标签、图片引用，链接只留文字）。说明里不许出现图片标记、图片路径或站外链接。' },
      noText: { type: 'boolean', description: 'true = 就是要一张说明文字都没有的纯图贴图。默认不给空文字，防止洗文案洗空了还闷头推出去。' },
      digest: { type: 'string', description: `摘要（≤${WECHAT_STICKER.digestMax} 字）。不传用账号默认；再没有就不传，让微信自己取说明前 54 字。` },
      minImages: { type: 'number', description: `只对本次生效的图数下限（1~${WECHAT_STICKER.imageMax}）。临时放宽用它，长期口径请写进账号 sticker.minImages——否则面板和产线看到的规则还是老的。` },
      maxImages: { type: 'number', description: `只对本次生效的图数上限（默认取生效规则，天花板 ${WECHAT_STICKER.imageMax} 张就是微信上限）。选中的图多于它会被拒，不会静默丢掉后面的。` },
      titleMax: { type: 'number', description: `只对本次生效的标题字数上限（1~${WECHAT_STICKER.titleMax}，微信硬上限 ${WECHAT_STICKER.titleMax}）。` },
      textMax: { type: 'number', description: '只对本次生效的说明字数上限（0~5000）。填 0 = 这次就是要没有说明。' },
      planOnly: { type: 'boolean', description: 'true = 只列「会用哪些图、标题、说明、生效规则、会净增几格素材、去重结果」，不联网、不上传、不建草稿。先看一眼再推。' },
      commentOpen: { type: 'boolean', description: '这条是否开放评论；不传用账号的 comment.open（默认开放）。' },
      commentFansOnly: { type: 'boolean', description: '这条是否仅关注者可评论；不传用账号的 comment.fansOnly（默认不限）。' },
      checkDraftBox: { type: 'boolean', description: '推前回读草稿箱最近 20 条查同名草稿，默认 true。离线调试或代理慢可传 false。' },
      force: { type: 'boolean', description: 'true = 明知重复（本地台账 / 草稿箱同名 / 说明里有外链 / 说明过长 / 图数不够）仍推，必须带 reason。' },
      reason: { type: 'string', description: 'force=true 时必填：为什么要绕过这道闸。' },
    },
    async execute(args) {
      const account = resolveAccount(args.account, { needSecret: true })
      // 生效规则先算：后面每一道闸的文案都要引用它（数 + 来源），拦下来才说得出「改哪里」。
      const ruleSet = resolveStickerRules({ account, args, config: cfg() })
      const { rules, sources } = ruleSet
      const violations = [...ruleSet.violations]
      // includeCover 是 coverFirst 的调用档别名（老参数名不能废，产线脚本在用）。
      if (args.includeCover !== undefined) {
        rules.coverFirst = args.includeCover === true
        sources.coverFirst = '本次调用 includeCover'
      }
      const wantedItem = String(args.itemId ?? '').trim()
      const explicit = Array.isArray(args.images)
        ? args.images.map(path => String(path ?? '')).map(path => path.trim()).filter(path => path !== '')
        : []
      if (wantedItem === '' && explicit.length === 0) {
        throw fail('不知道该用哪些图', '传 itemId（用自媒体工作台条目的配图，gzh_media_desk action=list 可查），或传 images 给一组本地图片路径')
      }

      // 条目只读一次：选图、标题、说明三处都要用它，读三遍既慢，还可能读到不同版本。
      // requireBody=false：贴图要的是配图，一条图配几句话的贴图稿可能压根没写长正文，
      // 拿图文的「正文 > 80 字」标准拦它，等于变相不让发贴图。
      const item = wantedItem === '' ? null : desk.read(wantedItem, { requireBody: false })

      // ---- 选图：贴图的全部信息量都在图上，选错图比选错排版严重得多 ----
      const picked = []
      const skipped = []
      // 警告从选图一路攒到文案：面板、台账、返回值三处看的都是同一串，别中途换数组。
      const warnings = []
      const digestOf = path => createHash('sha256').update(readFileSync(path)).digest('hex')
      if (explicit.length > 0) {
        for (const path of explicit) {
          if (!existsSync(path) || !statSync(path).isFile()) {
            skipped.push({ src: path, source: 'images 参数', note: '本地没有这个文件' })
            continue
          }
          picked.push({
            localPath: path, fileName: basename(path), bytes: statSync(path).size,
            sha: digestOf(path), caption: '', source: 'images 参数',
          })
        }
      } else {
        // cover 当第一张：贴图的第一张图就是列表里的封面，而工作台恰恰已经把「这张稿子的
        // 封面长什么样」记下来了（橘有据那种固定封面形式尤其对得上）。
        // 关不关这个动作由生效规则说（账号可以配成「首图自己就是封面」），文案里带出处。
        const queue = []
        if (rules.coverFirst) {
          if (item.cover === null) skipped.push({ src: '', source: '工作台 cover', note: '这条没登记 cover，第一张配图将充当封面' })
          else queue.push({ entry: item.cover, source: '工作台 cover（当封面）' })
        } else {
          warnings.push(`没把工作台的 cover 单独挪到第一位（${sources.coverFirst || '账号 sticker.coverFirst'}）：第一张配图就是封面`)
        }
        for (const entry of item.images) queue.push({ entry, source: '工作台配图' })
        for (const { entry, source } of queue) {
          if (entry.kind === 'remote') {
            skipped.push({ src: entry.src, source, note: '外链图片：贴图要的是永久素材 media_id，得先把图落到本地' })
            continue
          }
          if (entry.localPath === '') {
            skipped.push({ src: entry.src, source, note: entry.note === '' ? '本地素材不存在' : entry.note })
            continue
          }
          picked.push({
            localPath: entry.localPath, fileName: entry.fileName, bytes: entry.bytes,
            sha: digestOf(entry.localPath), caption: entry.caption, source,
          })
        }
      }
      if (picked.length === 0) {
        throw fail('一张能用的图都没有', `跳过的 ${skipped.length} 张：\n${skipped.map(row => `${row.src || '（无）'} —— ${row.note}`).join('\n') || '（没有跳过记录，说明选图清单是空的）'}`)
      }

      // ---- 排除与封面挪位：先动集合，再谈张数（闸门要管的是最终真要发的那几张） ----
      // 支持填序号也支持填文件名：面板手里有文件名，模型看计划也是照名字指认，抄路径太容易错。
      const dropRaw = Array.isArray(args.dropImages) ? args.dropImages.map(row => String(row ?? '').trim()).filter(row => row !== '') : []
      const dropped = []
      if (dropRaw.length > 0) {
        const rest = []
        for (const want of dropRaw) {
          const index = /^\d+$/.test(want) ? Number(want) : 0
          const hit = index > 0
            ? (index >= 1 && index <= picked.length ? picked[index - 1] : undefined)
            : picked.find(row => row.fileName.toLowerCase() === want.toLowerCase())
          if (hit === undefined) {
            // 排除没排掉是危险方向：用户以为那张图没了。宁可报错，也不发一条「本该排掉」的贴图。
            throw fail(
              `dropImages 里的「${want}」对不上这次的任何一张图`,
              `现在选中的是（1 基）：${picked.map((row, i) => `${i + 1}.${row.fileName}`).join('、')}；被排除过的：${dropped.map(row => row.fileName).join('、') || '（无）'}`,
            )
          }
          picked.splice(picked.indexOf(hit), 1)
          dropped.push({ fileName: hit.fileName, reason: `dropImages=${want}` })
        }
        if (picked.length === 0) throw fail('排除后一张图都不剩', 'dropImages 少排几张，或者干脆换一批图（images / itemId）')
      }
      // coverIndex 不走 numArg：它会把越界值悄悄夹到边界，等于把「指错封面」变成「随机选一张封面」。
      const coverRaw = args.coverIndex === undefined || args.coverIndex === null ? '' : String(args.coverIndex).trim()
      let coverIndex = 0
      if (coverRaw !== '') {
        const want = Number(coverRaw)
        if (!Number.isInteger(want) || want < 1 || want > picked.length) {
          throw fail(
            `coverIndex=${coverRaw} 不在范围内`,
            `这次要发 ${picked.length} 张图，coverIndex 填 1~${picked.length}（1 基，按 dropImages 排除之后的顺序数；不填就是第一张当封面）`,
          )
        }
        coverIndex = want
      }
      if (coverIndex > 1) {
        const [promoted] = picked.splice(coverIndex - 1, 1)
        picked.unshift(promoted)
        warnings.push(`封面换成了第 ${coverIndex} 张「${promoted.fileName}」（coverIndex）；顺序变了，这条贴图在台账里就是新的一条（去重按顺序算）`)
      }

      // ---- 张数：先上限（微信的天花板）再下限（我们的口径），文案里两档都要出现 ----
      if (picked.length > rules.maxImages) {
        throw fail(
          `选中 ${picked.length} 张图，超过这次允许的 ${rules.maxImages} 张（来自${sources.maxImages || '内置默认'}；微信贴图硬上限 ${WECHAT_STICKER.imageMax} 张）`,
          rules.maxImages >= WECHAT_STICKER.imageMax
            ? `挑出真正要发的 ≤${WECHAT_STICKER.imageMax} 张（images 显式列出来，或 dropImages 排掉几张），或者分两条贴图发`
            : `少挑几张；要长期放宽就调该层的 maxImages（天花板仍是微信的 ${WECHAT_STICKER.imageMax} 张），只放宽这一次用 maxImages 参数`,
        )
      }
      // 图数下限是我们自己定的规范（微信 1 张就发得出去），所以文案里要讲清「凭什么拦你」，
      // 并且指条明路：凑不齐通常是这条稿子还没配够图，不是贴图不该发；而这个号本来就该少，那是配置问题。
      if (picked.length < rules.minImages) {
        const source = sources.minImages || '内置默认'
        if (args.force !== true) {
          throw fail(
            `只有 ${picked.length} 张能用的图，少于每条贴图要求的 ${rules.minImages} 张（来自${source}；微信 ${WECHAT_STICKER.imageMin} 张就发得出去，所以这是我们自己的闸门）`,
            source === '本次调用参数'
              ? '这一档是你这次自己传 minImages 定的：把图补上，或把参数改回这个号的常态；确实要发带 force=true 和 reason'
              : `先分清是哪一种：稿子没配够图 → 补到 ${rules.minImages} 张再推；这个号的形式本来就不是 ${rules.minImages} 张（比如单图消息）→ 用 gzh_account_set 给该号配 sticker.minImages（面板 设置→账号→贴图规则），别每天勾 force 绕闸门。只放宽这一次：带 minImages 参数；临时插播：force=true + reason`,
          )
        }
        warnings.push(`只有 ${picked.length} 张图，不到规范 ${rules.minImages} 张（force 放行；这个号常态如此的话去改 sticker.minImages，别老勾 force）`)
      }

      // ---- 标题：字数上限是可配的规范（微信硬上限 32，图文才是 64），绝不照搬图文那档 ----
      const title = (String(args.title ?? '').trim() !== '' ? String(args.title).trim() : String(item?.title ?? '').trim())
      if (title === '') throw fail('缺少标题', '传 title，或者用带标题的 itemId')
      if (textLength(title) > WECHAT_STICKER.titleMax) {
        // 这一档没有 force 可绕：超 32 字微信自己就拒，放过去只是把清楚的理由换成一条看不懂的 45166。
        throw fail(
          `标题 ${textLength(title)} 字，超过微信给贴图标题的硬上限 ${WECHAT_STICKER.titleMax} 字（图文才是 64 字）`,
          '这一档绕不过去（force 也不行）：删到 32 字内；标题确实要长就改走 gzh_push_draft 推图文',
        )
      }
      if (textLength(title) > rules.titleMax) {
        if (args.force !== true) {
          throw fail(
            `标题 ${textLength(title)} 字，超过贴图规范的 ${rules.titleMax} 字（来自${sources.titleMax || '内置默认'}；微信给贴图的硬上限是 ${WECHAT_STICKER.titleMax} 字，图文才是 64 字）`,
            `贴图标题短才不会在信息流里折行：删到 ${rules.titleMax} 字内；这个号的贴图标题常态就是更长 → gzh_account_set 配 sticker.titleMax（上限仍是微信的 ${WECHAT_STICKER.titleMax}）；只放宽这一次 → titleMax 参数；标题本来就该长，说明这篇更适合走 gzh_push_draft 推图文`,
          )
        }
        warnings.push(`标题 ${textLength(title)} 字，超过了规范 ${rules.titleMax} 字（force 放行，微信硬上限 ${WECHAT_STICKER.titleMax} 字之内）`)
      }

      // ---- 说明文字：只能是纯文本 ----
      let text = String(args.content ?? '').trim()
      let textFrom = text === '' ? '' : 'content 参数'
      let deskMarkdownBytes = 0
      if (text === '' && item !== null) {
        deskMarkdownBytes = item.markdownBytes
        text = plainTextFromMarkdown(item.markdown)
        textFrom = text === '' ? '' : `条目正文（${deskMarkdownBytes} 字节 Markdown）洗成的纯文本`
      }
      if (text === '' && args.noText !== true) {
        throw fail('贴图说明是空的', '传 content，或者用有正文的 itemId 让插件洗出说明；确实要推一条完全没有文字的纯图贴图，带 noText=true')
      }
      if (text === '') warnings.push('noText=true：这条贴图没有说明文字（官方文档写 content 必填，微信若报正文缺失，就补一句再推）')
      // 贴图放宽了「条目必须有正文」这道门（图配几句话本来就是贴图），但放宽不等于不看：
      // 说明只有几十个字时提醒一句，别把工作台里还没定稿的一段当成成稿推出去。
      if (item !== null && text !== '' && item.markdownBytes <= 80) warnings.push(`工作台里这条正文只有 ${item.markdownBytes} 字节（贴图不受「正文太短」限制），说明文字就是从它洗出来的，推前扫一眼`)
      if (skipped.length > 0) warnings.push(`跳过了 ${skipped.length} 张图：${skipped.map(row => `${row.src || '（无）'}（${row.note}）`).join('；')}`)
      const captions = picked.filter(row => row.caption !== '').length
      if (captions > 0) warnings.push(`${captions} 张图带图片说明（caption），但贴图没有「每张图一行说明」的位置，它们不会出现在草稿里`)
      if (text !== '' && textFrom.includes('洗成')) warnings.push(`说明文字是从 Markdown 洗出来的（${textLength(text)} 字），建议扫一眼有没有残留的符号或断行` + (deskMarkdownBytes > 4000 ? '；原文很长，贴图放不下这么多字，该推图文' : ''))

      const textFindings = text === '' ? [] : auditStickerText(text)
      if (textFindings.length > 0 && args.force !== true) {
        const label = { image: '图片标记', path: '图片路径', link: '站外链接' }
        throw fail(
          `贴图说明里有 ${textFindings.length} 处不能推的东西：\n${textFindings.slice(0, 5).map(row => `${label[row.kind] ?? row.kind} 「${row.value}」 —— ${row.why}`).join('\n')}`,
          '贴图正文只有纯文本：链接删掉或改成截图，图片一律走配图（images / 工作台条目），别写进说明；确认这些都能留，就带 force=true 和 reason',
        )
      }
      if (textLength(text) > rules.textMax && args.force !== true) {
        if (rules.textMax === 0) {
          // 这一档不是「写长了」，是「这个号压根不写说明」——文案得把这两件事分开说，
          // 否则用户看到的是「超过 0 字」这种莫名其妙的报错。
          throw fail(
            `这个号的贴图形式是纯图不写说明（textMax=0，来自${sources.textMax || '内置默认'}），这次带了 ${textLength(text)} 字说明`,
            '纯图贴图就别传 content（面板勾「不要说明文字」＝noText=true）；这篇确实要写说明 → 用 textMax 参数临时放宽，或 gzh_account_set 改 sticker.textMax；确实按现在这样推就带 force=true 和 reason',
          )
        }
        throw fail(
          `贴图说明 ${textLength(text)} 字，超过 ${rules.textMax} 字（来自${sources.textMax || '内置默认'}；微信这一档没公开硬上限，所以完全按我们的口径）`,
          '贴图在信息流里就是一张图配几句话：删短，或者这篇该走 gzh_push_draft 推图文；这个号常态说明更长 → gzh_account_set 配 sticker.textMax；只放宽这一次 → textMax 参数；确实要推就带 force=true 和 reason',
        )
      }

      let digest = String(args.digest ?? '').trim()
      let digestFrom = digest === '' ? '' : 'push 参数'
      if (digest === '' && String(account.digest ?? '').trim() !== '') {
        digest = String(account.digest).trim()
        digestFrom = '账号默认摘要'
      }
      if (digest !== '' && textLength(digest) > WECHAT_STICKER.digestMax) digest = clampText(digest, WECHAT_STICKER.digestMax)

      // ---- 素材名额与重复图：只看本地台账，planOnly 也一次网络都不发 ----
      // 每张图都会在号的永久素材库里占一格，而且是**长期**占：贴图做得多了，素材库比草稿箱先满。
      // 这里给的是「本插件台账口径」——产线脚本传的图看不见，所以它是下界，要准数走 gzh_material_audit。
      const sha12 = picked.map(row => row.sha.slice(0, 12))
      const trackedMaterials = store.readMaterials().filter(row => row.appid === account.appid)
      const trackedShas = new Set(trackedMaterials.map(row => row.sha))
      const alreadyUploaded = picked.filter(row => trackedShas.has(row.sha)).length
      const quota = {
        trackedImages: trackedMaterials.length,
        alreadyUploaded,
        netNew: picked.length - alreadyUploaded,
        note: `本插件为这个号上传过 ${trackedMaterials.length} 张永久素材；这次 ${picked.length} 张里 ${alreadyUploaded} 张已占格，净增 ${picked.length - alreadyUploaded} 格。台账口径，产线传的图不计入，准数用 gzh_material_audit`,
      }
      // 同一张图在同一个号上反复出现，多半是拿旧条目当模板时没换图。不拦（同一张图复用是
      // 省钱的正解），但要说出来：草稿箱里两条贴图长得一模一样，通常是事故而不是设计。
      const ledger = store.readLedger()
      const stickerLedger = ledger.filter(row => row.account === account.key && row.articleType === 'newspic' && Array.isArray(row.imageShas))
      const repeatImages = []
      picked.forEach((row, index) => {
        const hits = stickerLedger.filter(entry => entry.imageShas.includes(row.sha.slice(0, 12)))
        if (hits.length === 0) return
        repeatImages.push({
          fileName: row.fileName, position: index + 1, sha: row.sha.slice(0, 12),
          times: hits.length, lastPushedAt: hits[0].at ?? null, lastMediaId: hits[0].mediaId ?? null,
        })
      })
      if (repeatImages.length > 0) {
        warnings.push(`${repeatImages.length} 张图和这个号以前推过的贴图重复：${repeatImages.slice(0, 4).map(row => `${row.fileName}（${row.times} 次${row.lastPushedAt ? `，最近 ${row.lastPushedAt}` : ''}）`).join('；')}${repeatImages.length > 4 ? '…' : ''}。复用图本身省钱，但两条贴图几乎一样时通常该换图` + (repeatImages.length > alreadyUploaded ? '；重复不等于不占格以外的成本——没传过的还是会净增素材' : ''))
      }

      const imageKey = sha12.join(',')
      const fp = store.fingerprint({ account: account.key, title, content: `${text}\n图:${imageKey}` })
      const prior = store.readLedger().find(entry => entry.fingerprint === fp)
      if (prior !== undefined && args.force !== true) {
        throw fail(`这条贴图已经推过一次（${prior.at}，草稿 media_id=${prior.mediaId}）`, '重复草稿是线上事故。确认要再推一份，就带 force=true 和 reason')
      }
      if (args.force === true && String(args.reason ?? '').trim() === '') throw fail('force=true 必须带 reason', '写清为什么要绕过这道闸')

      const plan = {
        account: account.key,
        articleType: 'newspic',
        // 面板拿它对一下「这份计划还是不是当前选中的条目」，换了文章不能拿旧计划直接推。
        itemId: item?.id ?? '',
        title,
        titleChars: textLength(title),
        content: text,
        contentFrom: textFrom || (args.noText === true ? '无说明文字（noText）' : ''),
        digest: digest || null,
        digestFrom: digestFrom || '不传，微信取说明前 54 字',
        images: picked.map((row, index) => ({
          fileName: row.fileName, bytes: row.bytes, sha: row.sha.slice(0, 12), source: row.source,
          localPath: row.localPath, position: index + 1, isCover: index === 0,
        })),
        skipped,
        droppedImages: dropped,
        // 生效规则与来源：面板按它渲染（不再自己写死 6 张/20 字），人和模型被拦时看它才知道改哪一层。
        rules: {
          summary: ruleSet.summary,
          values: { minImages: rules.minImages, maxImages: rules.maxImages, titleMax: rules.titleMax, textMax: rules.textMax, coverFirst: rules.coverFirst },
          sources,
          hard: { images: `${WECHAT_STICKER.imageMin}~${WECHAT_STICKER.imageMax}`, title: WECHAT_STICKER.titleMax, digest: WECHAT_STICKER.digestMax },
          violations,
          editable: STICKER_RULE_FIELDS.map(row => ({
            key: row.key, label: row.label, min: row.min, max: row.max,
            type: row.type ?? 'number', hint: row.hint, globalKey: row.globalKey ?? null,
          })),
        },
        quota,
        repeatImages,
        warnings,
        duplicateOf: prior === undefined ? null : { at: prior.at, mediaId: prior.mediaId },
      }
      // planOnly：一行网络都不发。选图与文案在这里看明白，比推完再去后台删省事得多——
      // 每张图都会占一格永久素材库，上传前是唯一还能反悔的时机。
      if (args.planOnly === true) {
        return {
          ok: true, planOnly: true, plan,
          next: `确认无误后去掉 planOnly 真推：这次净增 ${quota.netNew} 格永久素材（同号同图只传一次），图数按「${ruleSet.summary}」（来源 ${Object.entries(sources).map(([key, from]) => `${key}←${from}`).join('、')}）`,
        }
      }

      const client = createClient({
        baseUrl: account.proxyUrl, token: account.proxyToken,
        appid: account.appid, secret: account.appsecret, timeoutMs: cfg().timeoutMs,
      })

      // ---- 草稿箱同名：台账只记得本插件推过的，产线/后台推的看不见 ----
      let draftBox = { checked: false, hits: [], error: '' }
      if (args.checkDraftBox !== false) {
        try {
          const norm = value => String(value ?? '').replace(/\s+/g, '')
          const drafts = await client.listDrafts(0, 20)
          draftBox = {
            checked: true,
            hits: drafts.filter(entry => norm(entry.title) === norm(title))
              .map(entry => ({ mediaId: entry.mediaId, title: entry.title, articleType: entry.articleType, updatedAt: entry.updatedAt ?? null })),
            error: '',
          }
        } catch (cause) {
          draftBox = { checked: false, hits: [], error: cause.message }
        }
        if (draftBox.checked && draftBox.hits.length > 0 && args.force !== true) {
          throw fail(
            `草稿箱里已经有 ${draftBox.hits.length} 条同名草稿：${draftBox.hits.map(hit => `${hit.mediaId}（${hit.title}｜${hit.articleType === 'newspic' ? '贴图' : '图文'}）`).join('、')}`,
            '本插件的台账只记得自己推过的，产线/后台推的看不见。要么先去后台删掉旧草稿，要么确认要再建一条就带 force=true 和 reason',
          )
        }
      }

      // ---- 上传永久素材 ----
      const uploaded = await uploadStickerImages(client, store, picked, {
        outDir: join(store.outDir, 'sticker'),
        maxBytes: WECHAT_STICKER.materialMaxBytes,
        maxEdge: numArg(cfg().imageMaxEdge, 1440, 320, 4096),
        timeoutMs: numArg(cfg().compressTimeoutMs, 120_000, 10_000, 600_000),
        config: cfg(),
      })
      // 三处台账都带上 imageShas 与当次的规则快照：前者让下一次 plan 能认出「这张图这个号
      // 发过」，后者让半年后还能回答「当时是按什么口径放行的」——规则可以改，台账不能改。
      const ruleSnapshot = { minImages: rules.minImages, maxImages: rules.maxImages, titleMax: rules.titleMax, textMax: rules.textMax }

      if (uploaded.error !== undefined) {
        // 已经传上去的不回收（素材库没有可用的删除口），但缓存已经记下，重推只会再传失败这张。
        store.appendLedger({ fingerprint: fp, account: account.key, articleType: 'newspic', title, mediaId: null, error: uploaded.error, endpoint: client.endpoint, uploadedBeforeFail: uploaded.rows.length, images: picked.length, imageKey, imageShas: sha12, stickerRules: ruleSnapshot })
        throw fail(uploaded.error, `停在这之前已上传 ${uploaded.rows.length} 张（都记进素材缓存了，重推会复用，不会重复占名额）。materials.json：${store.materialsFile}`)
      }

      let mediaId = ''
      try {
        mediaId = await client.addStickerDraft({
          title, content: text, imageMediaIds: uploaded.mediaIds,
          digest: digest === '' ? undefined : digest,
          comment: commentSetting(account, args),
        })
      } catch (cause) {
        store.appendLedger({ fingerprint: fp, account: account.key, articleType: 'newspic', title, mediaId: null, error: cause.message, hint: cause.hint ?? '', endpoint: client.endpoint, imageKey, imageShas: sha12, stickerRules: ruleSnapshot, images: uploaded.mediaIds.length, digest, digestFrom })
        throw fail(cause.message, `${cause.hint ?? ''} 先别重推：用 gzh_draft_verify（articleType=newspic）回读看草稿箱里到底有没有建出来。`)
      }

      store.appendLedger({
        fingerprint: fp, account: account.key, articleType: 'newspic', title, mediaId,
        endpoint: client.endpoint, images: uploaded.mediaIds.length, coverImage: picked[0].fileName,
        imageKey, imageShas: sha12, stickerRules: ruleSnapshot, imageMediaIds: uploaded.mediaIds, textChars: textLength(text), digest, digestFrom,
        forced: args.force === true, reason: args.reason ?? '',
        draftBox: draftBox.hits, warnings,
      })
      return {
        ok: true,
        mediaId,
        account: account.key,
        articleType: 'newspic',
        title,
        cover: { from: picked[0].source, fileName: picked[0].fileName, mediaId: uploaded.mediaIds[0] },
        images: uploaded.rows,
        content: text,
        contentFrom: textFrom || '无说明文字（noText）',
        digest: digest || null,
        digestFrom: digestFrom || '不传，微信取说明前 54 字',
        uploadedNow: uploaded.rows.filter(row => row.uploaded).length,
        reused: uploaded.rows.filter(row => !row.uploaded).length,
        // 推完也要能回答「按什么口径推的、这次占了几格」——和 plan 里同一份，不必再去 planOnly 跑一遍。
        rules: plan.rules,
        quota,
        warnings,
        next: '用 gzh_draft_verify 回读（带 articleType="newspic"：贴图与图文在草稿箱里同表存放，只比标题发现不了串型）',
      }
    },
  })

  register({
    name: 'gzh_material_audit',
    description: '看某个号的**永久图片素材**占用：本插件上传台账（materials.json，按「号+图片内容」缓存）+ 贴图台账（哪些图被反复用、哪些只用过一次），再可选联网拿微信侧 `material/get_materialcount` 的真实总数。贴图每张图都要占一格永久素材，是长期成本——推之前看 plan 里的 `quota`（台账下界，不联网），要准数就调它。本工具只读，不删任何东西：素材一旦进过草稿或已发布文章，删了会裂图，而插件看不见「线上文章在引用谁」，所以清理由人在公众平台后台看着做。',
    parameters: {
      account: { type: 'string', required: true, description: '查哪个号。' },
      live: { type: 'boolean', description: 'true = 顺便联网读微信的永久素材真实总数（要 appsecret）。默认 false = 只看本地台账，一次请求都不发。' },
      warnAt: { type: 'number', description: '可选：素材数到这个线就在 alarm 里提示你复核贴图节奏。插件**不猜微信的名额**（官方没公开图片名额），所以不填就永远不会报「快满了」。' },
    },
    async execute(args) {
      const account = resolveAccount(args.account, { needSecret: args.live === true })
      const materials = store.readMaterials().filter(row => row.appid === account.appid)
      const ledger = store.readLedger()
      const stickerRows = ledger.filter(row => row.account === account.key && row.articleType === 'newspic')
      const newsCoverRows = ledger.filter(row => row.account === account.key && row.articleType !== 'newspic')

      // 复用率：同一张图（内容 sha）被几条贴图用过。复用是省名额的正解，
      // 但只用过一次的散图才是让素材库长胖的东西——所以两边都要给出条数。
      const usedBy = new Map()
      for (const row of stickerRows) {
        for (const sha of Array.isArray(row.imageShas) ? row.imageShas : []) {
          usedBy.set(sha, (usedBy.get(sha) ?? 0) + 1)
        }
      }
      const trackedShas = new Set(materials.map(row => row.sha.slice(0, 12)))
      const seen = [...usedBy.entries()]
      const reused = seen.filter(([sha, times]) => times > 1 && trackedShas.has(sha))
      const orphans = [...trackedShas].filter(sha => !usedBy.has(sha))

      let live = { checked: false, image: null, news: null, voice: null, video: null, error: '' }
      if (args.live === true) {
        try {
          const client = createClient({
            baseUrl: account.proxyUrl, token: account.proxyToken,
            appid: account.appid, secret: account.appsecret, timeoutMs: cfg().timeoutMs,
          })
          const counts = await client.materialCount()
          live = { checked: true, image: counts.image, news: counts.image_text, voice: counts.voice, video: counts.video, error: '' }
        } catch (cause) {
          live = { checked: false, image: null, news: null, voice: null, video: null, error: cause.message }
        }
      }

      const counted = live.checked && live.image !== null ? live.image : materials.length
      const basis = live.checked && live.image !== null ? '微信 material/get_materialcount（真数，含产线传的图）' : '本地台账（下界：产线脚本与后台手传的图不计入）'
      const alarm = Number.isFinite(Number(args.warnAt)) && counted >= Number(args.warnAt)
        ? `图片素材已 ${counted} 张，到了你设的 ${Math.round(Number(args.warnAt))} 的线：贴图前先 planOnly 看 quota，散图改成成套复用，别一格一张地长`
        : null
      return {
        ok: true,
        account: account.key,
        appid: account.appid,
        basis,
        materials: {
          tracked: materials.length,
          wechatImage: live.image,
          wechatError: live.error,
          lastUploadedAt: materials[0]?.at ?? null,
        },
        stickerLedger: {
          pushes: stickerRows.length,
          imagesTotal: stickerRows.reduce((sum, row) => sum + Number(row.images ?? 0), 0),
          distinctImages: usedBy.size,
          reuseRate: usedBy.size === 0 ? null : Number((reused.length / usedBy.size).toFixed(2)),
          // 只用过一次的图是最该收拾的：占一格永久素材，只在一条贴图里露过面。
          singleUse: [...usedBy.values()].filter(times => times === 1).length,
          topReused: seen.filter(([, times]) => times > 1).sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([sha, times]) => ({ sha, times, fileName: materials.find(row => row.sha.slice(0, 12) === sha)?.fileName ?? '' })),
          // 台账里有但从没进过任何贴图：可能是失败那几次留下的，也可能是别条链路传的。
          uploadedButNeverInSticker: orphans.length,
        },
        newsCoverLedger: { pushes: newsCoverRows.length, note: '图文封面走 uploadimg/临时素材的不占永久名额；只有显式登记的 thumb 才可能占' },
        alarm,
        next: live.checked
          ? '清理请在公众平台素材库后台做（插件不删素材：进过草稿或已发布文章的图删掉就裂图，而插件看不见线上引用）'
          : '要看微信侧真数，带 live=true（要 appsecret）',
      }
    },
  })

  register({
    name: 'gzh_draft_verify',
    description: '回读该号的草稿箱，验证刚推的草稿在不在、标题对不对（对齐产线 wechat_readback.py 的判据）。给了 mediaId 就精确找它，否则列最近 N 条给人对照。推的是贴图就带 articleType="newspic"：图文与贴图存在同一张草稿表里，回读时**只有 article_type 能区分**（贴图也会被微信回填 thumb_media_id，所以「有封面」绝不代表它是图文）。',
    parameters: {
      account: { type: 'string', required: true, description: '查哪个号。' },
      mediaId: { type: 'string', description: 'gzh_push_draft / gzh_push_sticker 返回的草稿 media_id。' },
      title: { type: 'string', description: '期望标题；给了就逐条比对并报告是否命中。' },
      articleType: { type: 'string', description: '期望类型：news（图文）或 newspic（贴图）。推贴图必须传 newspic——串了型在草稿列表里长得几乎一样，推到手机上才发现。' },
      count: { type: 'number', description: '回读条数，默认 10，最大 20。' },
    },
    async execute(args) {
      const account = resolveAccount(args.account, { needSecret: true })
      const client = createClient({
        baseUrl: account.proxyUrl, token: account.proxyToken,
        appid: account.appid, secret: account.appsecret, timeoutMs: cfg().timeoutMs,
      })
      const count = Math.round(numArg(args.count, 10, 1, 20))
      const wantType = String(args.articleType ?? '').trim()
      if (wantType !== '' && wantType !== 'news' && wantType !== 'newspic') {
        throw fail(`articleType 只认 news 或 newspic，收到「${wantType}」`, '图文=news，贴图=newspic；不关心类型就不传这个参数')
      }
      const drafts = await client.listDrafts(0, count)
      const mediaId = String(args.mediaId ?? '')
      const want = String(args.title ?? '').trim()
      const found = mediaId === '' ? null : drafts.find(entry => entry.mediaId === mediaId) ?? null
      const problems = []
      if (mediaId !== '' && found === null) problems.push(`草稿箱最近 ${count} 条里没有 ${mediaId}：可能超出回读范围，或推送其实没建成`)
      if (found !== null && want !== '' && found.title !== want) problems.push(`标题不一致：草稿里是「${found.title}」，期望「${want}」`)
      // 串型检查：贴图与图文共用 draft/add，参数写错一个字段就可能推出另一种形态，
      // 而它在草稿列表里几乎看不出差别（微信还会替贴图回填 thumb_media_id）。
      if (found !== null && wantType !== '' && found.articleType !== wantType) {
        problems.push(`类型不对：草稿里是「${found.articleType === 'newspic' ? '贴图 newspic' : '图文 news'}」，期望「${wantType === 'newspic' ? '贴图 newspic' : '图文 news'}」`)
      }
      if (found !== null && found.articleCount > 1) problems.push(`草稿里有 ${found.articleCount} 篇（多图文），本插件只应该产出 1 篇`)
      return {
        ok: problems.length === 0,
        account: account.key,
        endpoint: client.endpoint,
        checked: { mediaId: mediaId || null, title: want || null, articleType: wantType || null, count },
        found,
        problems,
        drafts: drafts.slice(0, 10),
        recentPushes: store.readLedger().slice(0, 3),
      }
    },
  })

  /**
   * 给宿主：disposers 用来摘工具。
   * 给面板路由：call() 只认 handlers 里这几个名字，参数与工具一致（同一份校验、同一份去重台账）。
   */
  return {
    disposers,
    names: () => [...handlers.keys()],
    call: (name, args = {}) => {
      const handler = handlers.get(String(name ?? ''))
      if (handler === undefined) throw fail(`没有这个动作：${String(name ?? '')}`, `可用动作：${[...handlers.keys()].join('、')}`)
      return handler(args === null || typeof args !== 'object' ? {} : args)
    },
  }
}

/** 预览用外壳：只在 layout_preview 里包一层，真正推送的 HTML 不含它。 */
function wrapPreviewDocument(inner, title) {
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${title}</title>\n<style>body{margin:0;background:#f2f3f5;display:flex;justify-content:center;}main{width:100%;max-width:420px;background:#fff;padding:16px 0;}</style>\n</head><body><main>${inner}</main></body></html>\n`
}
