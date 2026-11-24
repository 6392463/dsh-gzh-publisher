/**
 * 离线自检：不联网，只验证排版结构、账号表掩码、指纹稳定、工作台读取。
 * 用法：npm test（或 node tests/smoke.mjs）。工作台那段只读，没有数据会自动跳过。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync, appendFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  renderArticle, resolveSkin, listSkins, splitParagraph, migrateSkinKey, auditWechatSafe, textLength, clampText,
  SKINS, SKIN_FIELDS, SKIN_KEY_PATTERN, LEGACY_SKIN_KEYS,
} from '../src/layout.js'
import { createStore, normalizeComment } from '../src/store.js'
import { mask, hintOf, createClient, mimeOf, DIRECT_BASE } from '../src/wechat.js'
import { createMediaDesk } from '../src/media-desk.js'
import { planImages } from '../src/images.js'
import { registerTools } from '../src/tools.js'
import { createApiRoutes, ROUTE_PREFIX } from '../src/routes.js'

const sample = [
  '# 这是文章标题',
  '',
  '## 本文看点',
  '',
  '- 看点一，这条特别长特别长特别长特别长特别长用来检查截断处理是否正确',
  '- 看点二',
  '- 看点三',
  '- 看点四（应该被丢掉，线上只有三张卡）',
  '',
  '## INSIGHT｜第一节标题',
  '',
  '普通正文，带 ==下划线强调== 和 **主色加粗** 以及 `行内代码`，还有 <script>alert(1)</script> 这种必须转义的东西。',
  '',
  '![配图一说明](media-desk/files/g_mwrc0001.png)',
  '',
  '> 这是一句金句。',
  '',
  '## 第二节没有小标签',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '![外链图](https://mmbiz.qpic.cn/x/1?from=appmsg)',
  '',
  '随便一段收尾。',
].join('\n')

// 皮肤 key 是中性名（teal/sage/redwhite/graphite），老的名字通过 LEGACY_SKIN_KEYS 仍能解析
const skin = resolveSkin('teal').skin
const built = renderArticle({
  markdown: sample,
  skin,
  imageUrls: { 'media-desk/files/g_mwrc0001.png': 'https://mmbiz.qpic.cn/up/1.png', 'https://mmbiz.qpic.cn/x/1?from=appmsg': 'https://mmbiz.qpic.cn/x/1?from=appmsg' },
  foot: { intro: '我是 测试号，一个每天写一点的人。', cta: '点赞、在看、转发', closing: '我们下篇见。' },
  tail: { title: '资料领取', body: '后台回复关键词「RAG」领取资料包。' },
})

const { html } = built

/** 扫描 section 配对：balanced 表示嵌套闭合干净，roots 表示顶层并列块数。 */
function scan(text) {
  const tokens = text.match(/<\/?section\b/g) ?? []
  let depth = 0
  let roots = 0
  let balanced = true
  for (const token of tokens) {
    if (token.startsWith('</')) {
      depth -= 1
      if (depth === 0) roots += 1
      if (depth < 0) balanced = false
    } else {
      depth += 1
    }
  }
  return { balanced: balanced && depth === 0, roots }
}
const checks = []
const check = (label, ok, extra = '') => { checks.push({ label, ok, extra }); assert.ok(ok, `${label} ${extra}`) }

check('标题取自一级标题', built.title === '这是文章标题', built.title)
check('看点只留三张', built.stats.outlineCards === 3, String(built.stats.outlineCards))
check('看点长文截断', html.includes('…</p>'), '')
check('看点标签文案', html.includes('📌 本文看点'))
check('首节上边距 16px', html.includes('margin-top:16px'))
check('次节上边距 48px', html.includes('margin-top:48px'))
check('显式小标签 INSIGHT', html.includes('>INSIGHT<'))
check('缺省小标签自动补 WHY', html.includes('>WHY<'))
check('三张编号 01/02/03', html.includes('>01<') && html.includes('>02<') && html.includes('>03<'))
check('正文两端对齐 15px/1.8', html.includes('font-size:15px;line-height:1.8;text-align:justify;'))
check('下划线强调', html.includes('border-bottom:2px solid #C3DFCE'))
check('主色加粗', html.includes('<strong style="color:#3F7D58;">主色加粗</strong>'))
check('行内代码片', html.includes('background:#F3F4F6;color:#1F2937'))
check('尖括号转义', html.includes('&lt;script&gt;') && !html.includes('<script>'))
check('列表项是独立行带手写圆点', html.includes('>•<') && html.includes('列表项一') && !html.includes('• 列表项一'))
check('金句卡片', html.includes('border-left:4px solid #3F7D58') && html.includes('这是一句金句'))
check('图片卡片带上传后的地址', html.includes('src="https://mmbiz.qpic.cn/up/1.png"'))
check('END 渐隐分隔', html.includes('linear-gradient(to right,transparent,#3F7D58)') && html.includes('END'))
check('落款两段', html.includes('我是 测试号') && html.includes('点赞、在看、转发'))
check('资料领取尾巴是根 section 的兄弟节点', scan(html).balanced && scan(html).roots === 2, JSON.stringify(scan(html)))
check('不产出 leaf 包装', !html.includes('leaf'))
check('段落数 2（列表不再算段落）', built.stats.paragraphs === 2, String(built.stats.paragraphs))
check('列表 1 个 2 项', built.stats.lists === 1 && built.stats.listItems === 2, JSON.stringify(built.stats))
check('图片数 2', built.stats.images === 2, String(built.stats.images))
check('无告警', built.warnings.length === 0, JSON.stringify(built.warnings))

// 缺图：必须丢掉并告警，不能把本地路径写进微信正文
const noUpload = renderArticle({ markdown: sample, skin })
check('缺图告警', noUpload.warnings.some(text => text.includes('配图未上传')))
check('缺图不进正文', !noUpload.html.includes('media-desk/files/'), '')
check('缺图统计', noUpload.stats.droppedImages === 2 && noUpload.stats.images === 0, JSON.stringify(noUpload.stats))
check('没有尾巴时只有一个顶层块', scan(noUpload.html).roots === 1, JSON.stringify(scan(noUpload.html)))

// ── P0-1 · 列表 / 表格 / 代码块 / 分割线 / 四级小标题 ────────────────────
// 微信编辑器会吃掉 <ul>/<ol> 的 list-style、把 <table> 的样式还原得七零八落，
// 所以这些结构全部重排成 flex 行；这里锁住「编号不丢、缩进不丢、原样符号不漏进正文」。
const rich = [
  '---',
  'title: 这段 front matter 不该出现在正文里',
  'date: 2026-11-23',
  '---',
  '',
  '# 结构化语法自检',
  '',
  '## 第一节',
  '',
  '1. 第一件要做的事',
  '2. 第二件要做的事',
  '   1. 第二项里的子步骤',
  '',
  '#### 小节标题（以前把 #### 原样推出去）',
  '',
  '- 无序项一',
  '  - 更细一层（缩进两级）',
  '  这一行是缩进续行，应该接在上一项后面',
  '',
  '| 方案 | 成本 | 结论 |',
  '| --- | --- | --- |',
  '| 直接改 | 低 | 先上 |',
  '| 重写 | 高 | 以后 |',
  '',
  '```js',
  'function 排版(稿子) {',
  '  return 稿子',
  '}',
  '```',
  '',
  '下面是一条自己写的分割线：',
  '',
  '---',
  '',
  '收尾段。',
].join('\n')
const richBuilt = renderArticle({ markdown: rich, skin })
const richHtml = richBuilt.html
check('front matter 不进正文并留提示', !richHtml.includes('这段 front matter 不该出现在正文里')
  && richBuilt.warnings.some(text => text.includes('front matter')), JSON.stringify(richBuilt.warnings))
check('有序列表保留编号', richHtml.includes('>01.<') && richHtml.includes('>02.<'), '')
check('子层序号各自从头数', (richHtml.match(/>01\.<\/span>/g) ?? []).length === 2, String((richHtml.match(/>01\.<\/span>/g) ?? []).length))
check('不用原生列表标签', !/<(ul|ol|li)\b/.test(richHtml), '')
check('二级圆点与缩进续行合并', richHtml.includes('>–<') && richHtml.includes('更细一层（缩进两级） 这一行是缩进续行'), '')
check('四级小标题不再漏 ####', richHtml.includes('padding-left:10px;font-size:16px;font-weight:800') && !richHtml.includes('####'), '')
check('表格渲染成 flex 行', richHtml.includes('>方案<') && richHtml.includes('>直接改<') && !/<table\b/.test(richHtml), '')
check('表格表头带主色下边线', richHtml.includes(`background:${skin.cardBg};border-bottom:2px solid ${skin.accent}`), '')
check('表格第二行斑马纹', richHtml.includes(`display:flex;background:${skin.cardBg};border-bottom:1px solid`), '')
check('代码块标语言且保留缩进', richHtml.includes('>JS<') && richHtml.includes('&nbsp;&nbsp;return'), '')
const blankCode = renderArticle({ markdown: ['# t', '', '## s', '', '```', 'first', '', 'last', '```'].join('\n'), skin })
check('代码块里的空行不塌', blankCode.html.includes('word-break:break-all;">&nbsp;</p>'), '')
check('正文里的 --- 出一条细线', richHtml.includes('width:56px'), '')
check('富文本统计对得上', richBuilt.stats.lists === 2 && richBuilt.stats.listItems === 5
  && richBuilt.stats.tables === 1 && richBuilt.stats.tableRows === 2
  && richBuilt.stats.codeBlocks === 1 && richBuilt.stats.subheads === 1
  && richBuilt.stats.dividers === 1, JSON.stringify(richBuilt.stats))
check('富文本结构闭合干净', scan(richHtml).balanced, JSON.stringify(scan(richHtml)))
const wideTable = renderArticle({ markdown: ['# t', '', '## s', '', '| a | b | c | d | e |', '| - | - | - | - | - |', '| 1 | 2 | 3 | 4 | 5 |'].join('\n'), skin })
check('超过 4 列的表格会提示', wideTable.warnings.some(text => text.includes('手机上会很挤')), JSON.stringify(wideTable.warnings))
const brokenFence = renderArticle({ markdown: ['# t', '', '## s', '', '```', '没闭合的代码', ''].join('\n'), skin })
check('未闭合围栏不吞掉后文', brokenFence.html.includes('没闭合的代码')
  && brokenFence.warnings.some(text => text.includes('没有闭合')), JSON.stringify(brokenFence.warnings))

// ── P0-2 · 截断按「字」算：emoji 不能按 UTF-16 单元翻倍，也不能劈开代理对 ──
const emojiText = '🚀 我用 AI 写了 30 篇文章🔥'
check('长度按码点算', textLength(emojiText) === [...emojiText].length, String(textLength(emojiText)))
check('截断不劈开 emoji（不产生乱码）', !clampText(emojiText, 4).includes('�') && textLength(clampText(emojiText, 4)) === 4, clampText(emojiText, 4))
check('截断补省略号且总长不超', clampText('一二三四五', 3) === '一二…' && textLength(clampText(emojiText, 4)) <= 4, clampText('一二三四五', 3))
check('没超长不加省略号', clampText('一二三', 5) === '一二三', clampText('一二三', 5))
check('空标题不炸', textLength('') === 0 && clampText(null, 5) === '', '')

// ── P0-3 · 推前体检：站外链接与非图床配图（个人订阅号外链点不开） ────────
const dirtyHtml = '<section><p><a href="https://example.com/post">点我</a></p>'
  + '<img src="https://cdn.other.com/a.png">'
  + '<img src="https://mmbiz.qpic.cn/up/1.png">'
  + '<a href="https://mp.weixin.qq.com/s/abc">另一篇公众号文章</a>'
  + '<a href="#anchor">目录锚点</a>'
  + '<a href="javascript:alert(1)">坏链接</a>'
  + '<a href="https://example.com/post">重复的同一个链接</a></section>'
const audit = auditWechatSafe(dirtyHtml)
const auditValues = audit.findings.map(item => item.value).join('|')
check('非图床配图被抓', audit.findings.some(item => item.kind === 'image' && item.value.includes('cdn.other.com')), auditValues)
check('站外链接被抓', audit.findings.some(item => item.kind === 'link' && item.value === 'https://example.com/post'), auditValues)
check('图床与公众号链接放行', !auditValues.includes('mmbiz.qpic.cn') && !auditValues.includes('mp.weixin.qq.com'), auditValues)
check('锚点链接不算外链', !auditValues.includes('#anchor'), auditValues)
check('javascript: 链接被抓', audit.findings.some(item => item.kind === 'link' && item.value.startsWith('javascript:')), '')
check('同一问题只报一次', audit.findings.filter(item => item.value === 'https://example.com/post').length === 1, JSON.stringify(audit.findings))
check('干净正文零告警', auditWechatSafe('<section><p><img src="https://mmbiz.qpic.cn/x/1.png"></p><p>纯文字。</p></section>').findings.length === 0, '')

