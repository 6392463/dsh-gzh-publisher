/**
 * 配图规划 —— 渲染之前，把「图」这件事真正决定下来。
 * ────────────────────────────────────────────────────────────────
 * 工作台把图生成好、登记在 production.cover / production.images 里，可正文那一侧
 * 往往完全没用上它们：导出的稿子要么把两张图甩在文末（`![](配图1.png)` 连着两行），
 * 要么一行 `![]()` 都不写。以前的行为是「正文没写就不插图」，只在 images[] 里留一行
 * 错误，用户看到的就是「配图 0 张」而图明明躺在条目目录里。
 *
 * 这个模块把本该由排版环节做的三个判断补齐：
 *   1. 哪张当封面（cover.src 有就用它；没有就从配图里挑一张，并说清凭什么挑它）；
 *   2. 哪些当插图（正文里已经写了位置的，一个字节都不动）；
 *   3. 每张插图插在哪一节后面（工作台留的「## 第N张图：…」占位 > 图自己的 anchor 锚点
 *      > 均匀铺到各节；末尾甩一堆图的，挪走并说明）。
 *
 * 纯函数：不碰文件系统，路径与内容指纹由调用方注入（resolveLocal / digestOf），
 * 所以离线测试能覆盖全部规则。
 */

import { basename } from 'node:path'

/** 独占一行的图片：`![图注](路径)`。 */
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]*)\)\s*$/
/** 工作台写稿时用来占住图片位的标题：`## 第一张图：能交付的东西`。 */
const SLOT_RE = /^#{2,4}\s*第\s*([0-9]+|[一二三四五六七八九十]{1,3})\s*张(?:图|配图)\s*[:：]?\s*(.*)$/
const HEADING_RE = /^#{2,4}\s+\S/
const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
/** 一眼看出「这张本来就是当封面生的」。 */
const COVER_HINT = /(封面|主图|主视觉|首图|头图|banner|poster|thumb|cover)/i
/** 这些状态的图根本不存在，别插。 */
const DEAD_STATUS = new Set(['failed', 'fail', 'error', 'canceled', 'cancelled'])

/** 「第一张图」/「第12张图」→ 数字。 */
function ordinal(token) {
  if (/^[0-9]+$/.test(token)) return Number(token)
  if (token === '十') return 10
  if (token.startsWith('十') && token.length === 3) return 10 + (CN[token[1]] ?? 0)
  return CN[token] ?? 0
}