// ── P0-4 · 评论开关归一化（面板给布尔，模型可能给字符串） ──────────────────
check('comment 认字符串真假', JSON.stringify(normalizeComment({ open: 'false', fansOnly: '1' })) === '{"open":false,"fansOnly":true}', JSON.stringify(normalizeComment({ open: 'false', fansOnly: '1' })))
check('comment 空值等于不存（回到微信默认）', normalizeComment('') === null && normalizeComment({}) === null && normalizeComment(false) === null)
check('comment 乱填直接报错', (() => { try { normalizeComment({ open: 'maybe' }); return false } catch { return true } })())
check('comment 不是对象直接报错', (() => { try { normalizeComment([1, 2]); return false } catch { return true } })())

// ── P0-5 · 上传按扩展名声明 MIME（以前一律谎报 image/png） ────────────────
check('jpg 声明 image/jpeg', mimeOf('cover.jpg') === 'image/jpeg', mimeOf('cover.jpg'))
check('png/gif/webp 各归各', mimeOf('a.png') === 'image/png' && mimeOf('a.gif') === 'image/gif' && mimeOf('a.webp') === 'image/webp', '')
check('认不出的扩展名按 jpg', mimeOf('noext') === 'image/jpeg' && mimeOf('A.PNG') === 'image/png', '')
check('48001 讲清个人订阅号没权限', hintOf({ errcode: 48001 }).includes('个人订阅号'), hintOf({ errcode: 48001 }))

// 四套皮肤都能渲染，且配色互不相同
const skins = Object.keys(SKINS)
for (const name of skins) {
  const each = renderArticle({ markdown: sample, skin: resolveSkin(name).skin, imageUrls: {} })
  check(`皮肤 ${name} 渲染`, each.html.includes(SKINS[name].accent) && each.html.length > 3000)
}
check('四套主色互不相同', new Set(skins.map(name => SKINS[name].accent)).size === skins.length)
const custom = resolveSkin({ layout: 'account-a', skin: { accent: '#000000' } })
check('皮肤可覆盖（老名字自动解析到中性 key）', custom.skin.accent === '#000000' && custom.name === 'teal' && custom.unknown.length === 0, JSON.stringify(custom))
check('未知皮肤字段被点名', resolveSkin({ layout: 'x', skin: { nope: 1 } }).unknown.join() === 'nope')
check('坏配色进不了皮肤', (() => {
  const r = resolveSkin({ layout: 'teal', skin: { accent: 'red"><b>x' } })
  return r.skin.accent === SKINS.teal.accent && r.invalid.join() === 'accent'
})())
check('未知皮肤名退回指定默认', (() => {
  const r = resolveSkin({ layout: 'nope' }, { fallback: 'sage', custom: {} })
  return r.name === 'sage' && r.skin.accent === SKINS.sage.accent
})())
check('自定义皮肤参与解析并补基线', (() => {
  const r = resolveSkin({ layout: 'mine' }, { custom: { mine: { label: '我的', accent: '#123456' } } })
  return r.name === 'mine' && r.skin.accent === '#123456' && r.skin.label === '我的'
    && resolveSkin({ layout: 'm2' }, { custom: { m2: { accent: '#123456' } } }).skin.heading === SKIN_FIELDS.heading
})())
// 老皮肤名 → 中性 key：账号表迁移、以及用户手输老名字，两条路都靠它
check('老皮肤名映射', Object.entries(LEGACY_SKIN_KEYS)
  .every(([from, to]) => migrateSkinKey(from) === to))
check('中性名与未知名原样返回', migrateSkinKey('teal') === 'teal' && migrateSkinKey('mine-x') === 'mine-x')
check('皮肤 key 只收安全字符', SKIN_KEY_PATTERN.test('my-skin_1') && !SKIN_KEY_PATTERN.test('My Skin')
  && !SKIN_KEY_PATTERN.test('a') && !SKIN_KEY_PATTERN.test('张'))
check('皮肤列表内置在前且带 builtIn', (() => {
  const rows = listSkins({ mine: { label: '我的', accent: '#123456' } })
  return rows.length === Object.keys(SKINS).length + 1 && rows.at(-1).key === 'mine'
    && rows.at(-1).builtIn === false && rows[0].builtIn === true
})())

// 段落切分：一行一句的口播稿不能整篇挤成一个 <p>（这就是「推上去没排版」的根因）
check('空行分段', splitParagraph([{ text: '一', br: false }, { text: '二', br: false }]).length === 2)
check('单换行默认分段', splitParagraph([{ text: '第一句结束了。', br: false }, { text: '第二句另起。', br: false }]).length === 2)
check('行尾悬挂则接续', (() => {
  const seg = splitParagraph([{ text: '这件事的关键，', br: false }, { text: '不在于工具。', br: false }])
  return seg.length === 1 && seg[0].length === 2
})())
check('两个空格是软换行', (() => {
  const seg = splitParagraph([{ text: '上半句  ', br: true }, { text: '下半句', br: false }])
  return seg.length === 1 && seg[0][0].br === true
})())
check('英文换行不硬切', splitParagraph([{ text: 'the model is good', br: false }, { text: 'enough for daily work', br: false }]).length === 1)
const softBreak = renderArticle({ markdown: '第一行没有标点\n第二行接着说。\n\n另起一段。', skin })
check('一行一句就是一段', softBreak.stats.paragraphs === 3, JSON.stringify(softBreak.stats))

// 没有 ## 分节时不能炸
const flat = renderArticle({ markdown: '只有一段，没有任何标题。', skin })
check('无分节仍产出 HTML', flat.html.includes('只有一段') && flat.warnings.some(text => text.includes('分节')))

/* ---------------- 账号表 / 皮肤表 / 渲染台账 ---------------- */
const dir = mkdtempSync(join(tmpdir(), 'gzh-test-'))
try {
  const store = createStore({ dir })
  const saved = store.writeAccount('my-gzh', {
    name: '我的日更号', appid: 'wx1234567890abcdef', appsecret: 'supersecretvalue999',
    proxyUrl: 'https://proxy.example.com/wxproxy', proxyToken: 'token-abcdef123456', author: '我',
    layout: 'account-c', tail: { title: '资料领取', body: '后台回复「RAG」' },
  })
  const dumped = JSON.stringify(saved)
  check('掩码不回显 appsecret', !dumped.includes('supersecretvalue999'), dumped)
  check('掩码不回显 proxyToken', !dumped.includes('token-abcdef123456'))
  check('掩码露尾 4 位', saved.appsecret.endsWith('e999') && saved.proxyToken.endsWith('3456'), `${saved.appsecret} ${saved.proxyToken}`)
  check('presence 标记', saved.hasAppsecret === true && saved.hasProxyToken === true)
  check('盘上存原文', store.readAccounts()['my-gzh'].appsecret === 'supersecretvalue999')
  check('改一个字段不丢其他', store.writeAccount('my-gzh', { author: '张三' }).name === '我的日更号')
  check('空串删字段', store.writeAccount('my-gzh', { author: '' }).author === undefined)
  let threw = ''
  try { store.writeAccount('My GZH', {}) } catch (error) { threw = error.message }
  check('非法 key 被拒', threw.includes('不合法'), threw)
  threw = ''
  try { store.writeAccount('my-gzh', { appId: 'typo' }) } catch (error) { threw = error.message }
  check('未知字段被拒', threw.includes('未知字段'), threw)

  // 老配置迁移：装上新版本后第一次激活就把老皮肤名换成中性 key，且可反复执行
  check('迁移前是老名字', store.readAccounts()['my-gzh'].layout === 'account-c')
  const moved = store.migrateAccounts()
  check('迁移报告点名', moved.length === 1 && moved[0].key === 'my-gzh' && moved[0].from === 'account-c' && moved[0].to === 'redwhite', JSON.stringify(moved))
  check('迁移写进盘', store.readAccounts()['my-gzh'].layout === 'redwhite')
  check('迁移幂等', store.migrateAccounts().length === 0)

  // 自定义皮肤：新建 / 合并改 / 不许覆盖内置 / 不许乱 key / 不许乱配色
  const written = store.writeSkin('mine', { label: '我的', accent: '#123456' })
  check('写入自定义皮肤', written.accent === '#123456' && store.readSkins().mine.label === '我的')
  check('再写是合并不是覆盖', store.writeSkin('mine', { heading: '#000000' }).accent === '#123456' && store.readSkins().mine.label === '我的')
  threw = ''
  try { store.writeSkin('teal', { accent: '#000000' }) } catch (error) { threw = error.message }
  check('内置皮肤不可覆盖', threw.includes('内置皮肤名'), threw)
  threw = ''
  try { store.writeSkin('Bad Name', {}) } catch (error) { threw = error.message }
  check('皮肤 key 校验', threw.includes('不合法'), threw)
  threw = ''
  try { store.writeSkin('mine', { accent: 'red' }) } catch (error) { threw = error.message }
  check('配色必须十六进制', threw.includes('#RRGGBB') && threw.includes('accent'), threw)
  threw = ''
  try { store.writeSkin('mine', { accent: 'red" onclick="alert(1)' }) } catch (error) { threw = error.message }
  check('想从 style 属性跳出去的写法被拒', threw.includes('#RRGGBB'), threw)
  threw = ''
  try { store.writeSkin('ghost-skin', {}) } catch (error) { threw = error.message }
  check('给新皮肤传空补丁被拒', threw.includes('没有要写入'), threw)
  check('对已有皮肤传空补丁是无害空操作', store.writeSkin('mine', {}).accent === '#123456')
  check('内置皮肤不可删', store.deleteSkin('teal').removed === false)
  check('删除自定义皮肤', store.deleteSkin('mine').removed === true && store.readSkins().mine === undefined)
  check('删不存在的皮肤不炸', store.deleteSkin('ghost').removed === false)

  // 渲染台账：推送时靠它证明「推的就是这次排版出来的那份」
  const entry = store.appendRender({ sha: 'a'.repeat(64), account: 'my-gzh', title: 'T', file: join(dir, 'a.html'), previewFile: join(dir, 'a-preview.html'), layout: 'teal' })
  check('appendRender 回带 renderId/at', typeof entry.renderId === 'string' && entry.renderId.length > 0 && typeof entry.at === 'string', JSON.stringify(entry))
  check('findRender 精确与前缀都认', store.findRender(entry.renderId) !== null && store.findRender(entry.renderId.slice(0, 5)) !== null)
  check('findRender 找不到返回 null', store.findRender('ffffffffffff') === null)
  check('渲染台账只留最近 100 条', (() => {
    for (let i = 0; i < 120; i += 1) store.appendRender({ sha: `c${i}`, account: 'my-gzh', title: `T${i}`, file: join(dir, `c${i}.html`) })
    return store.readRenders().length === 100
  })())

  const fp = store.fingerprint({ account: 'my-gzh', title: 'T', content: '<section/>' })
  check('指纹稳定', fp === store.fingerprint({ account: 'my-gzh', title: 'T', content: '<section/>' }) && fp.length === 16)
  check('指纹区分账号', fp !== store.fingerprint({ account: 'other-gzh', title: 'T', content: '<section/>' }))
  store.appendLedger({ fingerprint: fp, account: 'my-gzh', title: 'T', mediaId: 'M1' })
  check('台账可读', store.readLedger()[0].mediaId === 'M1')
  check('删账号', store.deleteAccount('my-gzh') === true && store.deleteAccount('my-gzh') === false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

/* ---------------- 工作台读取（只读真机数据） ---------------- */
const desk = createMediaDesk({ dir: process.env.GZH_MEDIA_DESK || undefined })
const listed = desk.list()
console.log(`media-desk: ${listed.missing ? '没有 state.json' : `${listed.items.length} 条有正文的产出`} @ ${listed.stateFile}`)
if (!listed.missing && listed.items.length > 0) {
  const one = desk.read(listed.items[0].id)
  console.log(`  样本：${one.title}｜${Buffer.byteLength(one.markdown)}B｜图 ${one.images.length} 张，本地可用 ${one.images.filter(image => image.localPath !== '').length} 张`)
  const bad = one.images.filter(image => image.localPath === '' && image.kind === 'local')
  check('本地素材路径可解析（或明确报缺失）', Array.isArray(bad))
  check('列表条目告知有没有落盘的 md', typeof listed.items[0].hasSavedMarkdown === 'boolean')
  check('read 把落盘 md 的位置一并交出', 'savedMarkdownPath' in one && 'savedMarkdownBytes' in one)
  if (one.savedMarkdownPath !== '') {
    const saved = desk.findSavedMarkdown(one.savedMarkdownPath, one.title)
    check('落盘 md 能读回来（工作台只有 state 时的退路）',
      saved !== null && saved.path === one.savedMarkdownPath && saved.markdown.length > 0, String(one.savedMarkdownPath))
  }
}
check('没有落盘路径时 findSavedMarkdown 返回 null', desk.findSavedMarkdown('') === null && desk.findSavedMarkdown(join(tmpdir(), 'nope-xyz')) === null)

/* ---------------- 客户端构造（不发请求） ---------------- */
const viaProxy = createClient({ baseUrl: 'https://proxy.example.com/wxproxy/', token: 't', appid: 'a', secret: 's' })
check('代理地址去尾斜杠', viaProxy.endpoint === 'https://proxy.example.com/wxproxy' && viaProxy.direct === false, viaProxy.endpoint)
const direct = createClient({ baseUrl: '', appid: 'a', secret: 's' })
check('留空走直连', direct.endpoint === DIRECT_BASE && direct.direct === true)
check('掩码短值', mask('abc') === '****' && mask('abcdefghij').endsWith('ghij') && mask('') === '')
check('40164 有处置建议', hintOf({ errcode: 40164 }).includes('IP 白名单'))
check('未知错误码无建议', hintOf({ errcode: 99999 }) === '')

/* ---------------- 压图（真跑子进程，不联网） ---------------- */
const { compressImage, compressorStatus } = await import('../src/image.js')
const imgDir = mkdtempSync(join(tmpdir(), 'gzh-img-'))
check('压缩脚本随包存在', compressorStatus({}).scriptFound === true, compressorStatus({}).script)

/** 造一张噪声 PNG：不可压缩，一定超 1MB，拿来当 fixture 最稳。 */
function bigNoisePng(width, height) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  let state = 0x9e3779b9
  const rnd = () => {
    // xorshift32，取高位；LCG 的低 8 位周期太短，噪声会退化成可压缩的条纹
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state |= 0
    return (state >>> 8) & 0xff
  }
  for (let i = 0; i < raw.length; i += 1) raw[i] = i % stride === 0 ? 0 : rnd()
  const chunk = (type, data) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const fixture = join(imgDir, 'noise.png')
writeFileSync(fixture, bigNoisePng(1200, 900))
const fixtureBytes = statSync(fixture).size
check('fixture 确实超 1MB（否则这条测试没意义）', fixtureBytes > 1048576, `${(fixtureBytes / 1048576).toFixed(2)}MB`)
const squeezed = await compressImage(fixture, { outDir: join(imgDir, 'out'), maxBytes: 1048576, maxEdge: 1440 })
if (squeezed.error.includes('Pillow') || squeezed.error.includes('没找到')) {
  console.log(`  跳过实压：${squeezed.error}`)
} else {
  check('超 1MB 的图能压进预算', squeezed.ok === true && squeezed.bytes > 0 && squeezed.bytes <= 1048576,
    `${(fixtureBytes / 1048576).toFixed(2)}MB → ${(squeezed.bytes / 1048576).toFixed(2)}MB q${squeezed.quality} ${squeezed.width}×${squeezed.height} ${squeezed.error}`)
  const again = await compressImage(fixture, { outDir: join(imgDir, 'out'), maxBytes: 1048576, maxEdge: 1440 })
  check('同图同预算命中压缩缓存', again.ok === true && again.cached === true && again.path === squeezed.path, again.path)
  check('压缩器状态可上报（无损 JSON）', losslessViolations(compressorStatus({})).length === 0, JSON.stringify(compressorStatus({})).slice(0, 120))
}

// 真素材：工作台的 PNG 目前 1.5–2.4MB，正是这条链路要解决的
if (!listed.missing && listed.items.length > 0) {
  const real = desk.read(listed.items[0].id).images.find(image => image.localPath !== '')
  if (real !== undefined) {
    const before = statSync(real.localPath).size
    const out = await compressImage(real.localPath, { outDir: join(imgDir, 'out'), maxBytes: 1048576, maxEdge: 1440 })
    if (out.error.includes('Pillow') || out.error.includes('没找到')) {
      console.log(`  跳过真素材压图：${out.error}`)
    } else {
      check('工作台真实配图能压进 1MB', out.ok === true && out.bytes <= 1048576,
        `${real.localPath.split(/[\\/]/).pop()} ${(before / 1048576).toFixed(2)}MB → ${(out.bytes / 1048576).toFixed(2)}MB q${out.quality} ${out.width}×${out.height} ${out.error}`)
    }
  }
}
rmSync(imgDir, { recursive: true, force: true })

/* ---------------- 工具注册契约（复刻宿主 0.2.x 的 output 校验） ---------------- */
// 这个 DSH 版本在 ctx.tools.register 里强制 output { schema, render, presentationMeta? }，
// 并且会用 output.schema 校验 execute 的返回值（返回值先做无损 JSON 快照，再 deepFreeze）。
// 这里把同样的规则复刻一遍，保证下次改工具时不会又在激活阶段炸掉。
const SUPPORTED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
function schemaViolations(node, path = 'schema', out = []) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    out.push(`${path} must be a schema object`)
    return out
  }
  for (const key of Object.keys(node)) if (!SUPPORTED.has(key)) out.push(`${path}.${key} is not a supported keyword`)
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') out.push(`${path}.additionalProperties must be a boolean`)
  if (Object.hasOwn(node, 'type') && Object.hasOwn(node, 'oneOf')) out.push(`${path} cannot declare both type and oneOf`)
  for (const [key, child] of Object.entries(node.properties ?? {})) schemaViolations(child, `${path}.properties.${key}`, out)
  if (node.items !== undefined) schemaViolations(node.items, `${path}.items`, out)
  return out
}
/** 宿主 snapshotJsonValue 的等价检查：undefined / NaN / Infinity / 函数 / bigint 都不能出现在返回值里。 */
function losslessViolations(value, path = 'value', out = []) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') out.push(`${path} 不是无损 JSON`)
  else if (typeof value === 'number' && !Number.isFinite(value)) out.push(`${path} 是 ${value}`)
  else if (Array.isArray(value)) value.forEach((entry, index) => losslessViolations(entry, `${path}[${index}]`, out))
  else if (value !== null && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => losslessViolations(entry, `${path}.${key}`, out))
  return out
}

const toolNames = ['gzh_account_list', 'gzh_account_set', 'gzh_account_remove', 'gzh_skin_list', 'gzh_skin_set', 'gzh_skin_remove',
  'gzh_config_get', 'gzh_media_desk', 'gzh_layout_preview', 'gzh_render', 'gzh_push_draft', 'gzh_draft_verify']
const registered = new Map()
const fakeCtx = {
  logger: { info() {} },
  tools: {
    register(definition) {
      const output = definition.output
      if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function'
        || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
        throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`)
      }
      const bad = schemaViolations(output.schema)
      if (bad.length > 0) throw new TypeError(`tool "${definition.name}" output.schema: ${bad.join('; ')}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
}
const toolDir = mkdtempSync(join(tmpdir(), 'gzh-tools-'))
const toolStore = createStore({ dir: toolDir })
const settings = () => ({
  enabled: true, defaultAccount: '', defaultLayout: 'account-a', dataDir: toolDir,
  autoDigest: true, allowDirectApi: false, maxImageMb: 1, timeoutMs: 60000,
})
const api = registerTools(fakeCtx, { config: settings, store: toolStore, desk, log() {} })
check('12 个工具都通过宿主的 output 注册校验', registered.size === 12 && toolNames.every(name => registered.has(name)), [...registered.keys()].join(','))
check('registerTools 交出 disposers / names / call 三件套',
  api.disposers.length === 12 && api.names().length === 12 && typeof api.call === 'function',
  `${api.disposers.length} / ${api.names().length}`)
check('面板用的 call 与工具走同一份实现', (await api.call('gzh_account_list', {})).ok === true)
let unknownAction = ''
try {
  await api.call('gzh_no_such', {})
} catch (cause) {
  unknownAction = cause.message
}
check('call 拒绝白名单外的动作', unknownAction.includes('没有这个动作') && unknownAction.includes('gzh_push_draft'), unknownAction)

const listTool = registered.get('gzh_account_list')
const listed0 = await listTool.execute({})
check('account_list 返回值是无损 JSON', losslessViolations(listed0).length === 0, losslessViolations(listed0).join('; '))
const blocks = listTool.output.render({}, JSON.parse(JSON.stringify(listed0)))
check('output.render 产出 text ContentBlock', Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text'
  && typeof blocks[0].text === 'string' && blocks[0].text.includes('"ok":true'), JSON.stringify(blocks).slice(0, 60))
// 皮肤 CRUD 走的是工具层（面板设置里的按钮最终就是这些）
check('工具层能建皮肤', (await api.call('gzh_skin_set', { skin: 'test-skin', label: '测试', accent: '#123456' })).skin.accent === '#123456')
check('皮肤列表含自定义项', (await api.call('gzh_skin_list', {})).skins.some(row => row.key === 'test-skin' && row.builtIn === false))
check('删皮肤返回 removed', JSON.stringify(await api.call('gzh_skin_remove', { skin: 'test-skin' })).includes('removed'))
/** 期望调用失败，返回错误文案（这些闸门必须在联网之前就拦住，所以能离线测）。 */
async function callFail(tool, args) {
  try {
    await api.call(tool, args)
    return ''
  } catch (cause) {
    return `${cause.message} ${cause.hint ?? ''}`
  }
}
check('覆盖内置皮肤会被工具层拒绝', (await callFail('gzh_skin_set', { skin: 'teal', accent: '#000000' })).includes('内置皮肤名'))
check('config_get 是只读视图且不含密钥', await (async () => {
  const conf = await api.call('gzh_config_get', {})
  const dumped = JSON.stringify(conf)
  return conf.editableAt.includes('配置') && conf.hints.defaultLayout !== undefined
    && !dumped.includes('appsecret') && !dumped.includes('proxyToken')
})())
check('config_get 报告压缩引擎状态', (await api.call('gzh_config_get', {})).engine.ready !== undefined)
/* 渲染 → 推送 这条闸门：需求里「推上去没排版」就靠这三步钉死 */
toolStore.writeAccount('gzh-test', {
  name: '测试号', appid: 'wxabc', appsecret: 'secret-value', proxyUrl: 'http://127.0.0.1:9',
  proxyToken: 'proxy-token', author: '测试作者', digest: '这是摘要',
})
/* 标题优先级：显式 title > 正文里的 # > 来源标题（条目标题 / 文件名）。
   以前来源标题在解析前就顶上去，解析器认为标题已知后把每个 `#` 行都丢掉 ——
   用户写在稿子里的标题从正文里悄悄消失，标题栏里还得寸进尺地变成账号名。 */
const ownTitle = await api.call('gzh_render', { account: 'gzh-test', markdown: '# 正文自己的标题\n\n第一段。\n\n## 一、节\n\n第二段。', upload: false })
check('标题取正文里的 #，不是账号名', ownTitle.title === '正文自己的标题', ownTitle.title)
check('正文里的 # 之外的内容一个字没丢', ownTitle.stats.paragraphs === 2 && readFileSync(ownTitle.file, 'utf8').includes('第二段'), JSON.stringify(ownTitle.stats))
const bareFile = join(toolDir, '另一篇稿子.md')
writeFileSync(bareFile, '第一段。\n\n## 一、节\n\n第二段。', 'utf8')
const fromFile = await api.call('gzh_render', { account: 'gzh-test', markdownPath: bareFile, upload: false })
check('正文没有 # 时才用文件名当标题，并说明来源', fromFile.title === '另一篇稿子' && fromFile.warnings.some(w => w.includes('文件名')), `${fromFile.title} ${JSON.stringify(fromFile.warnings)}`)
const titledFile = join(toolDir, '稿子里有标题.md')
writeFileSync(titledFile, '# 稿子里写的标题\n\n第一段。', 'utf8')
check('文件名让位给正文里的 #', (await api.call('gzh_render', { account: 'gzh-test', markdownPath: titledFile, upload: false })).title === '稿子里写的标题')
check('粘贴的正文没有 # 时直接问，不拿账号名糊一个', (await callFail('gzh_render', { account: 'gzh-test', markdown: '只有正文，没有标题行。\n\n第二段。', upload: false })).includes('没有标题'))
check('显式 title 仍然是最大优先级', (await api.call('gzh_render', { account: 'gzh-test', markdown: '# 正文标题\n\n第一段。', title: '人给的标题', upload: false })).title === '人给的标题')

/* ── 配图规划：渲染之前把「哪张当封面、每张插在哪一节」真正决定下来 ──────────
   planImages 是纯函数（本地路径与内容指纹都由调用方注入），所以整套规则都能离线跑。 */
const absOf = src => `/abs/${src}`
const planRun = (md, images, opts = {}) => planImages({ markdown: md, images, resolveLocal: absOf, digestOf: path => path, ...opts })
const reg = (src, extra = {}) => ({ src, localPath: absOf(src), bytes: 1000, ...extra })
const imageLines = md => md.split('\n').filter(line => /^!\[/.test(line.trim()))
const FIVE = ['# 标题', '', '导语一段。', '', '## 第一节', '', '第一段正文。', '', '## 第二节', '', '第二段正文。', '', '## 第三节', '', '第三段正文。', '', '## 第四节', '', '第四段正文。']

// 真场景①：工作台导出的稿子把两张图甩在文末（用户的 脚本.md 就是这样）
const tailMd = [...FIVE, '', '![](a.png)', '', '![](b.png)', ''].join('\n')
const tailPlan = planRun(tailMd, [reg('a.png'), reg('b.png')])
check('末尾甩成一串的图挪回各节后面', tailPlan.placed.length === 2 && imageLines(tailPlan.markdown).length === 2, JSON.stringify(tailPlan.placed))
check('挪走后末尾不再是光秃秃的图片行', tailPlan.markdown.trimEnd().endsWith('第四段正文。'), JSON.stringify(tailPlan.markdown.slice(-50)))
check('挪图说明原因并给出关掉的办法', tailPlan.notes.some(note => note.includes('甩') && note.includes('autoPlace=false')), JSON.stringify(tailPlan.notes))
check('只有一张图在末尾不算甩尾，不去折腾', planRun([...FIVE, '', '![](a.png)'].join('\n'), [reg('a.png')]).relocated === 0, '')
// 真场景②：作者自己写了位置 —— 一个字都不动
const keptPlan = planRun('# 标题\n\n导语。\n\n## 第一节\n\n第一段。\n\n![](a.png)\n\n## 第二节\n\n第二段。\n', [reg('a.png')])
check('作者自己写的 ![]() 位置一个字都不动', keptPlan.placed.length === 0
  && keptPlan.markdown.indexOf('![](a.png)') > keptPlan.markdown.indexOf('第一段。')
  && keptPlan.markdown.indexOf('![](a.png)') < keptPlan.markdown.indexOf('## 第二节'), keptPlan.markdown)
// 真场景③：工作台的「## 第N张图：说明」占位标题
const slotMd = ['# 标题', '', '导语。', '', '## 第一张图：能交付的东西', '', '## 第二张图：掏钱场景', '', '正文。'].join('\n')
const slotPlan = planRun(slotMd, [reg('a.png'), reg('b.png')])
check('「第N张图」占位标题被图顶掉，标题后半句当图注', slotPlan.placed.length === 2
  && slotPlan.markdown.includes('![能交付的东西](a.png)') && !slotPlan.markdown.includes('第一张图'), JSON.stringify(slotPlan.placed))
check('图不够填占位时明说，不留「图会自己冒出来」的错觉', planRun(slotMd, [reg('a.png', { bytes: 5000 })]).notes
  .some(note => note.includes('占位') && note.includes('用完')), '')
// 去重：同一张图换名字、台账里两张内容一样、代码块里的假图
const dupPlan = planRun('# 标题\n\n导语。\n\n![](配图1.png)\n\n## 第一节\n\n正文。\n', [reg('配图1.png'), reg('files/g_dup.png', { localPath: absOf('配图1.png') })])
check('台账里的图和正文引用的是同一张（内容一样）就不重复插', dupPlan.placed.length === 0, JSON.stringify(dupPlan.placed))
const twinPlan = planRun(FIVE.join('\n'), [reg('a.png'), reg('files/g_twin.png', { localPath: absOf('a.png') })])
check('台账里两张内容一样的图只插一次并说明', twinPlan.placed.length === 1
  && twinPlan.skipped.some(item => item.reason.includes('同一张')), JSON.stringify({ placed: twinPlan.placed.length, skipped: twinPlan.skipped }))
const fencePlan = planRun(['# 标题', '', '```', '![](图.png)', '```', '', '## 第一节', '', '正文。'].join('\n'), [reg('b.png')])
check('代码块里的 ![]() 不当配图（不搬、不去重）', fencePlan.markdown.includes('```\n![](图.png)\n```')
  && fencePlan.placed.length === 1, JSON.stringify(fencePlan.placed))
// 坏数据：登记了但文件不在 / 生图失败
const gonePlan = planRun(FIVE.join('\n'), [reg('a.png'), reg('b.png', { localPath: '' })], { resolveLocal: src => (src === 'b.png' ? '' : absOf(src)) })
check('登记了但文件不在的图点名说清', gonePlan.skipped.some(item => item.src === 'b.png' && item.reason.includes('文件不在')), JSON.stringify(gonePlan.skipped))
const deadPlan = planRun(FIVE.join('\n'), [reg('a.png', { status: 'failed' })])
check('生图失败的条目既不插图也不当封面（路径还挂着也不碰）', deadPlan.placed.length === 0 && deadPlan.cover === null, JSON.stringify(deadPlan.cover))
// 分布：多张图不挤在同一节
const spreadPlan = planRun(FIVE.join('\n'), [reg('a.png'), reg('b.png', { bytes: 9_000_000 }), reg('c.png'), reg('d.png')])
check('插图均匀铺到不同节，不挤在同一节', spreadPlan.placed.length === 3
  && new Set(spreadPlan.placed.map(item => item.section)).size === 3, JSON.stringify(spreadPlan.placed))
check('图多的时候封面独占一张，正文不重复出现它', spreadPlan.skipped.some(item => item.src === 'b.png' && item.reason.includes('只拿去当封面')), JSON.stringify(spreadPlan.skipped))
check('图上登记的锚点对得上哪节就插那节', planRun(FIVE.join('\n'), [reg('a.png', { anchor: '第二节' })]).placed
  .every(item => item.section === '第二节' && item.reason.includes('锚点')), '')
// 封面
const coverPlan = planRun(FIVE.join('\n'), [reg('小图.png', { bytes: 100 }), reg('大图.png', { bytes: 9_000_000 }), reg('第三张.png')])
check('没登记封面时挑字节最大的一张，并说清凭什么', coverPlan.cover.src === '大图.png'
  && coverPlan.cover.reason.includes('字节最大') && coverPlan.cover.reason.includes('8.58MB'), JSON.stringify(coverPlan.cover))
const hintPlan = planRun(FIVE.join('\n'), [reg('封面.png', { bytes: 100 }), reg('大图.png', { bytes: 9_000_000 }), reg('三.png')])
check('文件名或图注写着「封面/主图」的优先当封面', hintPlan.cover.src === '封面.png' && hintPlan.cover.reason.includes('封面/主图'), JSON.stringify(hintPlan.cover))
check('工作台登记了 cover 就用人家的，不自作主张', planRun(FIVE.join('\n'), [reg('a.png')], { cover: { src: 'c.png', localPath: absOf('c.png') } }).cover.reason.includes('登记的封面'), '')
check('图本来就少时封面不独占，正文照样有图', coverPlan.cover.alsoInBody === false
  && planRun(FIVE.join('\n'), [reg('a.png', { bytes: 9_000_000 }), reg('b.png')]).placed.length === 2, '')
check('不知道图多大小时封面理由不写出 undefined', planRun(FIVE.join('\n'), [{ src: 'a.png', localPath: absOf('a.png') }, { src: 'b.png', localPath: absOf('b.png') }, { src: 'c.png', localPath: absOf('c.png') }]).cover.reason.includes('undefined') === false, '')
// 关掉自动插图
const offMd = [...FIVE, '', '![](a.png)', '', '![](b.png)'].join('\n')
const offPlan = planRun(offMd, [reg('a.png'), reg('b.png'), reg('c.png')], { autoPlace: false })
check('autoPlace=false 时正文一个字不动', offPlan.markdown === offMd && offPlan.placed.length === 0, JSON.stringify(offPlan.placed))
check('关掉自动插图也说清哪几张本来能用', offPlan.skipped.some(item => item.src === 'c.png' && item.reason.includes('autoPlace=false')), JSON.stringify(offPlan.skipped))

// 图注要真的排出来（alt 就是图注，以前直接被丢掉）
const capMd = '# 标题\n\n正文。\n\n![这张是图注](https://mmbiz.qpic.cn/a.png)\n'
const capUrls = { 'https://mmbiz.qpic.cn/a.png': 'https://mmbiz.qpic.cn/a.png' }
const captioned = renderArticle({ markdown: capMd, skin, imageUrls: capUrls })
check('图注排成图下面居中的小字', captioned.html.includes('这张是图注') && captioned.html.includes('text-align:center'), captioned.html.slice(0, 200))
const bareImage = renderArticle({ markdown: capMd.replace('![这张是图注]', '![]'), skin, imageUrls: capUrls })
check('没有图注时不多出图注节点（老产物字节不变）', !bareImage.html.includes('font-size:13px;line-height:1.6;color:#8A8F99') && !bareImage.html.includes('这张是图注'), '')

/* 「配图 0 张」的静默丢失。两个真场景：
   ① state.json 那份正文里没有一行 ![]()，图只登记在条目的 images 里 → 必须说破；
   ② 工作台导出的 .md 里写的是 `![](配图9.png)` 这种相对路径 → 得按稿子所在目录去找。 */
const deskDir = mkdtempSync(join(tmpdir(), 'gzh-desk-'))
mkdirSync(join(deskDir, 'files'), { recursive: true })
// 1×1 的合法 PNG，够 resolveAsset + statSync 用
const pngBytes = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000002000100ffff03000006000554bf2ead0000000049454e44ae426082', 'hex')
writeFileSync(join(deskDir, '配图9.png'), pngBytes)
// 工作台导出时会把图复制一份进条目目录：同一张图、两个寻址方式，提醒不能只按文件名比
writeFileSync(join(deskDir, '另一份.png'), pngBytes)
writeFileSync(join(deskDir, 'files', 'g_dup.png'), pngBytes)
const deskLong = '第一段要长过八十个字，media-desk 那条 publishable 才认这篇有正文；顺便把分节和配图之外的结构也走一遍，免得 fixture 太短测不到东西。'
writeFileSync(join(deskDir, '稿子.md'), `# 稿子里的标题\n\n${deskLong}\n\n![](配图9.png)\n\n![](另一份.png)\n\n## 一、节\n\n第二段。\n`, 'utf8')
writeFileSync(join(deskDir, 'state.json'), JSON.stringify({
  items: [{
    id: 'it_fixture', updatedAt: 1,
    production: {
      title: '稿子里的标题', stage: 'done',
      article: `# 稿子里的标题\n\n${deskLong}\n\n## 一、节\n\n第二段。\n`,
      images: [{ src: '配图9.png', status: 'done' }, { src: 'media-desk/files/g_dup.png', status: 'done' }, { src: 'media-desk/files/g_missing.png', status: 'done' }],
      savedPath: deskDir,
    },
  }],
}), 'utf8')
const fixtureStore = createStore({ dir: join(deskDir, 'store') })
fixtureStore.writeAccount('fix', { name: '自检号', appid: 'wxfix', appsecret: 's', proxyUrl: 'http://127.0.0.1:9', author: '自检作者' })
const fixtureApi = registerTools(
  { logger: { info() {} }, tools: { register: () => () => undefined } },
  { config: settings, store: fixtureStore, desk: createMediaDesk({ dir: deskDir }), log() {} },
)
const savedRender = await fixtureApi.call('gzh_render', { account: 'fix', itemId: 'it_fixture', markdownFrom: 'saved', upload: false })
check('导出的 .md 里 ![](配图9.png) 按稿子所在目录解析到了', savedRender.images[0].bytes > 0 && savedRender.images[0].error.includes('upload=false'), JSON.stringify(savedRender.images))
check('相对路径的配图不再被判成「本地素材不存在」', !JSON.stringify(savedRender.images).includes('本地素材不存在'), JSON.stringify(savedRender.images))
check('那份稿子的两张图都进了解析（upload=false 只丢不传）', savedRender.stats.droppedImages === 2 && savedRender.images.length === 2, JSON.stringify(savedRender.stats))
check('条目有图、正文没引用时会点名，不再静默 0 张', savedRender.warnings.some(w => w.includes('没引用的这 1 张') && w.includes('g_missing.png')), JSON.stringify(savedRender.warnings))
check('同一张图换了文件名（导出的副本）不算没引用', !JSON.stringify(savedRender.warnings).includes('g_dup.png'), JSON.stringify(savedRender.warnings))
const stateRender = await fixtureApi.call('gzh_render', { account: 'fix', itemId: 'it_fixture', upload: false })
check('正文一张图都没引用时，自动把登记过的图插进正文', stateRender.placement.placed.length === 1 && stateRender.placement.placed[0].src === '配图9.png', JSON.stringify(stateRender.placement))
check('自动插图点名插了哪张、落在哪一节', stateRender.warnings.some(w => w.includes('自动插了 1 张配图') && w.includes('「（开头）」')), JSON.stringify(stateRender.warnings))
check('台账里两个名字指向同一张图时只插一次', stateRender.placement.skipped.some(item => item.src === 'media-desk/files/g_dup.png' && item.reason.includes('同一张')), JSON.stringify(stateRender.placement.skipped))
check('文件不在的那张照样点名', stateRender.warnings.some(w => w.includes('g_missing.png') && w.includes('文件不在')), JSON.stringify(stateRender.warnings))
check('这条没登记 cover 时自动挑一张当封面，并说清凭什么', stateRender.cover.from === 'auto' && stateRender.cover.src.includes('配图9.png') && stateRender.cover.reason.includes('字节最大'), JSON.stringify(stateRender.cover))
check('封面的来路与只渲染的提醒都进 coverNote', stateRender.coverNote.some(note => note.includes('没生成封面'))
  && stateRender.coverNote.some(note => note.includes('upload=false')), JSON.stringify(stateRender.coverNote))
const stateRow = fixtureStore.findRender(stateRender.renderId)
check('渲染台账记下这次插了几张、封面是谁（推送靠它带封面）', stateRow.bodyImages === 0 && stateRow.placed === 1
  && stateRow.coverFrom === 'auto' && stateRow.thumbMediaId === '', JSON.stringify(stateRow).slice(0, 220))
check('resolveAsset 不带 baseDir 时不瞎猜，标成 unknown', createMediaDesk({ dir: deskDir }).resolveAsset('配图9.png').kind === 'unknown', '')
const missMd = join(toolDir, '缺图稿.md')
writeFileSync(missMd, '# 缺图稿\n\n![](没有这张.png)\n', 'utf8')
const missRender = await api.call('gzh_render', { account: 'gzh-test', markdownPath: missMd, upload: false })
check('找不到相对配图时，报错说清去过哪个目录找', missRender.images[0].error.includes(join(toolDir, '没有这张.png')), JSON.stringify(missRender.images))
check('丢掉的配图在 warnings 里也点名，不只藏在 images 里', missRender.warnings.some(w => w.includes('没有这张.png')), JSON.stringify(missRender.warnings))
const pasteRender = await api.call('gzh_render', { account: 'gzh-test', markdown: '# 标题\n\n![](配图9.png)', upload: false })
check('粘贴的正文写相对路径时，告诉你没法定位', pasteRender.images[0].error.includes('相对路径没法定位'), JSON.stringify(pasteRender.images))
/* 端到端（仍是假微信）：上传配图 + 上传封面素材 → 推送时封面自动带过去。
   这是「草稿必须带封面图和插图」这条要求唯一的机器证据。 */
let uploadStub = fakeWeChat()
let uploaded
try {
  uploaded = await fixtureApi.call('gzh_render', { account: 'fix', itemId: 'it_fixture', upload: true })
} finally { uploadStub.restore() }
check('upload=true 时正文插图真的走了图床接口，正文里有图了', uploadStub.seen.some(entry => entry.path.endsWith('/media/uploadimg'))
  && uploaded.stats.images === 1 && uploaded.images[0].url.includes('mmbiz.qpic.cn'), JSON.stringify(uploaded.images))
check('没登记封面时挑出来的那张真上传成封面素材', uploadStub.seen.some(entry => entry.path.endsWith('/material/add_material'))
  && uploaded.cover.thumbMediaId === 'FAKE-COVER-MID' && uploaded.cover.from === 'auto', JSON.stringify(uploaded.cover))
check('封面 media_id 进渲染台账（推送时靠它，不靠人记）', fixtureStore.findRender(uploaded.renderId).thumbMediaId === 'FAKE-COVER-MID', '')
let pushBody = '{}'
uploadStub = fakeWeChat()
let pushedRow
try {
  pushedRow = await fixtureApi.call('gzh_push_draft', { account: 'fix', htmlPath: uploaded.file, renderId: uploaded.renderId, title: '稿子里的标题', digest: '自检摘要' })
  const addCall = uploadStub.seen.filter(entry => entry.path.endsWith('/draft/add')).at(-1)
  pushBody = addCall?.body ?? '{}'
} finally { uploadStub.restore() }
const fixSent = JSON.parse(pushBody).articles?.[0] ?? {}
check('推草稿时封面自动带上（没让人在渲染和推送之间丢掉它）', fixSent.thumb_media_id === 'FAKE-COVER-MID' && fixSent.show_cover_pic === 1
  && pushedRow.cover.thumbMediaId === 'FAKE-COVER-MID', `${pushBody.slice(0, 120)}`)
check('推送结果说清正文里有几张图', pushedRow.stats.bodyImages === 1 && pushedRow.skippedChecks.bodyImages === null, JSON.stringify(pushedRow.stats))
rmSync(deskDir, { recursive: true, force: true })
const rendered = await api.call('gzh_render', { account: 'gzh-test', markdown: '# 闸门标题\n\n第一句。\n\n第二句。', upload: false })
check('渲染回带 renderId 与两个文件', typeof rendered.renderId === 'string' && rendered.renderId.length === 12
  && rendered.file.endsWith('.html') && rendered.previewFile.endsWith('-preview.html'), JSON.stringify(rendered).slice(0, 160))
check('渲染产物是无损 JSON', losslessViolations(rendered).length === 0, losslessViolations(rendered).join('; '))
check('渲染来源写清楚', rendered.markdownSource.from === 'markdown', JSON.stringify(rendered.markdownSource))
check('可推送的那份是内层 section', readFileSync(rendered.file, 'utf8').trimStart().startsWith('<section'))
check('预览那份带 HTML 外壳', /<!DOCTYPE html>/i.test(readFileSync(rendered.previewFile, 'utf8')))
check('缺 renderId 的推送被拦', (await callFail('gzh_push_draft', { account: 'gzh-test', htmlPath: rendered.file, title: '闸门标题' })).includes('renderId'))
check('拿预览文件推送被拦', (await callFail('gzh_push_draft', { account: 'gzh-test', htmlPath: rendered.previewFile, title: '闸门标题', renderId: rendered.renderId })).includes('不是排版产物'))
check('陌生 renderId 被拦', (await callFail('gzh_push_draft', { account: 'gzh-test', htmlPath: rendered.file, title: '闸门标题', renderId: 'ffffffffffff' })).includes('renderId'))
appendFileSync(rendered.file, '<section></section>')
check('渲染后偷改文件会被发现', (await callFail('gzh_push_draft', { account: 'gzh-test', htmlPath: rendered.file, title: '闸门标题', renderId: rendered.renderId })).includes('对不上'))
check('串号推送被拦', await (async () => {
  toolStore.writeAccount('other-test', { name: '另一个号', appid: 'wxdef', appsecret: 'x', proxyUrl: 'http://127.0.0.1:9', proxyToken: 'y' })
  // 上面那份 file 被故意改坏过（sha 已经不匹配，先撞闸 2），所以重新渲染一份干净的
  const clean = await api.call('gzh_render', { account: 'gzh-test', markdown: '# 闸门标题\n\n第一句。\n\n第二句。', upload: false })
  const text = await callFail('gzh_push_draft', { account: 'other-test', htmlPath: clean.file, title: '闸门标题', renderId: clean.renderId })
  return text.includes('gzh-test') && text.includes('other-test')
})())

/* ── 推送这一步接上「假微信」：闸门顺序、字段映射、评论开关全部离线可测 ──────
   wechat.js 的 call() 只用全局 fetch，所以换个 fetch 就能把 draft/add 的请求体
   原样截下来看。绝不碰真号（真号推一次少一次，草稿箱同名草稿也会被污染）。 */
function fakeWeChat({ drafts = [], addFails = false } = {}) {
  const real = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const path = (url instanceof URL ? url : new URL(String(url))).pathname
    // 上传配图/封面素材走的是 FormData，Buffer.from() 会当场炸；只把能读的请求体存下来
    seen.push({ path, body: typeof init.body === 'string' || Buffer.isBuffer(init.body) ? Buffer.from(init.body).toString('utf8') : String(init.body ?? '') })
    const say = data => ({ ok: true, status: 200, text: async () => JSON.stringify(data) })
    if (path.endsWith('/cgi-bin/token')) return say({ access_token: 'FAKE-TOKEN', expires_in: 7200 })
    // 正文配图 → 图床 url；封面 → 永久素材 media_id。两个都答上，「草稿必须带封面和插图」才测得到底。
    if (path.endsWith('/cgi-bin/media/uploadimg')) return say({ url: `http://mmbiz.qpic.cn/fake/${seen.filter(entry => entry.path.endsWith('/uploadimg')).length}.png` })
    if (path.endsWith('/cgi-bin/material/add_material')) return say({ media_id: 'FAKE-COVER-MID', url: 'http://mmbiz.qpic.cn/fake/cover.png' })
    if (path.endsWith('/cgi-bin/draft/batchget')) return say({ item: { list: drafts, total_count: drafts.length }, has_more: false })
    if (path.endsWith('/cgi-bin/draft/add')) {
      if (addFails) return say({ errcode: 53404, errmsg: 'word list error, suggest to check doc' })
      return say({ media_id: `FAKE-DRAFT-${seen.filter(entry => entry.path.endsWith('/draft/add')).length}` })
    }
    return say({ errcode: 48001, errmsg: 'api unauthorized' })
  }
  return { seen, restore: () => { globalThis.fetch = real } }
}
const draftEntry = (mediaId, title) => ({ media_id: mediaId, update_time: 1_700_000_000, content: { news_item: [{ title }] } })
const sentArticle = seen => JSON.parse(seen.filter(entry => entry.path.endsWith('/draft/add')).at(-1)?.body ?? '{}').articles?.[0] ?? {}
const pushed = seen => seen.some(entry => entry.path.endsWith('/draft/add'))
const gateRender = await api.call('gzh_render', { account: 'gzh-test', markdown: '# 体检标题\n\n第一句。\n\n第二句。', upload: false })
const pushArgs = { account: 'gzh-test', htmlPath: gateRender.file, renderId: gateRender.renderId, author: '测试作者', thumbMediaId: 'FAKE-THUMB' }

let stub = fakeWeChat()
try {
  const tooLong = await callFail('gzh_push_draft', { ...pushArgs, title: '超'.repeat(65) })
  check('标题超 64 字在联网前就拒', tooLong.includes('64') && stub.seen.length === 0, `${tooLong} 请求数=${stub.seen.length}`)
} finally { stub.restore() }

stub = fakeWeChat()
try {
  const okPush = await api.call('gzh_push_draft', { ...pushArgs, title: '体检 A', digest: '摘'.repeat(130) })
  const sent = sentArticle(stub.seen)
  check('摘要自动截到 120 字（不让整篇被微信拒掉）', textLength(sent.digest) === 120, String(textLength(sent.digest)))
  check('标题与作者原样送达', sent.title === '体检 A' && sent.author === '测试作者', `${sent.title}/${sent.author}`)
  check('评论缺省 = 开放且不限粉丝', sent.need_open_comment === 1 && sent.only_fans_can_comment === 0, JSON.stringify(sent))
  check('带封面时 thumb_media_id 与 show_cover_pic 都对（封面现在是硬要求）', sent.show_cover_pic === 1 && sent.thumb_media_id === 'FAKE-THUMB', JSON.stringify(sent))
  await createClient({ baseUrl: 'http://127.0.0.1:9', token: 't', appid: 'wxdef', secret: 's' })
    .addDraft({ title: '微信层', author: 'A', digest: 'D', content: '<section></section>' })
  const bare = sentArticle(stub.seen)
  check('wechat 层守老行为：没给封面就不写 thumb_media_id、show_cover_pic=0', bare.show_cover_pic === 0 && bare.thumb_media_id === undefined, JSON.stringify(bare))
  check('推送成功回带 media_id 与回读提示', okPush.mediaId === 'FAKE-DRAFT-1' && String(okPush.next).includes('回读'), JSON.stringify(okPush).slice(0, 200))
  const paths = stub.seen.map(entry => entry.path)
  check('先查草稿箱再真推（顺序不能反）', paths.findIndex(p => p.endsWith('/batchget')) < paths.findIndex(p => p.endsWith('/draft/add')), paths.join(' '))
  check('预检结论写进返回值', okPush.skippedChecks.draftBox.includes('0 条') && okPush.skippedChecks.contentAudit === null, JSON.stringify(okPush.skippedChecks))
} finally { stub.restore() }

toolStore.writeAccount('gzh-test', { comment: { open: false, fansOnly: true } })
stub = fakeWeChat()
try {
  await api.call('gzh_push_draft', { ...pushArgs, title: '体检 B' })
  const sent = sentArticle(stub.seen)
  check('账号级评论开关写进草稿', sent.need_open_comment === 0 && sent.only_fans_can_comment === 1, JSON.stringify(sent))
} finally { stub.restore() }
stub = fakeWeChat()
try {
  await api.call('gzh_push_draft', { ...pushArgs, title: '体检 C', commentOpen: true, commentFansOnly: false })
  const sent = sentArticle(stub.seen)
  check('单次推送能盖过账号默认（只影响这一篇）', sent.need_open_comment === 1 && sent.only_fans_can_comment === 0, JSON.stringify(sent))
} finally { stub.restore() }
toolStore.writeAccount('gzh-test', { comment: {} })

const sameTitle = '草稿箱里已经有了'
stub = fakeWeChat({ drafts: [draftEntry('OLD-DRAFT-1', sameTitle), draftEntry('OLD-DRAFT-2', '不相干的一篇')] })
try {
  const hit = await callFail('gzh_push_draft', { ...pushArgs, title: sameTitle })
  check('草稿箱同名草稿在真推之前被拦', hit.includes(sameTitle) && hit.includes('OLD-DRAFT-1') && !pushed(stub.seen), hit)
} finally { stub.restore() }
stub = fakeWeChat({ drafts: [draftEntry('OLD-DRAFT-1', sameTitle)] })
try {
  const forced = await api.call('gzh_push_draft', { ...pushArgs, title: sameTitle, force: true, reason: '确认要再建一条' })
  check('force 能盖过同名预检并留下绕过痕迹', sentArticle(stub.seen).title === sameTitle
    && forced.skippedChecks.draftBox.includes('1 条'), JSON.stringify(forced.skippedChecks))
} finally { stub.restore() }
stub = fakeWeChat({ drafts: [draftEntry('OLD-DRAFT-1', sameTitle)] })
try {
  const skipped = await api.call('gzh_push_draft', { ...pushArgs, title: '体检 D', checkDraftBox: false })
  check('checkDraftBox=false 明确跳过预检', !stub.seen.some(entry => entry.path.endsWith('/batchget'))
    && skipped.skippedChecks.draftBox.includes('已关闭'), JSON.stringify(skipped.skippedChecks))
} finally { stub.restore() }

const dirtyFile = join(toolDir, 'dirty-push.html')
writeFileSync(dirtyFile, '<section><p>看这个链接 <a href="https://example.com/x">外部站</a></p><img src="https://cdn.other.com/a.png"></section>', 'utf8')
stub = fakeWeChat()
try {
  const dirty = await callFail('gzh_push_draft', { account: 'gzh-test', htmlPath: dirtyFile, title: '体检 E', allowRawHtml: true, reason: '自检：外链闸门' })
  check('正文外链与非图床图在真推之前被拦', dirty.includes('example.com') && dirty.includes('cdn.other.com') && !pushed(stub.seen), dirty)
  const risky = await api.call('gzh_push_draft', { account: 'gzh-test', htmlPath: dirtyFile, title: '体检 E', allowRawHtml: true, reason: '自检：外链闸门', force: true })
  check('force 可带风险推送并记下绕过几处', sentArticle(stub.seen).title === '体检 E'
    && risky.skippedChecks.contentAudit.includes('2 处'), JSON.stringify(risky.skippedChecks))
} finally { stub.restore() }

stub = fakeWeChat({ addFails: true })
try {
  const failed = await callFail('gzh_push_draft', { ...pushArgs, title: '体检 F' })
  check('微信报错时给出错误码并劝住手', failed.includes('53404') && failed.includes('gzh_draft_verify'), failed)
  const row = toolStore.readLedger()[0]
  check('失败也进台账（mediaId 空 + error 有值）', row?.mediaId === null && String(row?.error).includes('53404'), JSON.stringify(row ?? {}).slice(0, 200))
} finally { stub.restore() }

/* ── 封面和正文插图是硬要求：白封面草稿、纯文字草稿都是本来能拦下来的事故 ── */
toolStore.writeAccount('cover-test', { name: '封面号', appid: 'wxcover', appsecret: 'x', proxyUrl: 'http://127.0.0.1:9', proxyToken: 'y', author: '封面作者', digest: '封面摘要' })
const bareRender = await api.call('gzh_render', { account: 'cover-test', markdown: '# 封面闸门\n\n第一段。\n\n第二段。', upload: false })
check('一条封面来源都没有时，渲染阶段就先把话说在前面', bareRender.cover.from === 'none' && bareRender.cover.thumbMediaId === ''
  && bareRender.warnings.some(w => w.includes('没有可用封面')), JSON.stringify(bareRender.cover))
stub = fakeWeChat()
try {
  const noCover = await callFail('gzh_push_draft', { account: 'cover-test', htmlPath: bareRender.file, renderId: bareRender.renderId, title: '封面闸门' })
  check('没封面不给推（联网前就拦，不到手机上才发现白封面）', noCover.includes('封面') && !pushed(stub.seen), noCover)
  const forcedCover = await api.call('gzh_push_draft', { account: 'cover-test', htmlPath: bareRender.file, renderId: bareRender.renderId, title: '封面闸门 强推', force: true, reason: '自检：明知没封面也要推一版' })
  check('force+reason 才盖得住封面闸，结果里留下「记得回后台补」', String(forcedCover.skippedChecks.cover).includes('没有封面'), JSON.stringify(forcedCover.skippedChecks))
  const imagelessRender = await api.call('gzh_render', { account: 'cover-test', markdown: '# 插图闸门\n\n正文。\n\n![](这张图不存在.png)', upload: false })
  const noBody = await callFail('gzh_push_draft', { account: 'cover-test', htmlPath: imagelessRender.file, renderId: imagelessRender.renderId, title: '插图闸门', thumbMediaId: 'COVER-OK' })
  check('登记了配图却一张都没进正文，同样不给推', noBody.includes('一张都没有') && !noBody.includes('封面'), noBody)
  const forcedBody = await api.call('gzh_push_draft', { account: 'cover-test', htmlPath: imagelessRender.file, renderId: imagelessRender.renderId, title: '插图闸门 强推', thumbMediaId: 'COVER-OK', force: true, reason: '自检：就要推无图版' })
  check('强推无图版时结果与台账都标得出来', forcedBody.stats.bodyImages === 0
    && String(forcedBody.skippedChecks.bodyImages).includes('登记了配图'), JSON.stringify(forcedBody.skippedChecks))
  const gateRow = toolStore.readLedger().find(row => row.title === '插图闸门 强推')
  check('推送台账记下封面是谁、正文几张图（事后能回答这篇为什么没图）', gateRow?.thumbMediaId === 'COVER-OK'
    && gateRow?.coverFrom === 'push 参数' && gateRow?.bodyImages === 0, JSON.stringify(gateRow ?? {}).slice(0, 220))
} finally { stub.restore() }

/* ── 摘要跟着渲染台账走 ──────────────────────────────────────────────
   面板的「推送到草稿箱」故意不传 digest（传空串会顶掉账号默认值），所以摘要必须在渲染时
   定下来、记进台账、推送时取回来。以前推送侧只看账号默认，凡是没配默认摘要的号在面板上
   必然报「缺少 digest（摘要）」——中间明明已经排好了稿子。 */
toolStore.writeAccount('nodigest', { name: '没摘要号', appid: 'wxnode', appsecret: 'x', proxyUrl: 'http://127.0.0.1:9', proxyToken: 'y', author: '无摘要作者', thumbMediaId: 'DEFAULT-COVER-NODEST' })
const dgRender = await api.call('gzh_render', { account: 'nodigest', upload: false, markdown: '# 摘要跟着台账走\n\n这一段就是自动摘出来的摘要，微信列表里标题下面那行。\n\n## 一、节\n\n第二段。' })
check('账号没配默认摘要时，渲染阶段就摘正文兜一段（标题行不重复进摘要）', dgRender.digest === '这一段就是自动摘出来的摘要，微信列表里标题下面那行。 第二段。'
  && dgRender.digestFrom === '自动摘正文第一段', `${dgRender.digest}｜${dgRender.digestFrom}`)
check('摘要进渲染台账（面板不传 digest，只能从台账带过去）', toolStore.findRender(dgRender.renderId)?.digest === dgRender.digest
  && toolStore.findRender(dgRender.renderId)?.digestFrom === '自动摘正文第一段', JSON.stringify(toolStore.findRender(dgRender.renderId) ?? {}).slice(0, 200))
const longDigest = await api.call('gzh_render', { account: 'nodigest', upload: false, markdown: `# 长文摘要\n\n${'很长的一段正文。'.repeat(40)}` })
check('兜摘要按码点截到 110 字，不把整篇塞进摘要', textLength(longDigest.digest) === 110 && !longDigest.digest.includes('长文摘要'), String(textLength(longDigest.digest)))
stub = fakeWeChat()
try {
  // 面板那条路径：只给 account / htmlPath / renderId / title，摘要与作者一律留给默认。
  const panelPush = await api.call('gzh_push_draft', { account: 'nodigest', htmlPath: dgRender.file, renderId: dgRender.renderId, title: '摘要跟着台账走' })
  check('没配默认摘要的号也从面板路径推得出去（不再缺 digest）', panelPush.ok === true && panelPush.mediaId === 'FAKE-DRAFT-1', JSON.stringify(panelPush).slice(0, 160))
  check('真推进微信的摘要就是渲染时定下的那段', sentArticle(stub.seen).digest === dgRender.digest, JSON.stringify(sentArticle(stub.seen)).slice(0, 220))
  check('结果与台账都记下摘要从哪来（事后可复盘）', panelPush.digestFrom === '渲染时定下的摘要（自动摘正文第一段）'
    && toolStore.readLedger().find(row => row.title === '摘要跟着台账走')?.digest === dgRender.digest, panelPush.digestFrom)
  const override = await api.call('gzh_push_draft', { account: 'nodigest', htmlPath: dgRender.file, renderId: dgRender.renderId, title: '摘要跟着台账走 改一句', digest: '人给的摘要' })
  check('push 显式传的摘要仍然盖过台账（临时换一句不用重排）', sentArticle(stub.seen).digest === '人给的摘要'
    && override.digestFrom === 'push 参数', override.digestFrom)
} finally { stub.restore() }

/* 升级前存的渲染记录里没有 digest 字段：得退到台账记着的那份 Markdown 现摘一段。 */
const legacyMd = join(toolDir, '老记录的摘要.md')
writeFileSync(legacyMd, '# 老记录的摘要\n\n从 Markdown 路径现摘的第一段。\n\n第二段。', 'utf8')
const legacyRender = await api.call('gzh_render', { account: 'nodigest', markdownPath: legacyMd, upload: false })
const legacyRow = { ...toolStore.findRender(legacyRender.renderId) }
delete legacyRow.digest
delete legacyRow.digestFrom
toolStore.appendRender(legacyRow)
stub = fakeWeChat()
try {
  const legacyPush = await api.call('gzh_push_draft', { account: 'nodigest', htmlPath: legacyRender.file, renderId: legacyRender.renderId, title: '老记录的摘要' })
  check('老渲染记录（台账没 digest）退到台账记的 Markdown 现摘', sentArticle(stub.seen).digest === '从 Markdown 路径现摘的第一段。 第二段。'
    && legacyPush.digestFrom === '按 Markdown 现摘的第一段', `${legacyPush.digest}｜${legacyPush.digestFrom}`)
  // 台账之外的路径（allowRawHtml）又没有摘要：报错要直接指向「重新渲染」，而且一个请求都不能发。
  const seenBefore = stub.seen.length
  const noDigest = await callFail('gzh_push_draft', { account: 'nodigest', htmlPath: dgRender.file, title: '摘要兜底', allowRawHtml: true, reason: '自检：台账之外不该有摘要' })
  check('实在没有摘要时，下一步说的是重新渲染', noDigest.includes('缺少 digest') && noDigest.includes('gzh_render') && stub.seen.length === seenBefore, noDigest)
} finally { stub.restore() }

/* 更要紧的一种老记录：工作台来源（markdownFrom=state）的台账里 markdownPath 记的是
   state.json 整份文件。照着它硬读就会把 `{"items":[…` 摘成摘要推上去，而且台账还记着
   「推送成功」——比直接报错更糟。兜底必须回工作台取那条正文。
   （上面那份 fixture 的目录已经清掉了，这里单开一个只有 state.json 的最小工作台。） */
const deskDir2 = mkdtempSync(join(tmpdir(), 'gzh-state-'))
writeFileSync(join(deskDir2, 'state.json'), JSON.stringify({
  items: [{ id: 'it_legacy', updatedAt: 2, production: { title: '老的工作台稿', stage: 'done', article: `# 老的工作台稿\n\n${deskLong}\n\n## 一、节\n\n第二段。\n` } }],
}), 'utf8')
const legacyStore = createStore({ dir: join(deskDir2, 'store') })
legacyStore.writeAccount('fixedg', { name: '摘要兜底号', appid: 'wffix', appsecret: 's', proxyUrl: 'http://127.0.0.1:9', author: '自检作者', thumbMediaId: 'COVER-FIX' })
const legacyApi = registerTools(
  { logger: { info() {} }, tools: { register: () => () => undefined } },
  { config: settings, store: legacyStore, desk: createMediaDesk({ dir: deskDir2 }), log() {} },
)
const stateRender2 = await legacyApi.call('gzh_render', { account: 'fixedg', itemId: 'it_legacy', upload: false })
const legacyStateRow = { ...legacyStore.findRender(stateRender2.renderId) }
delete legacyStateRow.digest
delete legacyStateRow.digestFrom
legacyStore.appendRender(legacyStateRow)
check('工作台来源的台账记的 markdownPath 就是 state.json（所以绝不能当 Markdown 硬读）',
  legacyStateRow.markdownFrom === 'state' && /\.json$/i.test(String(legacyStateRow.markdownPath)), String(legacyStateRow.markdownPath))
stub = fakeWeChat()
try {
  const statePush = await legacyApi.call('gzh_push_draft', {
    account: 'fixedg', htmlPath: stateRender2.file, renderId: stateRender2.renderId, title: legacyStateRow.title, checkDraftBox: false,
  })
  const sentState = sentArticle(stub.seen)
  check('老的工作台渲染记录兜底摘的是工作台正文，摘出来和新渲染一模一样',
    sentState.digest === stateRender2.digest && statePush.digestFrom === '按 Markdown 现摘的第一段', `${statePush.digest}｜${statePush.digestFrom}`.slice(0, 180))
  check('摘要里不会出现 state.json 的 JSON 碎片（宁缺毋滥）',
    sentState.digest.includes('{') === false && sentState.digest.includes('items') === false && sentState.digest.includes(deskLong) === true, String(sentState.digest).slice(0, 140))
} finally { stub.restore(); rmSync(deskDir2, { recursive: true, force: true }) }

/* 摘要不该只会摘第一段：渲染时传一句模型/人读完正文写的摘要，它进台账，
   面板那个「推送到草稿箱」按钮（不传 digest）就直接带上——这一条把整条链路钉住。 */
const writtenDir = mkdtempSync(join(tmpdir(), 'gzh-written-'))
const writtenStore = createStore({ dir: writtenDir })
writtenStore.writeAccount('writeg', { name: '模型摘要号', appid: 'wfwri', appsecret: 's', proxyUrl: 'http://127.0.0.1:9', author: '自检作者', thumbMediaId: 'COVER-W' })
const writtenApi = registerTools(
  { logger: { info() {} }, tools: { register: () => () => undefined } },
  { config: settings, store: writtenStore, desk: createMediaDesk({ dir: join(writtenDir, 'nodesk') }), log() {} },
)
const writtenMd = '# 模型摘要这篇\n\n第一段的老套开场白，谁都不想读。\n\n正文里讲了成本和返工。\n'
const overDigest = '模型按正文写的摘要「WQ」。' + '尾'.repeat(200)
const writtenRender = await writtenApi.call('gzh_render', { account: 'writeg', markdown: writtenMd, upload: false, digest: overDigest })
check('渲染时传的摘要用它，不用自动摘的第一段，来源写清楚',
  writtenRender.digestFrom === '读完正文写的摘要' && writtenRender.digest.includes('WQ') && !writtenRender.digest.includes('老套开场白'),
  `${writtenRender.digestFrom}｜${writtenRender.digest.slice(0, 40)}`)
check('摘要超过微信上限 120 字就截到 120 并告警（不是静默截，也不是原样推）',
  Array.from(writtenRender.digest).length === 120 && writtenRender.warnings.some(w => String(w).includes('120')),
  `${Array.from(writtenRender.digest).length} 字｜${JSON.stringify(writtenRender.warnings)}`.slice(0, 200))
check('定下来的摘要进了渲染台账（面板推送靠它）',
  writtenStore.findRender(writtenRender.renderId)?.digest === writtenRender.digest
  && writtenStore.findRender(writtenRender.renderId)?.digestFrom === '读完正文写的摘要', String(writtenStore.findRender(writtenRender.renderId)?.digestFrom))
stub = fakeWeChat()
try {
  // 和面板按钮一模一样：只给 htmlPath + renderId + title，digest 一个字都不传。
  const writtenPush = await writtenApi.call('gzh_push_draft', {
    account: 'writeg', htmlPath: writtenRender.file, renderId: writtenRender.renderId, title: writtenRender.title, checkDraftBox: false,
  })
  const sentWritten = sentArticle(stub.seen)
  check('面板推送不传 digest，也带上了渲染时定下的那句模型摘要',
    sentWritten.digest === writtenRender.digest && writtenPush.digestFrom === '渲染时定下的摘要（读完正文写的摘要）',
    `${writtenPush.digestFrom}｜${sentWritten.digest.slice(0, 40)}`)
} finally { stub.restore() }
const shortRender = await writtenApi.call('gzh_render', {
  account: 'writeg', markdown: `${writtenMd}\n短摘要这一版多加一句，免得和上一版撞同一个文件。\n`, upload: false, digest: '成本压下去以后，卷的是讲故事。',
})
check('没超上限的摘要原样用，不会被截也不会瞎告警',
  shortRender.digest === '成本压下去以后，卷的是讲故事。'
  && !shortRender.warnings.some(w => String(w).includes('120')), shortRender.digest)
rmSync(writtenDir, { recursive: true, force: true })

const ledgerRows = toolStore.readLedger()
check('台账记下体检结论（audit 与 draftBox）', ledgerRows.some(row => Array.isArray(row.audit) && Array.isArray(row.draftBox)), JSON.stringify(ledgerRows[0] ?? {}).slice(0, 200))
check('评论开关进台账（能回答这篇为什么不能评论）', ledgerRows.some(row => row.comment?.open === false && row.comment?.fansOnly === true), '')
check('假推送没碰到真号', ledgerRows.every(row => row.endpoint === 'http://127.0.0.1:9'), JSON.stringify(ledgerRows.map(row => row.endpoint)))

for (const dispose of api.disposers) dispose()
check('disposer 能把工具摘干净（remount 不重复注册）', registered.size === 0)

// 停用开关是 volatile 的：enabled=false 后任何工具调用都要被挡住
const disabled = registerTools(fakeCtx, { config: () => ({ ...settings(), enabled: false }), store: toolStore, desk, log() {} })
let blocked = ''
try {
  await disabled.call('gzh_account_list', {})
} catch (cause) {
  blocked = cause.message
}
check('enabled=false 时面板调用也被拦（同一个闸门）', blocked.includes('已停用'), blocked)
for (const dispose of disabled.disposers) dispose()
rmSync(toolDir, { recursive: true, force: true })

/* ---------------- 面板路由（令牌 / 同源 / 路径 三把锁） ---------------- */
const routeDir = mkdtempSync(join(tmpdir(), 'gzh-routes-'))
const routeStore = createStore({ dir: routeDir })
mkdirSync(routeStore.outDir, { recursive: true })
const routeSettings = { ...settings(), dataDir: routeDir }
const routeApi = registerTools(fakeCtx, { config: () => routeSettings, store: routeStore, desk, log() {} })
const routes = createApiRoutes({
  api: routeApi, store: routeStore, desk,
  config: () => routeSettings,
  log() {}, getOrigin: () => 'http://127.0.0.1:64884',
})

function fakeRes() {
  return {
    statusCode: 0, body: '',
    writeHead(status) { this.statusCode = status },
    end(payload) { this.body = String(payload) },
    json() { return JSON.parse(this.body) },
  }
}
function fakeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}
async function hit(spec) {
  const res = fakeRes()
  await routes.handler(fakeReq(spec), res)
  return res
}

// 快照里必须能看到账号，但只能看到掩码；这里塞一个带真密钥的号来验「不漏」
routeStore.writeAccount('route-test', {
  name: '路由号', appid: 'wxroute', appsecret: 'secret-value', proxyUrl: 'http://127.0.0.1:9',
  proxyToken: 'proxy-token', layout: 'account-c', author: '作者', digest: '摘要',
})
const boot = await hit({ url: `${ROUTE_PREFIX}/bootstrap`, headers: { origin: 'http://127.0.0.1:64884' } })
check('/bootstrap 同源可用并下发令牌', boot.statusCode === 200 && boot.json().token === routes.token
  && boot.json().actions.length === 12, `actions=${boot.json().actions?.length}`)
const bootBody = JSON.stringify(boot.json())
check('/bootstrap 一次给全面板要的东西（账号/皮肤/文章/台账/渲染）',
  ['enabled', 'config', 'accounts', 'skins', 'articles', 'mediaDesk', 'pushes', 'renders', 'engine', 'files', 'configNote']
   .every(key => bootBody.includes(`"${key}"`)), bootBody.slice(0, 120))
check('/bootstrap 不回显任何密钥', await (async () => {
  if (bootBody.includes('proxy-token') || bootBody.includes('secret-value')) return false
  const rows = (await hit({ url: `${ROUTE_PREFIX}/accounts`, headers: { 'x-gzh-token': routes.token } })).json().accounts.accounts
  return rows.every(row => [row.appsecret, row.proxyToken].every(value => value === '' || value.startsWith('****')))
})())
check('账号条目带皮肤中文名', JSON.stringify(boot.json().accounts).includes('layoutLabel')
  && boot.json().skins.some(row => row.key === 'teal' && row.builtIn === true))
const meta = await hit({ url: `${ROUTE_PREFIX}/meta`, headers: { 'x-gzh-token': routes.token } })
check('/meta 刷新快照但不带令牌', meta.statusCode === 200 && meta.json().token === undefined
  && meta.json().ok === true && Array.isArray(meta.json().accounts) && meta.json().accounts.length === 1)
const metaNoToken = await hit({ url: `${ROUTE_PREFIX}/meta` })
check('/meta 也要令牌（不让外页探到账号列表）', metaNoToken.statusCode === 401)
check('皮肤快照带整套配色（设置里的皮肤表单要能读到当前值）',
  boot.json().skins.every(row => Object.keys(row.colors ?? {}).length === 7
    && Object.values(row.colors).every(color => color.startsWith('#')))
  && meta.json().skins.every(row => typeof row.key === 'string' && typeof row.colors.heading === 'string'))
check('账号还存着旧皮肤名时，快照按渲染口径解析成中性 key',
  boot.json().accounts.some(row => row.key === 'route-test' && row.layout === 'account-c'
    && row.layoutKey === 'redwhite' && row.layoutKnown === true),
  JSON.stringify(boot.json().accounts.map(row => [row.layout, row.layoutKey, row.layoutKnown])))
const crossBoot = await hit({ url: `${ROUTE_PREFIX}/bootstrap`, headers: { origin: 'http://evil.example' } })
check('/bootstrap 非同源不发令牌', crossBoot.statusCode === 403 && crossBoot.json().code === 'cross_origin')
const crossFetch = await hit({ url: `${ROUTE_PREFIX}/bootstrap`, headers: { 'sec-fetch-site': 'cross-site' } })
check('Sec-Fetch-Site: cross-site 一律拒', crossFetch.statusCode === 403)
const noToken = await hit({ url: `${ROUTE_PREFIX}/accounts` })
check('没有令牌只给 401', noToken.statusCode === 401 && noToken.json().code === 'unauthorized' && noToken.json().error.includes('刷新页面'))
const authed = await hit({ url: `${ROUTE_PREFIX}/accounts`, headers: { 'x-gzh-token': routes.token } })
check('带令牌可读账号列表', authed.statusCode === 200 && authed.json().accounts.ok === true)
const badPost = await hit({
  method: 'POST', url: `${ROUTE_PREFIX}/call`, headers: { 'x-gzh-token': routes.token, origin: 'http://evil.example' },
  body: JSON.stringify({ tool: 'gzh_push_draft', args: {} }),
})
check('跨域 POST 拦在写操作之前', badPost.statusCode === 403 && badPost.json().code === 'cross_origin')
const sameOriginPost = await hit({
  method: 'POST', url: `${ROUTE_PREFIX}/call`, headers: { 'x-gzh-token': routes.token, origin: 'http://127.0.0.1:64884' },
  body: JSON.stringify({ tool: 'gzh_account_list', args: {} }),
})
check('同源 + 令牌的 /call 打到真工具', sameOriginPost.statusCode === 200 && sameOriginPost.json().result.ok === true)
const badTool = await hit({
  method: 'POST', url: `${ROUTE_PREFIX}/call`, headers: { 'x-gzh-token': routes.token, origin: 'http://127.0.0.1:64884' },
  body: JSON.stringify({ tool: 'shell', args: {} }),
})
check('/call 不接受白名单外的工具', badTool.statusCode === 400 && badTool.json().error.includes('没有这个动作'))
const badBody = await hit({
  method: 'POST', url: `${ROUTE_PREFIX}/call`, headers: { 'x-gzh-token': routes.token, origin: 'http://127.0.0.1:64884' },
  body: '[1,2]',
})
check('请求体不是对象时报中文错', badBody.statusCode === 400 && badBody.json().error.includes('JSON 对象'))
writeFileSync(join(routeStore.outDir, 'ok.html'), '<section>预览</section>', 'utf8')
const goodPreview = await hit({ url: `${ROUTE_PREFIX}/preview?file=${encodeURIComponent(join(routeStore.outDir, 'ok.html'))}`, headers: { 'x-gzh-token': routes.token } })
check('输出目录里的 HTML 可以预览', goodPreview.statusCode === 200 && goodPreview.json().html.includes('预览'))
const escapePreview = await hit({ url: `${ROUTE_PREFIX}/preview?file=${encodeURIComponent(join(routeDir, '..', 'secret.html'))}`, headers: { 'x-gzh-token': routes.token } })
check('路径穿越被拒（只读插件自己的目录）', escapePreview.statusCode === 400 && escapePreview.json().error.includes('输出目录'))
const notHtml = await hit({ url: `${ROUTE_PREFIX}/preview?file=${encodeURIComponent(join(routeStore.outDir, 'notes.txt'))}`, headers: { 'x-gzh-token': routes.token } })
writeFileSync(join(routeStore.outDir, 'notes.txt'), 'x', 'utf8')
const notHtml2 = await hit({ url: `${ROUTE_PREFIX}/preview?file=${encodeURIComponent(join(routeStore.outDir, 'notes.txt'))}`, headers: { 'x-gzh-token': routes.token } })
check('非 .html 一律不预览', notHtml.statusCode === 400 && notHtml2.statusCode === 400 && notHtml2.json().error.includes('.html'))
const notFound = await hit({ url: `${ROUTE_PREFIX}/nope`, headers: { 'x-gzh-token': routes.token } })
check('未知路由 404 并回报可用动作', notFound.statusCode === 404 && Array.isArray(notFound.json().actions))
const boom = await hit({
  method: 'POST', url: `${ROUTE_PREFIX}/call`, headers: { 'x-gzh-token': routes.token, origin: 'http://127.0.0.1:64884' },
  body: JSON.stringify({ tool: 'gzh_render', args: { account: 'ghost', itemId: 'x' } }),
})
check('工具报错也回结构化 400（含 hint 字段）', boom.statusCode === 400 && boom.json().code === 'failed'
  && typeof boom.json().hint === 'string' && boom.json().error !== '', boom.json().error)
// 停用开关：面板要能看见（显示红条），工具要被拦——两者用同一个 cfg()
routeSettings.enabled = false
const offSnapshot = await hit({ url: `${ROUTE_PREFIX}/meta`, headers: { 'x-gzh-token': routes.token } })
check('停用状态在快照里可见（面板不用猜）', offSnapshot.statusCode === 200 && offSnapshot.json().enabled === false)
const offCall = await hit({
  method: 'POST', url: `${ROUTE_PREFIX}/call`, headers: { 'x-gzh-token': routes.token, origin: 'http://127.0.0.1:64884' },
  body: JSON.stringify({ tool: 'gzh_account_list', args: {} }),
})
check('停用时 /call 也被同一个闸门拦', offCall.statusCode === 400 && offCall.json().error.includes('已停用'), offCall.json().error)
routeSettings.enabled = true
for (const dispose of routeApi.disposers) dispose()
rmSync(routeDir, { recursive: true, force: true })

/* ---------------- Client 半（模块清单 / 插槽 / 主题变量 / 一次真实渲染） ---------------- */
const clientSource = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'client.js'), 'utf8')