/** 把正文切成节：第一个 `##` 之前的部分叫「（开头）」，它也能放图（首屏要有图）。 */
function scanSections(lines) {
  const heads = []
  let fence = false
  for (let index = 0; index < lines.length; index += 1) {
    const text = String(lines[index]).trim()
    if (text.startsWith('```')) { fence = !fence; continue }
    if (fence) continue
    if (HEADING_RE.test(text) && !SLOT_RE.test(text)) heads.push({ line: index, title: text.replace(/^#+\s*/, '') })
  }
  const sections = []
  const first = heads.length === 0 ? -1 : heads[0].line
  if (first !== 0) sections.push({ title: '（开头）', start: 0, end: first === -1 ? lines.length : first })
  heads.forEach((head, at) => sections.push({
    title: head.title,
    start: head.line,
    end: at + 1 < heads.length ? heads[at + 1].line : lines.length,
  }))
  return sections
}

/**
 * 规划一篇稿子的配图。
 * @param {object} input
 * @param {string} input.markdown 正文原稿。
 * @param {Array<{src:string,caption?:string,anchor?:string,status?:string,localPath?:string,bytes?:number}>} [input.images]
 *        条目登记的配图（localPath 必须是调用方确认过存在的路径，空串 = 文件不在）。
 * @param {{src:string,localPath?:string}|null} [input.cover] 条目登记的封面。
 * @param {boolean} [input.autoPlace] false = 完全按原稿顺序，不插不移。
 * @param {(src:string)=>string} [input.resolveLocal] 把正文里的 `![](src)` 解析成本地路径（认内容去重用）。
 * @param {(path:string)=>string} [input.digestOf] 文件内容指纹（同一张图换了文件名不会重复插）。
 * @returns {{ markdown: string, cover: {src:string,reason:string}|null, placed: Array, kept: number, relocated: number, skipped: Array, notes: string[] }}
 */
export function planImages({ markdown, images = [], cover = null, autoPlace = true, resolveLocal = src => src, digestOf = () => '' }) {
  const notes = []
  const skipped = []
  const placed = []
  const original = String(markdown ?? '')
  const usable = Array.isArray(images) ? images : []

  // 内容指纹：正文写了 `配图1.png`、台账登记 `files/g_xxx.png`，字节一样就是同一张图。
  const keyOf = (src, localPath = '') => {
    const path = String(localPath !== '' ? localPath : resolveLocal(src) ?? '')
    if (path === '') return ''
    const digest = digestOf(path)
    return digest === '' ? `path:${path}` : digest
  }
  const alive = entry => entry !== null && entry !== undefined
    && String(entry.src ?? '') !== ''
    && !DEAD_STATUS.has(String(entry.status ?? '').toLowerCase())
  const localOf = entry => {
    const recorded = String(entry?.localPath ?? '')
    return recorded !== '' ? recorded : String(resolveLocal(String(entry?.src ?? '')) ?? '')
  }
  const ready = entry => alive(entry) && localOf(entry) !== ''

  const lines = original.split('\n')
  const refs = []
  let fence = false
  for (let index = 0; index < lines.length; index += 1) {
    const text = String(lines[index]).trim()
    if (text.startsWith('```')) { fence = !fence; continue }
    if (fence || text === '') continue
    const hit = text.match(IMAGE_LINE_RE)
    if (hit !== null) refs.push({ line: index, alt: hit[1].trim(), src: hit[2].trim() })
  }
  const usedKeys = new Set(refs.map(ref => keyOf(ref.src)).filter(key => key !== ''))

  // 文末连着排成一串、又没有图注的图 = 工作台导出时甩在结尾的，不叫「放在合适位置」。
  const tail = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = String(lines[index]).trim()
    if (text === '') continue
    const hit = text.match(IMAGE_LINE_RE)
    if (hit === null) break
    tail.push({ line: index, alt: hit[1].trim(), src: hit[2].trim() })
  }
  tail.reverse()
  const proseBefore = lines.slice(0, tail.length > 0 ? tail[0].line : lines.length).filter(line => {
    const text = line.trim()
    return text !== '' && !IMAGE_LINE_RE.test(text)
  }).length
  const relocate = autoPlace === true && tail.length >= 2 && proseBefore >= 3

  // 正文里已有的位置永远优先（挪走用户写的东西是不可接受的）。
  const keptRefs = relocate ? refs.filter(ref => !tail.some(entry => entry.line === ref.line)) : refs
  const imageLine = (src, caption) => (caption === '' ? `![](${src})` : `![${caption}](${src})`)

  // ── 1. 封面：登记过就用，没登记就从配图里挑，并说清凭什么 ──────────────
  const readyUsable = usable.filter(entry => ready(entry) && String(entry.src ?? '') !== '')
  let coverPick = null
  if (ready(cover)) {
    coverPick = { src: String(cover.src), reason: '用的是工作台登记的封面' }
  } else if (readyUsable.length > 0) {
    const hint = readyUsable.filter(entry => COVER_HINT.test(`${entry.src} ${entry.caption ?? ''} ${entry.anchor ?? ''}`))
    const pool = hint.length > 0 ? hint : readyUsable
    const best = pool.slice().sort((a, b) => Number(b.bytes ?? 0) - Number(a.bytes ?? 0))[0]
    const bestKey = keyOf(String(best.src), localOf(best))
    const reused = bestKey !== '' && refs.some(ref => keyOf(ref.src) === bestKey)
    // 图本来就少（<3 张）时不把它从正文里吃掉：公众号允许封面和正文用同一张图，
    // 而「两张图只剩一张插图」的正文明显更难看。
    const alsoInBody = reused || readyUsable.length < 3
    const bytes = Number(best.bytes ?? 0)
    coverPick = {
      src: String(best.src),
      alsoInBody,
      reason: '工作台这条没生成封面，从配图里挑了'
        + `${hint.length > 0 ? '文件名/图注里写着「封面/主图」的' : '字节最大的'}那张（${basename(localOf(best))}${bytes > 0 ? `，${(bytes / 1048576).toFixed(2)}MB` : ''}）`
        + `${reused ? '；它本来就在正文里，封面复用同一张是常态' : alsoInBody ? '；这条图不多，正文里也照样插这一张' : '；这张只当封面，不进正文'}。`
        + '要换一张：gzh_render 传 cover，或 gzh_account_set 配个默认封面',
    }
  }
  const coverEntry = ready(cover) ? cover : usable.find(entry => String(entry.src ?? '') === String(coverPick?.src ?? ''))
  const coverKey = coverPick === null ? '' : keyOf(coverPick.src, localOf(coverEntry ?? {}))
  const coverReuseBody = (coverPick?.alsoInBody ?? false) === true || readyUsable.length < 3

  // ── 2. 候选插图：登记的、文件在的、正文还没用过的（按内容认，不认文件名）──
  const queue = []
  /** 台账里的图注（`production.images[].caption`）：正文 alt 空着的时候用它。 */
  const registryCaption = key => {
    if (key === '') return ''
    const hit = usable.find(entry => keyOf(String(entry?.src ?? ''), localOf(entry)) === key)
    return hit === undefined ? '' : String(hit.caption ?? '').trim()
  }
  if (relocate) {
    tail.forEach(ref => queue.push({
      src: ref.src,
      caption: ref.alt !== '' ? ref.alt : registryCaption(keyOf(ref.src)),
      anchor: '',
      reason: '原稿末尾甩着，挪到节后面',
    }))
  }
  if (autoPlace === true) {
    const queuedKeys = new Set()
    for (const entry of usable) {
      const src = String(entry.src ?? '')
      if (!alive(entry)) continue
      if (!ready(entry)) { skipped.push({ src, reason: '文件不在（工作台账上记的路径找不到实体）' }); continue }
      const key = keyOf(src, localOf(entry))
      // 正文里已经有这张（含从末尾挪走的那几张）就别再排一遍
      if (key !== '' && usedKeys.has(key)) continue
      // 台账里两张内容一样（工作台重生成时常见），只排一次
      if (key !== '' && queuedKeys.has(key)) { skipped.push({ src, reason: '和前面那张是同一张图（内容一样），只插一次' }); continue }
      if (coverKey !== '' && key === coverKey && coverReuseBody === false) {
        skipped.push({ src, reason: '这次只拿去当封面了（正文里不再出现）' })
        continue
      }
      if (key !== '') queuedKeys.add(key)
      queue.push({ src, caption: String(entry.caption ?? ''), anchor: String(entry.anchor ?? ''), reason: '' })
    }
  } else {
    usable.forEach(entry => {
      const src = String(entry.src ?? '')
      if (!ready(entry) || usedKeys.has(keyOf(src, localOf(entry)))) return
      skipped.push({ src, reason: 'autoPlace=false：没有自动插图' })
    })
  }

  // ── 3. 落位：占位标题 > anchor 锚点 > 均匀铺到各节 ────────────────────
  let work = lines.slice()
  const slotHits = []
  let scanning = true
  while (scanning) {
    scanning = false
    for (let index = 0; index < work.length && queue.length > 0; index += 1) {
      const text = String(work[index]).trim()
      const slot = text.match(SLOT_RE)
      if (slot === null) continue
      const desc = slot[2].trim()
      let at = desc === '' ? -1 : queue.findIndex(item => item.caption === desc || item.anchor === desc)
      if (at < 0) at = 0
      const item = queue.splice(at, 1)[0]
      const caption = item.caption !== '' ? item.caption : desc
      work[index] = imageLine(item.src, caption)
      placed.push({ src: item.src, file: basename(item.src), section: desc === '' ? text.replace(/^#+\s*/, '') : desc, reason: '正文里留着「第N张图」的占位，图放在这儿（那行标题被图替换掉了）' })
      scanning = true
      break
    }
  }

  let sections = scanSections(work)
  const occupied = new Set()
  for (let index = 0; index < work.length; index += 1) {
    if (IMAGE_LINE_RE.test(String(work[index]).trim())) {
      const at = sections.findIndex(section => index >= section.start && index < section.end)
      if (at >= 0) occupied.add(at)
    }
  }

  const insertAt = (lineIndex, item, section, reason) => {
    work[lineIndex] = `${work[lineIndex]}\n\n${imageLine(item.src, item.caption)}`
    placed.push({ src: item.src, file: basename(item.src), section, reason })
  }
  const lastContentLine = section => {
    for (let index = section.end - 1; index > section.start; index -= 1) {
      const text = String(work[index]).trim()
      if (text !== '' && !IMAGE_LINE_RE.test(text)) return index
    }
    return -1
  }

  // anchor：图上写着要配哪段（工作台的分镜锚点），就插到那一节最后
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const item = queue[i]
    if (item.anchor === '') continue
    const needle = item.anchor.slice(0, 8)
    let at = sections.findIndex(section => section.title.includes(needle))
    if (at < 0) at = sections.findIndex(section => work.slice(section.start, section.end).some(line => String(line).includes(needle)))
    if (at < 0) continue
    const lineIndex = lastContentLine(sections[at])
    if (lineIndex < 0) continue
    queue.splice(i, 1)
    insertAt(lineIndex, item, sections[at].title, `图上登记的锚点「${item.anchor}」对得上这一节`)
    occupied.add(at)
    sections = scanSections(work)
  }

  // 剩下的均匀铺：优先挑还没有图的节，首屏那张放开头一节
  const free = sections.map((section, at) => at).filter(at => !occupied.has(at))
  const targets = free.length > 0 ? free : sections.map((section, at) => at)
  queue.forEach((item, at) => {
    const sectionAt = targets[Math.floor(at * targets.length / queue.length)]
    const section = sections[sectionAt]
    const lineIndex = lastContentLine(section)
    if (lineIndex < 0) { skipped.push({ src: item.src, reason: `「${section.title}」这一节没有正文，图没地方放` }); return }
    insertAt(lineIndex, item, section.title, item.reason === '' ? `均匀铺到各节，落在「${section.title}」之后` : `${item.reason}（改放「${section.title}」之后）`)
  })

  // 占位标题没等到图：那几行会原样排成节标题，得说一声，别让人以为图会自己冒出来。
  const emptySlots = work.filter(line => SLOT_RE.test(String(line).trim())).map(line => String(line).trim().replace(/^#+\s*/, ''))
  if (emptySlots.length > 0) {
    notes.push(`正文里还留着 ${emptySlots.length} 个「第N张图」占位（${emptySlots.join('、')}），但登记的图已经用完了 —— 这次它们会当普通节标题排出来`)
  }

  // 删掉原稿末尾那一串（它们已经在上面重新落位了）
  if (relocate) {
    const dead = new Set(tail.map(ref => ref.line))
    work = work.filter((line, index) => !dead.has(index) || String(line).trim() === '')
  }

  const markdownOut = work.join('\n').replace(/\n{3,}/g, '\n\n')
  if (relocate) {
    notes.push(`原稿末尾连着放了 ${tail.length} 张图（没有图注，是工作台导出时的甩尾写法），这次按节挪开了；要原样就传 autoPlace=false`)
  }
  if (coverPick === null) {
    notes.push('没有可用的封面：这条既没登记 cover，配图也没一张能用（推送时会被封面闸门拦住）')
  }
  usable.forEach(entry => {
    const src = String(entry.src ?? '')
    if (alive(entry) && !ready(entry) && !skipped.some(item => item.src === src)) skipped.push({ src, reason: '文件不在（工作台账上记的路径找不到实体）' })
  })

  return {
    markdown: markdownOut === '' ? original : markdownOut,
    cover: coverPick,
    placed,
    kept: keptRefs.length,
    relocated: relocate ? tail.length : 0,
    skipped,
    notes,
  }
}