const colorLiterals = clientSource.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
check('Client 不写死颜色（暗色主题才跟得上）', colorLiterals.length === 0, colorLiterals.join(','))
const badTokens = [...clientSource.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map(m => m[1])
  .filter(name => !name.startsWith('--dsw-alias-') && !name.startsWith('--dsw-specific-') && !name.startsWith('--dsh-'))
check('只用 --dsw-alias-* / --dsw-specific-* / --dsh-* 变量', badTokens.length === 0, badTokens.join(','))
check('Client 不 import 宿主包（页面模块表里没有）', !/(^|\n)\s*import\s+.*from/.test(clientSource) && !/dsh-client-ui-/.test(clientSource))

let clientManifest = null
const styleNodes = new Map()
globalThis.window = { __ModuleLoader__: { load(manifest) { clientManifest = manifest } } }
globalThis.document = {
  getElementById: id => styleNodes.get(id) ?? null,
  createElement: tag => ({
    tag, id: '', textContent: '',
    remove() { styleNodes.delete(this.id) },
  }),
  head: { appendChild(node) { styleNodes.set(node.id, node) } },
}
new Function(clientSource)()
check('Client 把自己注册进 __ModuleLoader__，id 与包名一致', clientManifest !== null && clientManifest.id === 'dsh-gzh-publisher'
  && typeof clientManifest.factory === 'function', String(clientManifest?.id))

const renderErrors = []
const React = {
  Component: class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
  },
  createElement(type, props, ...children) {
    const all = { ...(props ?? {}), ...(children.length > 0 ? { children } : {}) }
    const isClass = typeof type === 'function' && type.prototype instanceof React.Component
    if (typeof type !== 'function') return { type, props: all }
    if (isClass) return new type(all).render()
    try {
      return type(all)
    } catch (cause) {
      renderErrors.push(cause)
      throw cause
    }
  },
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: () => ({ current: null }),
}
const client = clientManifest.factory(() => React)
check('Client 导出 { inject: [slots], apply }', Array.isArray(client.inject) && client.inject.includes('slots') && typeof client.apply === 'function')

// 宿主的 inject 工厂里再调 register 时用的是同一个 ctx（闭包），所以一个 ctx 就够记全两层
const rawMounts = []
const cleanups = []
const clientCtx = {
  effect(fn) {
    const off = fn()
    if (typeof off === 'function') cleanups.push(off)
  },
  slots: {
    inject(slotName, factory) {
      factory()
      return () => {}
    },
    register(registration, component) {
      rawMounts.push({ registration, component })
      return () => {}
    },
  },
}
client.apply(clientCtx)
const mainMount = rawMounts.find(mount => mount.registration?.name === 'main')
const sideMount = rawMounts.find(mount => mount.registration?.name === 'sidebar.panellist')
check('挂进 main 页（key=gzh-publisher）', mainMount?.registration?.key === 'gzh-publisher')
check('挂进 sidebar.panellist（id 同名、有 label）',
  sideMount?.registration?.id === 'gzh-publisher' && typeof sideMount?.registration?.label === 'function'
  && sideMount.registration.label() === '公众号草稿', String(sideMount?.registration?.label?.()))
check('样式注入一次并可撤', styleNodes.size === 1, [...styleNodes.keys()].join(','))

let tree = null
try {
  tree = mainMount.component({})
} catch (cause) {
  renderErrors.push(cause)
}
const treeJson = tree === null ? '' : JSON.stringify(tree)
check('面板能渲染出组件树（顶层 gzh-panel）', renderErrors.length === 0 && treeJson.includes('gzh-panel'),
  renderErrors.length > 0 ? renderErrors[0].message : `${treeJson.length}B`)

/* 三栏 + 设置：这几条盯的是用户的三条要求——设置入口、中间预览、左边只剩选账号 */
check('顶部有「设置」入口（密钥不在主界面配）', treeJson.includes('"设置"'), treeJson.slice(0, 200))
check('三栏骨架：左选择 / 中大预览 / 右操作', treeJson.includes('gzh-body') && treeJson.includes('gzh-center') && treeJson.includes('gzh-stage'))
check('中间是审阅区（大号 iframe + 空态指引）', clientSource.includes("className: 'gzh-frame'")
  && clientSource.includes('srcDoc') && clientSource.includes('gzh-frame--empty'))
check('预览用 srcDoc，不把令牌拼进 URL', !/token=|iframe[^)]*src:/.test(clientSource))
check('推送按钮由渲染结果门控（没渲染成就不给推）', /const canPush =[^;]*rendered !== null/.test(clientSource)
  && clientSource.includes('disabled: !canPush') && clientSource.includes('renderId: rendered.renderId'))
check('前端没有「绕过排版」的后门参数', !clientSource.includes('allowRawHtml'))
check('主界面不含密钥输入框（只有设置弹窗里才有）', treeJson.includes('password') === false && clientSource.includes("type: 'password'"))
check('账号是点击选择，没有下拉，主界面也没有密钥输入框', treeJson.includes('password') === false
  && clientSource.includes('点一个选它') && clientSource.includes('value: account') === false)
check('首次进入有引导（没账号就告诉你去设置建）', treeJson.includes('还没有账号') && treeJson.includes('新建账号'))
check('工作台没有产出时能直接粘贴 Markdown', treeJson.includes('粘贴 Markdown') && clientSource.includes('gzh-textarea'))
check('台账在界面上（渲染记录 + 推送台账）', treeJson.includes('渲染记录') && treeJson.includes('推送台账'))
check('Client 不认旧皮肤名（已换中性 key）', !Object.keys(LEGACY_SKIN_KEYS).some(name => clientSource.includes(name)))
check('两份正文时面板有能点的「正文来源」开关，并且真的带到渲染参数里',
  clientSource.includes("'正文来源'") && clientSource.includes('hasSavedMarkdown')
  && /itemId, markdownFrom/.test(clientSource))
// 密度契约：版面上不常驻说明书——常驻提醒能收掉，下一步由面板说，长解释进 title 悬浮。
check('常驻提醒（停用 / 没账号 / 操作结果）都带关闭键', /const hintBar =[^;]*setDismissed/.test(clientSource)
  && clientSource.includes('onClick: () => setAlert(null)') && clientSource.includes("title: '收起这条提示'"))
check('面板自己说下一步，不用在中间写一段说明书', clientSource.includes('function nextStep()')
  && treeJson.includes('gzh-next') && clientSource.includes('左边选账号和文章') === false)
check('解释性长句挪进 title，正文里不留常驻段落', clientSource.includes('这次渲染用的：') === false
  && clientSource.includes('（配图常常只在这份里）') === false
  && clientSource.includes('两份正文的配图不一定一样') && clientSource.includes('需在设置里开允许直连'))
check('动作区只有一个大主按钮（推送），其余是次级键', (clientSource.match(/className: 'gzh-btn gzh-btn--go'/g) ?? []).length === 1
  && clientSource.includes("gzh-chip${autoPlace ? ' gzh-chip--on' : ''}") && clientSource.includes("className: 'gzh-duo'"))
check('本次渲染的 ✗ 行只说后果，补救办法压成一句', clientSource.includes("'✗ 没有（推会被拦）：")
  && clientSource.includes('✗ 没有（推送会被拦：') === false
  && clientSource.includes('要看 ${rendered.warnings.length} 条'))
check('设置里字段名只写名字，前提和后果挂 title', clientSource.includes("field('代理地址', 'proxyUrl', { title:")
  && clientSource.includes('代理地址（留空=直连') === false
  && clientSource.includes("field('默认摘要', 'digest', { title:") && clientSource.includes('默认摘要（≤120 字）') === false)
check('列表行和页签都能用键盘走（Tab + Enter）', (clientSource.match(/tabIndex: 0/g) ?? []).length >= 4
  && (clientSource.match(/event.key === 'Enter'/g) ?? []).length >= 3 && clientSource.includes("role: 'tab'"))
check('弹窗空状态只说下一步，不把字段清单再抄一遍', clientSource.includes('选一套照抄着改')
  && clientSource.includes('主色、卡片底色、卡片描边') === false
  && clientSource.includes('新建只要 4 项') && clientSource.includes('这里只读，配置只留一个入口'))
// 成功横幅的契约：只说「成了 + 几个数」，多行长结论一律不许回来（详情在右栏「本次渲染」和台账里）。
const describeBody = clientSource.match(/function describe\(kind, result\) \{([\s\S]*?)\n      \}\n/)?.[1] ?? ''
check('成功横幅就一句话：不拼多行、不再抄一遍右栏', describeBody.length > 300 && describeBody.length < 1600
  && /\blines\b|join\('\\n'\)|正文取自|配图 0 张通常是|先在中间审一眼|别重复点|这是内置样文/.test(describeBody) === false,
  `describe 体 ${describeBody.length}B`)
check('横幅只留两个「不点推送就发现不了」的标记，警告只报条数', describeBody.includes("' · 封面 ✗'")
  && describeBody.includes("' · 摘要 ✗'") && describeBody.includes('条（见右栏）'))
check('警告原文与封面/摘要/插图仍写在右栏「本次渲染」里', clientSource.includes("'本次渲染'")
  && clientSource.includes('rendered.warnings ?? []') && clientSource.includes("h('b', {}, '封面')")
  && clientSource.includes("h('b', {}, '摘要')") && clientSource.includes("h('b', {}, '插图')"))
check('推送横幅只报标题 + media_id；绕过项只计数，封面与正文图数留在台账行',
  describeBody.includes('已进草稿箱') && describeBody.includes("media_id=${result.mediaId ?? ''}")
  && describeBody.includes('绕过 ') && describeBody.includes('张图') === false
  && clientSource.includes('const pushMeta =') && clientSource.includes('const renderMeta ='))
check('界面上有「封面与插图交给插件排」开关，关着就不带 autoPlace',
  clientSource.includes('封面与插图交给插件排') && /autoPlace === false \? \{ \.\.\.base, autoPlace: false \}/.test(clientSource))

const settingsErrors = []
let settingsTree = null
try {
  settingsTree = mainMount.component({ openSettings: true })
} catch (cause) {
  settingsErrors.push(cause)
}
const settingsJson = settingsTree === null ? '' : JSON.stringify(settingsTree)
check('设置能打开：账号 / 皮肤 / 全局参数三块', settingsErrors.length === 0
  && settingsJson.includes('gzh-modal') && settingsJson.includes('新建账号') && settingsJson.includes('排版皮肤')
  && settingsJson.includes('全局参数'), settingsErrors.length > 0 ? settingsErrors[0].message : `${settingsJson.length}B`)
check('设置里的密钥是只写不回显（password 域 + 写一次提示）', settingsJson.includes('password')
  && settingsJson.includes('AppSecret') && clientSource.includes('写一次，只回显尾 4 位'))
check('设置里有「全局参数」页签（默认停在账号页）', settingsJson.includes('全局参数（只读）') && settingsJson.includes('当前生效的全局参数') === false)
check('全局参数在设置里只读并指回宿主配置页', clientSource.includes('当前生效的全局参数') && clientSource.includes('DSH 设置 → 插件'))

for (const cleanup of cleanups) cleanup()
check('卸载时把样式和插槽都收回去', styleNodes.size === 0)

delete globalThis.window
delete globalThis.document

const failed = checks.filter(item => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
console.log(`HTML ${built.stats.bytes}B，结构 ${JSON.stringify(built.stats)}`)
if (failed.length > 0) process.exitCode = 1
