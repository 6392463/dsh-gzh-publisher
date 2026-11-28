/**
 * 「公众号草稿推送」面板（Client 半）。
 *
 * 形态说明：这是浏览器里的 lazy-CJS 模块，唯一动作是把自己注册进宿主的模块加载器；
 * React 由页面自己的模块表提供（不打包第二份），没有 UI 组件库可 import，
 * 所以 DOM/图标/样式全部手写，颜色只用 --dsw-* 主题变量（暗色由宿主接管）。
 *
 * 三栏布局（对齐用户的用法：选 → 审 → 推）：
 *   左：点一下选账号 + 选文章（工作台没有产出时退化成粘贴 Markdown）
 *   中：大号预览，就是排完版要推的那份，审阅在这里做
 *   右：动作按钮 + 本次渲染结果 + 渲染记录 + 推送台账
 * 密钥、皮肤、全局参数一律收进右上角「设置」，主界面只剩选账号和跑流程。
 *
 * 数据来源：浏览器没有 fs，账号/文章/皮肤/台账都由 Host 的 /gzh-api 路由一次给出，
 * 每个按钮最终调的都是和 gzh_* 工具同一份实现（同一套校验、同一套去重台账）。
 *
 * @module dsh-gzh-publisher/client
 */
/* global window */
window.__ModuleLoader__.load({
  id: 'dsh-gzh-publisher',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'gzh-publisher'
    const API = '/gzh-api'
    const STYLE_ID = 'dsh-gzh-publisher-style'

    // 样式：只用 --dsw-alias-* / --dsw-specific-* / --dsh-* 变量（不写死颜色，暗色才跟得上）。
    // 密度按「工具面板」定：一行一个信息，能收进 hover 提示的话就不占版面。
    const CSS = [
      '.gzh-panel{display:flex;flex-direction:column;gap:10px;height:100%;box-sizing:border-box;overflow:auto;padding:14px 18px;' +
        'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px)}',
      '.gzh-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.gzh-title{font-size:15px;font-weight:600;letter-spacing:.01em}',
      '.gzh-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.gzh-spacer{flex:1}',
      '.gzh-stat{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;box-sizing:border-box;' +
        'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-module-platform);' +
        'color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}',
      '.gzh-stat b{color:var(--dsw-alias-label-secondary);font-weight:600}',
      // 三栏：左选择、中大预览、右操作。窄屏叠成一列（见文件末尾的 media query）。
      '.gzh-body{display:grid;grid-template-columns:minmax(224px,272px) minmax(360px,1fr) minmax(292px,356px);' +
        'gap:12px;align-items:start;flex:1;min-height:0}',
      '.gzh-col{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.gzh-card{background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;min-width:0}',
      '.gzh-cardhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:7px;' +
        'color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.03em}',
      '.gzh-cardhead b{color:var(--dsw-alias-label-secondary);font-weight:600;font-size:12px;letter-spacing:0}',
      // 一张卡只干一件事时，标题和控件排在同一行，省一屏。
      '.gzh-card--row{display:flex;align-items:center;gap:10px;padding:8px 10px}',
      '.gzh-card--row .gzh-cardhead{margin:0;flex:1;min-width:0}',
      '.gzh-list{display:flex;flex-direction:column;gap:1px;max-height:284px;overflow:auto;margin:0 -4px;padding:0 4px}',
      '.gzh-row{padding:6px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent;transition:background .12s}',
      '.gzh-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.gzh-row--on{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-selected)}',
      '.gzh-row--static{cursor:default}',
      '.gzh-rowtitle{font-size:12.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.gzh-rowmeta{color:var(--dsw-alias-label-caption);font-size:11px;margin-top:1px;word-break:break-all}',
      '.gzh-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:6px;font-size:11px;' +
        'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.gzh-tag--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.gzh-tag--ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.gzh-tag--err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.gzh-tag--off{opacity:.55}',
      '.gzh-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.gzh-bar label{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:4px}',
      '.gzh-select,.gzh-input,.gzh-textarea{background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);' +
        'border-radius:8px;padding:6px 8px;font:inherit;font-size:12.5px;max-width:100%;box-sizing:border-box}',
      '.gzh-textarea{width:100%;min-height:150px;font-family:var(--dsh-code-font-family,monospace);font-size:12px;resize:vertical;line-height:1.6}',
      '.gzh-btn{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-button-ghost-active-border);' +
        'border-radius:8px;padding:5px 11px;font:inherit;font-size:12.5px;cursor:pointer;transition:background .12s,border-color .12s}',
      '.gzh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.gzh-btn--go{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:transparent;width:100%;padding:9px 12px;font-weight:600;font-size:13px}',
      '.gzh-btn--go:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.gzh-btn:disabled{opacity:.4;cursor:default}',
      '.gzh-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.gzh-btn--on{border-color:var(--dsw-alias-border-selected);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '.gzh-btn--mini{padding:3px 9px;font-size:11.5px;border-radius:7px}',
      '.gzh-btn:focus-visible,.gzh-chip:focus-visible,.gzh-tab:focus-visible,.gzh-row:focus-visible{outline:2px solid var(--dsw-alias-border-selected);outline-offset:1px}',
      // 两个渲染动作等宽并排；次要开关做成胶囊 chip，一屏里只留一个实心主按钮（推送）。
      // 主按钮上下各留 10px：比组内 6px、卡片内其它 8px 都大一点，让人一眼看出「先渲染」和「再推」是两步。
      '.gzh-duo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px;margin-bottom:10px}',
      '.gzh-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;box-sizing:border-box;' +
        'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);' +
        'font:inherit;font-size:11.5px;cursor:pointer}',
      '.gzh-chip:hover:not(:disabled){border-color:var(--dsw-alias-border-selected);color:var(--dsw-alias-label-primary)}',
      '.gzh-chip:disabled{opacity:.4;cursor:default}',
      '.gzh-chip--on{border-color:var(--dsw-alias-border-selected);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
      '.gzh-chip i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2);flex:none}',
      '.gzh-chip--on i{background:var(--dsw-alias-state-success-primary)}',
      // 横幅：一行结论 + 一个关闭键；失败可以换行（那是给人照着修的正文）。
      '.gzh-alert{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:8px;font-size:12.5px;line-height:1.5;word-break:break-word}',
      '.gzh-alert>span:first-child{flex:1;min-width:0;white-space:pre-wrap}',
      '.gzh-alert button{background:transparent;border:0;color:inherit;font:inherit;font-size:15px;line-height:1.1;padding:0 2px;opacity:.55;cursor:pointer}',
      '.gzh-alert button:hover{opacity:1}',
      '.gzh-alert--ok{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}',
      '.gzh-alert--warn{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}',
      '.gzh-alert--err{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-secondary)}',
      // 下一步：面板自己说「现在点哪个」，那些「先…再…」的说明书就不用常驻版面了。
      '.gzh-next{display:flex;align-items:center;gap:7px;padding:2px 0 8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.gzh-next i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-selected);flex:none}',
      '.gzh-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;padding:4px 2px}',
      '.gzh-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:2px 10px;font-size:12px;line-height:1.55}',
      '.gzh-kv b{color:var(--dsw-alias-label-tertiary);font-weight:400;white-space:nowrap}',
      '.gzh-kv>div{min-width:0;word-break:break-word}',
      '.gzh-mono{font-family:var(--dsh-code-font-family,monospace);font-size:11px;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
      // 中间那一栏就是「审阅区」：高度给足，宽度按公众号正文宽度收敛，别让人在白板上脑补效果。
      '.gzh-center{gap:8px;position:sticky;top:0;box-sizing:border-box}',
      '.gzh-stage{padding:0;overflow:hidden;display:flex;flex-direction:column;gap:0}',
      '.gzh-stagebar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);' +
        'font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.gzh-stagebar b{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gzh-frame{width:100%;height:min(72vh,860px);border:0;background:var(--dsw-alias-bg-module-platform);display:block}',
      '.gzh-frame--empty{height:220px;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 24px}',
      '.gzh-warn{display:flex;flex-direction:column;gap:4px}',
      '.gzh-imgs{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-caption);max-height:132px;overflow:auto}',
      // 设置弹窗：主界面不放密钥，全在这里；遮罩吃掉点击，Esc 由按钮自己管（不绑全局键盘，避免抢宿主快捷键）。
      '.gzh-mask{position:fixed;inset:0;background:var(--dsw-alias-overlay-mask);z-index:80;display:flex;align-items:center;justify-content:center;padding:24px}',
      '.gzh-modal{width:min(940px,100%);max-height:88vh;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);' +
        'border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px var(--dsw-alias-shadow-l2)}',
      '.gzh-modalhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.gzh-modalhead b{font-size:15px}',
      '.gzh-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:8px}',
      '.gzh-tab{padding:5px 12px;border-radius:8px;font-size:12.5px;cursor:pointer;border:1px solid transparent;color:var(--dsw-alias-label-secondary)}',
      '.gzh-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.gzh-tab--on{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-selected);color:var(--dsw-alias-label-primary)}',
      '.gzh-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px;align-items:end}',
      '.gzh-field{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.gzh-field>span{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.gzh-field .gzh-input,.gzh-field .gzh-select{width:100%}',
      '.gzh-field--full{grid-column:1/-1}',
      '.gzh-colorrow{display:flex;align-items:center;gap:6px}',
      '.gzh-swatch{width:22px;height:22px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);flex:none}',
      '.gzh-split{display:grid;grid-template-columns:minmax(180px,220px) minmax(0,1fr);gap:12px;align-items:start}',
      '.gzh-note{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.6}',
      '.gzh-list::-webkit-scrollbar,.gzh-panel::-webkit-scrollbar,.gzh-imgs::-webkit-scrollbar{width:9px;height:9px}',
      '.gzh-list::-webkit-scrollbar-thumb,.gzh-panel::-webkit-scrollbar-thumb,.gzh-imgs::-webkit-scrollbar-thumb' +
        '{background:var(--dsw-alias-border-l2);background-clip:content-box;border:2px solid transparent;border-radius:9px}',
      '@media (max-width:1100px){.gzh-body{grid-template-columns:minmax(0,1fr)}.gzh-center{position:static}.gzh-frame{height:60vh}.gzh-form{grid-template-columns:minmax(0,1fr)}.gzh-split{grid-template-columns:minmax(0,1fr)}}',
    ].join('\n')

    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const node = document.createElement('style')
      node.id = STYLE_ID
      node.textContent = CSS
      document.head.appendChild(node)
      return () => node.remove()
    }

    let token = ''
    /** 所有请求都带令牌；令牌只走请求头，绝不塞进 URL（URL 会留在历史与日志里）。 */
    async function api(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-gzh-token': token },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!response.ok || payload.ok === false) {
        const cause = new Error(payload.error ?? `HTTP ${response.status}`)
        cause.hint = payload.hint ?? ''
        throw cause
      }
      return payload
    }

    async function bootstrap() {
      const boot = await api('/bootstrap')
      token = String(boot.token ?? '')
      return boot
    }

    const fmtBytes = value => {
      const bytes = Number(value ?? 0)
      return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`
    }
    const fmtTime = value => {
      const text = String(value ?? '')
      return text.length >= 16 ? text.slice(5, 16).replace('T', ' ') : text
    }
    const shortPath = path => {
      const text = String(path ?? '')
      return text.length <= 46 ? text : `…${text.slice(-44)}`
    }
    /** 空字段别传给工具：空串会盖掉账号默认值，反而触发 fail-close。 */
    const only = (key, value) => {
      const text = String(value ?? '').trim()
      return text === '' ? {} : { [key]: text }
    }

    /** 顶层兜底：面板出错只在这一格里显示一行字，别把整个页面带走。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: '' }
      }

      static getDerivedStateFromError(cause) {
        return { error: cause instanceof Error ? cause.message : String(cause) }
      }

      componentDidCatch(cause) {
        if (typeof console !== 'undefined') console.error('[gzh-publisher] 面板出错', cause)
      }

      render() {
        if (this.state.error !== '') {
          return h('div', { className: 'gzh-panel gzh-fatal' },
            h('div', { className: 'gzh-alert gzh-alert--err' }, `面板出错了：${this.state.error}`),
            h('div', { className: 'gzh-empty' }, '刷新页面可以重试；这期间 agent 侧的 gzh_* 工具不受影响。'))
        }
        return this.props.children
      }
    }

    /* ---------------- 设置弹窗（账号 / 皮肤 / 全局参数） ---------------- */

    const SKIN_FIELD_LABEL = {
      accent: '主色', cardBg: '卡片底色', cardBorder: '卡片描边', underline: '标题下划线',
      quoteBg: '引文底色', quoteText: '引文文字', heading: '标题色',
    }

    function AccountForm({ account, skins, ruleFields, onSaved, onClose, onError, busy, setBusy }) {
      const blank = { key: '', name: '', alias: '', appid: '', proxyUrl: '', author: '', digest: '', thumbMediaId: '', contentSourceUrl: '', layout: '', note: '', enabled: true }
      const [draft, setDraft] = React.useState(() => {
        const base = { ...blank, ...(account ?? {}), appsecret: '', proxyToken: '' }
        // 评论开关在账号表里是 { open, fansOnly }，表单里拍平成两个 checkbox 好绑；
        // 缺省必须和微信默认一致（开放评论、不限粉丝），别让人以为勾上才是默认。
        const comment = account?.comment ?? {}
        base.commentOpen = comment.open !== false
        base.commentFansOnly = comment.fansOnly === true
        // 贴图规则只填「这个号自己配过的那几档」：留空 = 跟随全局。
        // 绝不能拿生效值预填——那会把全局的数悄悄固化成账号级覆盖。
        const sticker = account?.sticker?.configured ?? {}
        for (const row of ruleFields ?? []) base[row.key] = String(sticker[row.key] ?? '')
        return base
      })
      const [clearSecret, setClearSecret] = React.useState(false)
      const [resetSticker, setResetSticker] = React.useState(false)
      // account === null 表示「新建」，undefined 表示还没选（父层不渲染表单）
      const isNew = account === null
      const set = (field, value) => setDraft(current => ({ ...current, [field]: value }))

      async function save() {
        setBusy('保存账号')
        try {
          const args = {
            account: draft.key,
            name: draft.name, alias: draft.alias, appid: draft.appid, proxyUrl: draft.proxyUrl,
            author: draft.author, digest: draft.digest, thumbMediaId: draft.thumbMediaId,
            contentSourceUrl: draft.contentSourceUrl, layout: draft.layout, note: draft.note,
            enabled: draft.enabled !== false,
            comment: { open: draft.commentOpen !== false, fansOnly: draft.commentFansOnly === true },
          }
          // 贴图规则只发填了数的档：空 = 不改动（和密钥同一个道理）。
          // 数值合法性不在这儿校——工具层 normalizeStickerRules 会按微信硬上限拒，错误直接冒到表单上方。
          const sticker = {}
          for (const row of ruleFields ?? []) {
            const raw = String(draft[row.key] ?? '').trim()
            if (raw !== '') sticker[row.key] = Number(raw)
          }
          if (Object.keys(sticker).length > 0) args.sticker = sticker
          if (resetSticker === true) args.sticker = null
          // 没碰过的密钥字段干脆不传：传空串在工具层等于「删掉密钥」，
          // 只改个显示名却把密钥抹了，是最难查的一种翻车。
          if (draft.appsecret !== '') args.appsecret = draft.appsecret
          if (draft.proxyToken !== '') args.proxyToken = draft.proxyToken
          if (clearSecret === true) { args.appsecret = ''; args.proxyToken = '' }
          await api('/call', { tool: 'gzh_account_set', args })
          onSaved(`账号「${draft.name || draft.key}」已保存${clearSecret === true ? '（密钥已清除）' : ''}`)
        } catch (cause) {
          onError('保存账号', cause)
        } finally {
          setBusy('')
        }
      }

      async function remove() {
        setBusy('删除账号')
        try {
          await api('/call', { tool: 'gzh_account_remove', args: { account: draft.key } })
          onSaved(`账号「${draft.key}」已删除（推送台账保留，它是历史事实）`)
          onClose()
        } catch (cause) {
          onError('删除账号', cause)
        } finally {
          setBusy('')
        }
      }

      // 字段名只写名字，括号里那些前提/后果挂到 title 上，鼠标停住就能看到。
      const field = (label, key, extra) => h('label', { className: 'gzh-field', key: key || label, title: extra?.title ?? '' },
        h('span', {}, label),
        h('input', {
          className: 'gzh-input',
          value: String(draft[key] ?? ''),
          placeholder: extra?.placeholder ?? '',
          type: extra?.type ?? 'text',
          disabled: extra?.disabled === true,
          onChange: event => set(key, event.target.value),
        }))

      return h('div', { className: 'gzh-form' },
        field('账号 key', 'key', { title: '推送时用它选号；建好后别改，台账按它记账', disabled: !isNew, placeholder: '例如 my-gzh' }),
        field('显示名', 'name', { placeholder: '例如 我的日更号' }),
        field('appid', 'appid', { placeholder: 'wx 开头' }),
        field('代理地址', 'proxyUrl', { title: '留空 = 直连 api.weixin.qq.com：要在配置里开「允许直连」并把本机 IP 加进微信白名单。请填 https——AppSecret 和代理令牌都要经过这个地址', placeholder: 'https://your-proxy/wxproxy' }),
        field('作者', 'author'),
        field('默认摘要', 'digest', { title: '≤120 字；留空则由插件摘正文第一段（autoDigest）' }),
        field('封面 media_id', 'thumbMediaId', { title: '号级默认封面；渲染时没自动挑到就用它' }),
        field('「阅读原文」链接', 'contentSourceUrl'),
        h('label', { className: 'gzh-field' },
          h('span', {}, '排版皮肤'),
          h('select', { className: 'gzh-select', value: String(draft.layout ?? ''), onChange: event => set('layout', event.target.value) },
            h('option', { value: '' }, '（用全局默认）'),
            ...skins.map(skin => h('option', { key: skin.key, value: skin.key }, `${skin.label}${skin.builtIn ? '' : '（自定义）'}`)))),
        h('div', { className: 'gzh-field gzh-field--full', title: '写进草稿；推完在微信后台还能改' },
          h('span', {}, '评论区'),
          h('label', { className: 'gzh-bar' },
            h('input', { type: 'checkbox', checked: draft.commentOpen !== false, onChange: event => set('commentOpen', event.target.checked) }), '开放评论'),
          h('label', { className: 'gzh-bar', title: '不勾 = 谁都能评' },
            h('input', { type: 'checkbox', checked: draft.commentFansOnly === true, onChange: event => set('commentFansOnly', event.target.checked) }), '仅关注者可评论')),
        // 贴图是「形式固定、只换内容」的那种日更，形式规范却常常是这个号自己的口径：
        // 单图消息形式的号 6 张起步就是错的。所以这四档在这里改，不用去求 agent 写 JSON。
        h('div', { className: 'gzh-field gzh-field--full', title: '留空 = 这一档跟随全局配置／内置默认。上限是微信的墙，填超了保存会被拒（错误会写在上面）' },
          h('span', {}, '贴图规则（这个号自己的口径）'),
          ...(ruleFields ?? []).map(row => h('label', { className: 'gzh-bar', key: row.key, title: row.hint },
            h('span', {}, row.label),
            h('input', {
              className: 'gzh-input', style: { width: '84px' }, inputMode: 'numeric',
              value: String(draft[row.key] ?? ''), placeholder: `全局 ${row.value ?? '—'}`,
              onChange: event => set(row.key, event.target.value),
            }))),
          h('label', { className: 'gzh-bar', title: '勾上再保存：删掉这个号的全部贴图覆盖，四档都回到全局／内置默认' },
            h('input', { type: 'checkbox', checked: resetSticker, onChange: event => setResetSticker(event.target.checked) }), '四档全部跟随全局')),
        field('备注', 'note'),
        h('label', { className: 'gzh-field' },
          h('span', {}, 'AppSecret（写一次，只回显尾 4 位）'),
          h('input', {
            className: 'gzh-input', type: 'password', value: draft.appsecret, autoComplete: 'off',
            placeholder: account?.hasAppsecret === true ? `已配 ${account.appsecret ?? ''}｜留空则不改动` : '未配置',
            onChange: event => set('appsecret', event.target.value),
          })),
        h('label', { className: 'gzh-field' },
          h('span', {}, '代理密钥（写一次，只回显尾 4 位）'),
          h('input', {
            className: 'gzh-input', type: 'password', value: draft.proxyToken, autoComplete: 'off',
            placeholder: account?.hasProxyToken === true ? `已配 ${account.proxyToken ?? ''}｜留空则不改动` : '未配置',
            onChange: event => set('proxyToken', event.target.value),
          })),
        h('div', { className: 'gzh-field gzh-field--full' },
          h('label', { className: 'gzh-bar', title: '取消后这个号的推送动作会被直接拒' },
            h('input', { type: 'checkbox', checked: draft.enabled !== false, onChange: event => set('enabled', event.target.checked) }), '启用'),
          h('label', { className: 'gzh-bar', title: '保存时把 AppSecret 和代理密钥一起清掉' },
            h('input', { type: 'checkbox', checked: clearSecret, onChange: event => setClearSecret(event.target.checked) }), '清除密钥'),
          h('div', { className: 'gzh-note' }, '落款 / 资料领取 / 每节小标签：让 agent 用 gzh_account_set 改。')),
        h('div', { className: 'gzh-field gzh-field--full gzh-bar' },
          h('button', { className: 'gzh-btn', disabled: busy !== '' || draft.key === '', onClick: save }, busy === '保存账号' ? '保存中…' : '保存'),
          isNew === false && h('button', {
            className: 'gzh-btn gzh-btn--danger', disabled: busy !== '', onClick: remove,
            title: '推送台账会保留，它是历史事实',
          }, busy === '删除账号' ? '删除中…' : '删除账号'),
          h('button', { className: 'gzh-btn', onClick: onClose }, '关闭')))
    }

    function SkinForm({ skin, fields, onSaved, onClose, onError, busy, setBusy }) {
      const [key, setKey] = React.useState(skin?.key ?? '')
      const [label, setLabel] = React.useState(skin?.label ?? '')
      const [colors, setColors] = React.useState(() => ({ ...(skin?.colors ?? {}) }))
      // skin === null 表示「新建一套」，undefined 表示还没选（父层不渲染表单）
      const isNew = skin === null
      const isBuiltIn = skin?.builtIn === true

      async function save() {
        setBusy('保存皮肤')
        try {
          const args = { skin: key, label }
          for (const field of fields) if (String(colors[field] ?? '') !== '') args[field] = colors[field]
          await api('/call', { tool: 'gzh_skin_set', args })
          onSaved(`皮肤「${label || key}」已保存`)
        } catch (cause) {
          onError('保存皮肤', cause)
        } finally {
          setBusy('')
        }
      }

      async function remove() {
        setBusy('删除皮肤')
        try {
          const result = (await api('/call', { tool: 'gzh_skin_remove', args: { skin: key } })).result ?? {}
          onSaved(result.removed === true ? `皮肤「${key}」已删除` : `没删掉：${result.reason ?? '未知原因'}`)
          onClose()
        } catch (cause) {
          onError('删除皮肤', cause)
        } finally {
          setBusy('')
        }
      }

      return h('div', { className: 'gzh-form' },
        h('label', { className: 'gzh-field', title: '小写字母 / 数字 / - / _，2-32 位；账号的「排版皮肤」就填它' },
          h('span', {}, '皮肤 key'),
          h('input', { className: 'gzh-input', value: key, disabled: !isNew, placeholder: '例如 x-mine', onChange: event => setKey(event.target.value) })),
        h('label', { className: 'gzh-field' },
          h('span', {}, '显示名'),
          h('input', { className: 'gzh-input', value: label, placeholder: '例如 我的蓝', onChange: event => setLabel(event.target.value) })),
        ...fields.map(field => h('div', { className: 'gzh-field', key: field },
          h('span', {}, SKIN_FIELD_LABEL[field] ?? field),
          h('div', { className: 'gzh-colorrow' },
            h('div', { className: 'gzh-swatch', style: { background: String(colors[field] ?? 'transparent') } }),
            h('input', {
              className: 'gzh-input', value: String(colors[field] ?? ''), placeholder: '#RRGGBB',
              onChange: event => setColors(current => ({ ...current, [field]: event.target.value })),
            })))),
        isBuiltIn === true && h('div', { className: 'gzh-field gzh-field--full gzh-note' },
          '内置皮肤只读：换个自己的 key 另存一套就能改配色。'),
        h('div', { className: 'gzh-field gzh-field--full gzh-bar' },
          h('button', {
            className: 'gzh-btn', disabled: busy !== '' || key === '' || isBuiltIn === true, onClick: save,
            title: isBuiltIn === true ? '内置皮肤不可覆盖，请换个 key' : '',
          }, busy === '保存皮肤' ? '保存中…' : (isBuiltIn === true ? '内置皮肤只读' : '保存')),
          isBuiltIn === false && isNew === false && h('button', { className: 'gzh-btn gzh-btn--danger', disabled: busy !== '', onClick: remove }, '删除皮肤'),
          h('button', { className: 'gzh-btn', onClick: onClose }, '关闭')))
    }

    function Settings({ snapshot, onNotify, onError, busy, setBusy, onClose }) {
      const [tab, setTab] = React.useState('accounts')
      // null = 在填新建表单，undefined = 没选任何一条。
      // 一个号都没有时直接落在新建表单上：首次配置的人不该先去读一段说明。
      const [editingAccount, setEditingAccount] = React.useState(snapshot.accounts.length === 0 ? null : undefined)
      const [editingSkin, setEditingSkin] = React.useState(undefined)
      // 字段清单从内置第一套皮肤的 colors 键读出来，不在前端抄一份，避免和 layout.js 走散
      const skinFields = Object.keys((snapshot.skins ?? [])[0]?.colors ?? {})

      function saved(text) {
        onNotify(text)
        onClose()
      }

      const accountRow = entry => h('div', {
        key: entry.key,
        className: `gzh-row${editingAccount?.key === entry.key ? ' gzh-row--on' : ''}`,
        tabIndex: 0,
        title: `${entry.key}｜${entry.layoutKnown === false ? `皮肤「${entry.layout}」不存在，实际用「${entry.layoutLabel}」` : entry.layoutLabel}`
          + `｜${String(entry.proxyUrl ?? '') === '' ? '直连（需在配置里开允许直连 + IP 白名单）' : `代理 ${entry.proxyUrl}`}`
          + `${entry.hasAppsecret === true ? '' : '｜缺 AppSecret，推送会被拦'}${entry.comment?.open === false ? '｜评论已关闭' : ''}`,
        onClick: () => { setEditingSkin(undefined); setEditingAccount(entry) },
        onKeyDown: event => { if (event.key === 'Enter') { setEditingSkin(undefined); setEditingAccount(entry) } },
      },
      h('div', { className: 'gzh-rowtitle' }, `${entry.name || entry.key}${entry.enabled === false ? '（已停用）' : ''}`),
      h('div', { className: 'gzh-rowmeta' },
        `${entry.key} · ${entry.layoutLabel} · 密钥 ${entry.hasAppsecret === true ? '✓' : '✗'} · ${String(entry.proxyUrl ?? '') === '' ? '直连' : '代理'}`
        + `${entry.comment?.open === false ? ' · 评论关' : ''}`))

      const skinRow = entry => h('div', {
        key: entry.key,
        className: `gzh-row${editingSkin?.key === entry.key ? ' gzh-row--on' : ''}`,
        tabIndex: 0,
        title: `key ${entry.key}｜${entry.builtIn === false ? '自定义，可改可删' : '内置，只读'}`,
        onClick: () => { setEditingAccount(undefined); setEditingSkin(entry) },
        onKeyDown: event => { if (event.key === 'Enter') { setEditingAccount(undefined); setEditingSkin(entry) } },
      },
      h('div', { className: 'gzh-rowtitle' }, `${entry.label}${entry.builtIn === false ? '（自定义）' : ''}`),
      h('div', { className: 'gzh-rowmeta gzh-colorrow' },
        h('div', { className: 'gzh-swatch', style: { background: String(entry.accent ?? 'transparent') } }), entry.key))

      const tabButton = (id, text) => h('div', {
        className: `gzh-tab${tab === id ? ' gzh-tab--on' : ''}`, role: 'tab', tabIndex: 0, 'aria-selected': tab === id,
        onClick: () => setTab(id), onKeyDown: event => { if (event.key === 'Enter') setTab(id) },
      }, text)

      return h('div', { className: 'gzh-mask' },
        h('div', { className: 'gzh-modal' },
          h('div', { className: 'gzh-modalhead' },
            h('b', {}, '设置'),
            h('div', { className: 'gzh-spacer' }),
            h('button', { className: 'gzh-btn gzh-btn--mini', onClick: onClose }, '完成')),
          h('div', { className: 'gzh-tabs', role: 'tablist' },
            tabButton('accounts', `账号（${snapshot.accounts.length}）`),
            tabButton('skins', `排版皮肤（${snapshot.skins.length}）`),
            tabButton('global', '全局参数（只读）')),

          tab === 'accounts' && h('div', { className: 'gzh-split' },
            h('div', { className: 'gzh-col' },
              h('div', { className: 'gzh-card' },
                h('div', { className: 'gzh-cardhead' }, h('b', {}, '已配置的号'),
                  h('span', { title: '点一行改它；AppSecret 与代理密钥只写不回显' }, '点一个改')),
                snapshot.accounts.length === 0
                  ? h('div', { className: 'gzh-empty' }, '还没有账号：点下面「新建账号」。')
                  : h('div', { className: 'gzh-list' }, ...snapshot.accounts.map(accountRow)),
                h('div', { className: 'gzh-bar', style: { marginTop: '8px' } },
                  h('button', {
                    className: 'gzh-btn', disabled: busy !== '',
                    onClick: () => { setEditingSkin(undefined); setEditingAccount(null) },
                  }, '新建账号')))),
            h('div', { className: 'gzh-card' },
              editingAccount === undefined
                ? h('div', { className: 'gzh-empty' }, '新建只要 4 项：key（自己起，推送时用它）、显示名、appid、appsecret。走代理再填代理地址 + 代理密钥。')
                : h(AccountForm, {
                  key: editingAccount?.key ?? 'new',
                  account: editingAccount, skins: snapshot.skins,
                  ruleFields: snapshot.stickerDefaults?.fields ?? [],
                  onSaved: saved, onClose: () => setEditingAccount(undefined),
                  onError, busy, setBusy,
                }))),

          tab === 'skins' && h('div', { className: 'gzh-split' },
            h('div', { className: 'gzh-col' },
              h('div', { className: 'gzh-card' },
                h('div', { className: 'gzh-cardhead' }, h('b', {}, '皮肤'), '内置 4 套只读，自定义可增删'),
                h('div', { className: 'gzh-list' }, ...snapshot.skins.map(skinRow)),
                h('div', { className: 'gzh-bar', style: { marginTop: '8px' } },
                  h('button', {
                    className: 'gzh-btn', disabled: busy !== '',
                    onClick: () => { setEditingAccount(undefined); setEditingSkin(null) },
                  }, '新建皮肤')))),
            h('div', { className: 'gzh-card' },
              editingSkin === undefined
                ? h('div', { className: 'gzh-empty' }, '选一套照抄着改，或新建一套：一套皮肤就是 7 个颜色字段。存好后回到「账号」里选给它。')
                : h(SkinForm, {
                  key: editingSkin?.key ?? 'new-skin',
                  skin: editingSkin, fields: skinFields,
                  onSaved: saved, onClose: () => setEditingSkin(undefined),
                  onError, busy, setBusy,
                }))),

          tab === 'global' && h('div', { className: 'gzh-col' },
            h('div', { className: 'gzh-alert gzh-alert--warn' }, snapshot.configNote),
            h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '当前生效的全局参数')),
              h('div', { className: 'gzh-kv' },
                h('b', {}, '默认账号'), h('div', {}, snapshot.config.defaultAccount || '（未设，用列表第一个）'),
                h('b', {}, '默认皮肤'), h('div', {}, snapshot.config.defaultLayout),
                h('b', {}, '工作台目录'), h('div', { className: 'gzh-mono' }, snapshot.config.mediaDeskDir || '（默认 ~/.dsh/media-desk）'),
                h('b', {}, '数据目录'), h('div', { className: 'gzh-mono' }, snapshot.config.dataDir),
                h('b', {}, '自动摘要'), h('div', {}, snapshot.config.autoDigest ? '开' : '关'),
                h('b', {}, '允许直连'), h('div', {}, snapshot.config.allowDirectApi ? '开（记得加 IP 白名单）' : '关（必须配代理地址）'),
                h('b', {}, '单图上限'), h('div', {}, `${snapshot.config.maxImageMb}MB`),
                h('b', {}, '长边上限'), h('div', {}, `${snapshot.config.imageMaxEdge}px`),
                h('b', {}, '超时'), h('div', {}, `${snapshot.config.timeoutMs}ms`),
                h('b', {}, '压图引擎'), h('div', {}, snapshot.engine?.ready === true ? `就绪（Pillow ${snapshot.engine.version}）` : `不可用：${snapshot.engine?.error ?? '未探测'}`))),
            // 贴图的形式规范：这四个数是「推送会被拦」的那四道闸，只读页必须看得见生效值与来源，
            // 否则用户只能靠面板上那句提示去猜是哪一层配的。
            h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '贴图形式规范（生效值）'),
                h('span', { title: `微信硬上限：标题 ${snapshot.stickerDefaults?.hard?.title ?? '—'} 字／图 ${snapshot.stickerDefaults?.hard?.images ?? '—'} 张／摘要 ${snapshot.stickerDefaults?.hard?.digest ?? '—'} 字——这一档不在这里配，force 也绕不过` },
                  snapshot.stickerDefaults?.summary ?? '')),
              h('div', { className: 'gzh-kv' },
                ...(snapshot.stickerDefaults?.fields ?? []).map(row => h('div', { key: row.key },
                  h('b', { title: row.hint }, row.label),
                  h('div', {}, `${row.value ?? '—'}（可填 ${row.min}~${row.max}｜来源 ${snapshot.stickerDefaults?.sources?.[row.key] ?? '内置默认'}`))),
                h('b', {}, '怎么改'), h('div', {}, '全局档：DSH 设置 → 插件 → 公众号草稿推送 → 配置；单号档：左边「账号」里那四条。生效顺序：本次调用参数 > 账号 > 全局 > 内置默认。'))),
            h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '文件位置')),
              h('div', { className: 'gzh-kv' },
                ...Object.entries(snapshot.files ?? {}).map(([name, path]) => h('div', { key: name, className: 'gzh-mono', style: { gridColumn: '1/-1' } }, `${name}：${path}`))),
              h('div', { className: 'gzh-note' }, '改这些参数：DSH 设置 → 插件 → 公众号草稿推送 → 配置。这里只读，配置只留一个入口。')))))
    }

    /* ---------------- 主面板 ---------------- */

    function Panel(props) {
      const [snapshot, setSnapshot] = React.useState({
        enabled: true, config: {}, configNote: '', files: {}, engine: null,
        accounts: [], skins: [], articles: [], mediaDesk: {}, pushes: [], renders: [],
      })
      const [account, setAccount] = React.useState('')
      const [itemId, setItemId] = React.useState('')
      // 一篇稿子在工作台里常常有两份正文：state.json 里那份、条目目录导出的那份 .md。
      // 配图经常只写在导出那份里，而面板以前只会用默认的 state，宿主警告里说「改 markdownFrom」用户根本无从下手。
      const [markdownFrom, setMarkdownFrom] = React.useState('')
      // 默认让插件决定封面与插图位置（关掉就完全照原稿顺序）。工具端是 autoPlace!==false，
      // 所以只有关掉时才需要把参数带过去。
      const [autoPlace, setAutoPlace] = React.useState(true)
      const [markdown, setMarkdown] = React.useState('')
      const [force, setForce] = React.useState(false)
      const [reason, setReason] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [alert, setAlert] = React.useState(null)
      const [rendered, setRendered] = React.useState(null)
      const [pushed, setPushed] = React.useState(null)
      // 贴图（图片消息）是平行的一条链路：没有版式能预览，能核对的只有「选了哪几张图 + 那句说明」，
      // 而图一旦推上去就占号上的永久素材名额，所以面板逼人先看一次 planOnly 的选图计划。
      const [sticker, setSticker] = React.useState(null)
      // 推之前还能改的东西（标题 / 说明 / 纯图 / 换封面 / 排掉某张）先攒在这里：
      // 图相关的改动立刻 re-plan（还是不联网），文字类的改动跟着「推」那一下才发出去。
      const [stickerEdit, setStickerEdit] = React.useState(null)
      // 素材名额体检（gzh_material_audit）的结果：贴图每张图都占号上一格，推的人最该看见这个数。
      const [audit, setAudit] = React.useState(null)
      const [preview, setPreview] = React.useState({ title: '', file: '', html: '' })
      const [settingsOpen, setSettingsOpen] = React.useState(props.openSettings === true)
      // 常驻提醒（停用 / 没账号）看完就能收掉；下一次状态变了它自然会再出现。
      const [dismissed, setDismissed] = React.useState('')

      const load = React.useCallback(async (refreshOnly) => {
        try {
          const next = refreshOnly === true ? await api('/meta') : await bootstrap()
          setSnapshot(current => ({ ...current, ...next }))
          setAccount(current => (next.accounts ?? []).some(row => row.key === current)
            ? current
            : (next.config?.defaultAccount || (next.accounts ?? [])[0]?.key || ''))
          if (Array.isArray(next.articles)) setSnapshot(current => ({ ...current, articles: next.articles }))
        } catch (cause) {
          setAlert({ level: 'err', text: `加载失败：${cause.message}${cause.hint ? `｜${cause.hint}` : ''}（宿主刚重启过就刷新页面）` })
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const run = async () => {
          if (alive) await load(false)
        }
        run()
        return () => {
          alive = false
        }
      }, [load])

      const accounts = snapshot.accounts ?? []
      const items = snapshot.articles ?? []
      const skins = snapshot.skins ?? []
      const pushes = snapshot.pushes ?? []
      const renders = snapshot.renders ?? []
      const selected = items.find(item => item.id === itemId) ?? null
      const activeAccount = accounts.find(entry => entry.key === account) ?? null
      const noDesk = snapshot.mediaDesk?.missing === true || items.length === 0

      function reset() {
        setRendered(null)
        setPushed(null)
        setAlert(null)
      }

      /** 一次动作 → 一条结果行；失败原样显示（含工具给的 hint）。 */
      async function run(kind, tool, args, after) {
        setBusy(kind)
        setAlert(null)
        try {
          const result = (await api('/call', { tool, args })).result ?? {}
          after?.(result)
          const warn = Array.isArray(result.warnings) && result.warnings.length > 0
          setAlert({ level: warn ? 'warn' : 'ok', text: describe(kind, result) })
        } catch (cause) {
          setAlert({ level: 'err', text: `${kind}失败：${cause.message}${cause.hint ? `｜${cause.hint}` : ''}` })
        } finally {
          setBusy('')
        }
      }

      /**
       * 预览走 /preview 拿 HTML 文本，再用 iframe srcDoc 渲染：
       * srcdoc 的 iframe 与页面同源但没有脚本权限，排版的 <style>/内联样式照样生效；
       * 把令牌拼进 iframe 的 URL 反而会把令牌留在网络日志里。
       */
      async function showPreview(file, title) {
        if (String(file ?? '') === '') return
        try {
          const found = await api(`/preview?file=${encodeURIComponent(file)}`)
          setPreview({ title: String(title ?? ''), file: String(file), html: String(found.html ?? '') })
        } catch (cause) {
          setAlert({ level: 'warn', text: `预览读不到：${cause.message}` })
        }
      }

      /**
       * 成功就一句话：结构、封面、摘要、插图、renderId 右栏「本次渲染」里逐行都有，台账也有，
       * 横幅不再抄一遍。只保留两个「不点推送就发现不了」的硬缺（封面 / 摘要）当标记。
       * 失败不经过这里——run() 的 catch 原样显示工具的 message + hint，那种长是必要的。
       */
      function describe(kind, result) {
        if (kind === '渲染' || kind === '传图渲染') {
          const stats = result.stats ?? {}
          const cover = result.cover ?? {}
          const warn = Array.isArray(result.warnings) ? result.warnings.length : 0
          // 只渲染时 thumbMediaId 本来就是空的，那不算缺封面；两边都空才算。
          const noCover = String(cover.src ?? '') === '' && String(cover.thumbMediaId ?? '') === ''
          return `已渲染《${result.title ?? ''}》· ${stats.sections ?? 0} 节 / ${stats.paragraphs ?? 0} 段 / 配图 ${stats.images ?? 0} 张 · ${fmtBytes(stats.bytes)}`
            + (noCover ? ' · 封面 ✗' : '')
            + (String(result.digest ?? '') === '' ? ' · 摘要 ✗' : '')
            + (warn > 0 ? ` · ⚠ ${warn} 条（见右栏）` : '')
        }
        if (kind === '排版样稿') return `样稿已在中间显示（皮肤「${result.skin ?? ''}」）`
        if (kind === '推送草稿') {
          const skipped = result.skippedChecks ?? {}
          const bypassed = Object.keys(skipped).filter(key => skipped[key] !== null && skipped[key] !== undefined).length
          return `已进草稿箱 · 《${result.title ?? ''}》· media_id=${result.mediaId ?? ''}`
            + (bypassed > 0 ? ` · ⚠ 绕过 ${bypassed} 项（见推送台账）` : '')
        }
        // 贴图没有「几节几段」可报：能报的就图数与说明字数，多出来的都留在右栏卡片里。
        if (kind === '贴图选图' || kind === '推贴图') {
          const plan = kind === '贴图选图' ? (result.plan ?? {}) : result
          const imgs = plan.images ?? []
          const warn = kind === '贴图选图' ? (plan.warnings ?? []).length : 0
          return `${kind === '推贴图' ? '贴图已进草稿箱' : '贴图选图'} · 《${plan.title ?? ''}》· ${imgs.length} 图`
            + (kind === '推贴图' ? `（新传 ${result.uploadedNow ?? 0}／复用 ${result.reused ?? 0}）· media_id=${result.mediaId ?? ''}`
              : `（封面 ${imgs[0]?.fileName ?? '✗'}）· 说明 ${[...(plan.content ?? '')].length} 字`)
            + ((plan.skipped ?? []).length > 0 ? ` · 跳过 ${plan.skipped.length} 张` : '')
            + (warn > 0 ? ` · ⚠ ${warn} 条（见右栏）` : '')
        }
        if (kind === '回读') {
          return result.ok === true
            ? `草稿箱已确认：${result.found?.title ?? result.checked?.mediaId ?? ''}`
            : `回读有问题：${(result.problems ?? []).join('；')}`
        }
        // 素材体检报的是「贴图占了几格永久素材」，不是这次推了什么；口径（下界还是真数）先说清。
        if (kind === '素材体检') {
          const m = result.materials ?? {}
          const s = result.stickerLedger ?? {}
          return `素材名额 · ${result.account ?? ''}：贴图用过 ${s.distinctImages ?? 0} 张不同图，台账记着 ${m.tracked ?? 0} 格`
            + (typeof m.wechatImage === 'number' ? ` · 微信报 ${m.wechatImage} 张` : ' · 未联网（下界，要真数让 agent 跑 live）')
            + ((s.singleUse ?? 0) > 0 ? ` · ${s.singleUse} 张只用过一次` : '')
            + (typeof result.alarm === 'string' && result.alarm !== '' ? ' · ⚠ 到了你设的提醒线' : '')
        }
        return `已完成：${String(result.file ?? '') || (result.ok === true ? 'ok' : '')}`
      }

      const renderArgs = () => {
        const base = markdown.trim() !== ''
          ? { account, markdown }
          : (markdownFrom === '' ? { account, itemId } : { account, itemId, markdownFrom })
        return autoPlace === false ? { ...base, autoPlace: false } : base
      }
      const hasSource = markdown.trim() !== '' || itemId !== ''
      const canWork = snapshot.enabled !== false && account !== '' && busy === ''
      const canRender = canWork && hasSource
      // 推送只在「这次会话里真的渲染成功」之后可用，推完立刻再锁上：
      // 宿主要求 renderId 对得上渲染台账，界面上就别给出绕过它的入口。
      const canPush = canWork && rendered !== null && pushed === null && (force !== true || reason.trim() !== '')
      // 贴图只吃工作台条目里登记的配图（cover + images）。粘贴的 Markdown 里没有「哪张当封面」这件事，
      // 所以粘贴正文时这两个按钮是灰的，而不是让用户选出一堆想不到的图。
      const canSticker = canWork && itemId !== ''
      const canStickerPush = canSticker && sticker !== null && pushed === null && String((sticker.plan ?? {}).itemId ?? '') === itemId && (force !== true || reason.trim() !== '')
      const accountLabel = activeAccount === null ? '（未选）' : `${activeAccount.name || activeAccount.key}｜${activeAccount.layoutLabel}`
      // 台账那两行现在要带封面与正文图数（老记录没这两个字段，就不显示，别编）。
      const renderMeta = entry => `${entry.layoutLabel ?? entry.layout} · ${fmtTime(entry.at)}`
        + (entry.bodyImages === undefined ? '' : ` · 封面 ${(entry.thumbMediaId ?? '') !== '' ? '✓' : entry.coverFrom === 'auto' ? '挑好未传' : '✗'} · 正文 ${entry.bodyImages} 图${(entry.placed ?? 0) > 0 ? `（自动插 ${entry.placed}）` : ''}`)
      const pushMeta = entry => (entry.error !== undefined && entry.error !== null && entry.error !== ''
        ? `失败：${entry.error}`
        : `media_id=${entry.mediaId ?? ''}${entry.forced === true ? '（强制重推）' : ''} · ${fmtTime(entry.at)}`)
        + (entry.thumbMediaId === undefined ? '' : ` · 封面 ${(entry.thumbMediaId ?? '') !== '' ? '✓' : '✗（force 推的）'} · 正文 ${entry.bodyImages ?? 0} 图`)
        + (entry.articleType === 'newspic' ? ` · 贴图 ${entry.images ?? 0} 图（封面 ${entry.coverImage ?? '?'}）` : '')

      // 贴图卡片只有一份数据可看：planOnly 的选图计划（还没推），或刚推成的那条。
      // 两者字段不一样长，这里归一成一份，卡片里就只管画。
      const stickerView = (() => {
        if (pushed !== null && pushed.articleType === 'newspic') {
          return {
            pushed: true, mediaId: String(pushed.mediaId ?? ''), title: pushed.title ?? '',
            content: pushed.content ?? '', contentFrom: pushed.contentFrom ?? '', digest: pushed.digest ?? null,
            digestFrom: pushed.digestFrom ?? '', skipped: [], warnings: pushed.warnings ?? [], stale: false,
            quota: pushed.quota ?? null, repeat: pushed.repeatImages ?? [], rules: pushed.rules ?? null,
            rows: (pushed.images ?? []).map((row, index) => `${index === 0 ? '封面 ' : ''}${row.fileName ?? ''} ${fmtBytes(row.bytes)}｜${row.uploaded === false ? `复用素材 ${row.mediaId}` : `已传成永久素材 ${row.mediaId ?? ''}`}`),
          }
        }
        if (sticker === null) return null
        const plan = sticker.plan ?? {}
        return {
          pushed: false, mediaId: '', title: plan.title ?? '', content: plan.content ?? '',
          contentFrom: plan.contentFrom ?? '', digest: plan.digest ?? null, digestFrom: plan.digestFrom ?? '',
          skipped: plan.skipped ?? [], warnings: plan.warnings ?? [],
          stale: itemId !== '' && String(plan.itemId ?? '') !== itemId,
          quota: plan.quota ?? null, repeat: plan.repeatImages ?? [], rules: plan.rules ?? null,
          rows: (plan.images ?? []).map((row, index) => `${index === 0 ? '封面 ' : ''}${row.fileName ?? ''} ${fmtBytes(row.bytes)}｜${row.source ?? ''}`),
        }
      })()

      // 贴图的形式规范：数字一律从后端要（plan.rules > 账号 sticker > 全局 stickerDefaults）。
      // 面板里不出现 6/20/1000 这些字面量，否则改了配置页面还在说老规矩。
      const sFallback = snapshot.stickerDefaults ?? {}
      const sRuleSet = (stickerView === null ? null : stickerView.rules) ?? (activeAccount ?? {}).sticker ?? sFallback
      const sVals = { ...(sFallback.values ?? {}), ...((sRuleSet ?? {}).values ?? {}) }
      const sSum = String((sRuleSet ?? {}).summary ?? sFallback.summary ?? '')
      const sHard = ((sRuleSet ?? {}).hard ?? sFallback.hard) ?? {}
      const sWhere = key => String(((sRuleSet ?? {}).sources ?? {})[key] ?? (sFallback.sources ?? {})[key] ?? '内置默认')
      // 本地改动优先显示：卡片上摊开的就是「按下推会发出去的那份」。
      const sEdit = stickerEdit ?? {}
      const sTitle = sEdit.title ?? String((stickerView ?? {}).title ?? '')
      const sContent = sEdit.noText === true ? '' : (sEdit.content ?? String((stickerView ?? {}).content ?? ''))
      const sDrops = Array.isArray(sEdit.dropImages) ? sEdit.dropImages : []
      const sImages = ((sticker ?? {}).plan ?? {}).images ?? []
      // 排到最后必须还剩图：把「还剩几张」摊在按钮的 disabled 上，别让人点了报错才知道。
      const sLeft = sImages.filter(row => !sDrops.includes(row.fileName ?? '')).length
      /** 组一份给 gzh_push_sticker 的参数（不含 planOnly）：攒着的改动全在里面。 */
      const stickerBase = (next = {}) => {
        const cover = Number.isInteger(next.coverIndex) ? next.coverIndex : (Number.isInteger(sEdit.coverIndex) ? sEdit.coverIndex : null)
        const drops = Array.isArray(next.dropImages) ? next.dropImages : sDrops
        return {
          account, itemId,
          ...only('title', sTitle),
          ...(sEdit.noText === true ? { noText: true } : only('content', sContent)),
          ...(cover === null ? {} : { coverIndex: cover }),
          ...(drops.length > 0 ? { dropImages: drops } : {}),
        }
      }

      // 面板自己说「现在该点哪个」，那些「先…再…」的说明书就不用常驻在版面上。
      function nextStep() {
        if (snapshot.enabled === false) return '插件已停用：到 DSH 设置里启用'
        if (accounts.length === 0) return '到「设置」里新建一个号'
        if (account === '') return '在左上选一个号'
        if (!hasSource) return noDesk ? '把正文粘到左边' : '选一篇文章，或粘贴正文'
        if (busy !== '') return `${busy}中…`
        if (rendered === null) return '点「渲染并传图」，在中间核对版式'
        if (pushed === null) return '版式没问题就点「推送到草稿箱」'
        return '已进草稿箱；要改就重新渲染再推'
      }

      // 提示条都带一个关闭键：读完就能收掉，别一直压在面板顶上。
      const hintBar = (level, kind, text) => (dismissed === kind ? null
        : h('div', { className: `gzh-alert gzh-alert--${level}` },
          h('span', {}, text),
          h('button', { title: '收起这条提示', onClick: () => setDismissed(kind) }, '×')))

      return h('div', { className: 'gzh-panel' },
        h('div', { className: 'gzh-head' },
          h('div', { className: 'gzh-title' }, '公众号草稿推送'),
          h('div', { className: 'gzh-sub' },
            h('span', { className: 'gzh-stat' }, h('b', {}, String(accounts.length)), '个号'),
            h('span', { className: 'gzh-stat' }, h('b', {}, String(skins.length)), '套皮肤'),
            h('span', { className: 'gzh-stat' }, h('b', {}, String(items.length)), '篇工作台产出')),
          h('div', { className: 'gzh-spacer' }),
          h('button', { className: 'gzh-btn gzh-btn--mini', disabled: busy !== '', onClick: () => load(true), title: '重读账号、皮肤、工作台和台账' }, '刷新'),
          h('button', { className: 'gzh-btn gzh-btn--mini', disabled: busy !== '', onClick: () => setSettingsOpen(true), title: '账号 / 皮肤 / 全局参数（密钥只在这里填）' }, '设置')),

        snapshot.enabled === false && hintBar('err', 'off', '插件已停用，动作都会被拒：DSH 设置 → 插件 → 公众号草稿推送 里启用。'),

        accounts.length === 0 && snapshot.enabled !== false && hintBar('warn', 'noaccount', '还没有账号：设置 → 新建账号，填 key、显示名、appid、appsecret。'),

        alert !== null && h('div', { className: `gzh-alert gzh-alert--${alert.level}` },
          h('span', {}, alert.text),
          h('button', { title: '收起', onClick: () => setAlert(null) }, '×')),

        h('div', { className: 'gzh-body' },
          // 左：选账号 + 选文章（或粘贴 Markdown）
          h('div', { className: 'gzh-col' },
            h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '账号'),
                h('span', { title: '点一行选它；密钥只在「设置」里填，界面永不回显' }, '点一个选它')),
              accounts.length === 0
                ? h('div', { className: 'gzh-empty' }, '还没有账号——去「设置」里建。')
                : h('div', { className: 'gzh-list' },
                  ...accounts.map(entry => h('div', {
                    key: entry.key,
                    className: `gzh-row${entry.key === account ? ' gzh-row--on' : ''}`,
                    tabIndex: 0,
                    title: `${entry.key}｜皮肤 ${entry.layoutKnown === false ? `「${entry.layout}」找不到，退回「${entry.layoutLabel}」` : entry.layoutLabel}`
                      + `｜${String(entry.proxyUrl ?? '') === '' ? '直连（需在设置里开允许直连 + IP 白名单）' : `出口 ${entry.proxyUrl}`}`
                      + `${entry.hasAppsecret === true ? '' : '｜缺 AppSecret，推送会被拦'}`,
                    onClick: () => { setAccount(entry.key); reset() },
                    onKeyDown: event => { if (event.key === 'Enter') { setAccount(entry.key); reset() } },
                  },
                  h('div', { className: 'gzh-rowtitle' }, `${entry.name || entry.key}${entry.enabled === false ? '（已停用）' : ''}`),
                  h('div', { className: 'gzh-rowmeta' }, `${entry.key} · ${entry.layoutLabel} · 密钥 ${entry.hasAppsecret === true ? '✓' : '✗'}`
                    + `${entry.comment?.open === false ? ' · 评论关' : ''}`)))),
              account !== '' && activeAccount !== null && h('div', { className: 'gzh-rowmeta', style: { marginTop: '5px' } },
                `出口：${String(activeAccount.proxyUrl ?? '') === '' ? '直连' : activeAccount.proxyUrl}`)),

            h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' },
                h('b', {}, noDesk ? '粘贴 Markdown' : '自媒体工作台产出'),
                noDesk === false && h('span', {}, `${items.length} 篇`)),
              noDesk
                ? h('div', {},
                  h('textarea', {
                    className: 'gzh-textarea',
                    placeholder: '粘贴 Markdown 正文：# 标题 / 空行分段 / > 引用 / ![](图片地址)\n图片需是可访问的 http(s) 地址。',
                    value: markdown,
                    onChange: event => { setMarkdown(event.target.value); reset() },
                  }),
                  snapshot.mediaDesk?.missing === true && h('div', { className: 'gzh-rowmeta' }, `读不到工作台：${shortPath(snapshot.mediaDesk?.stateFile ?? '')}`))
                : h('div', { className: 'gzh-list' },
                  ...items.map(item => h('div', {
                    key: item.id,
                    className: `gzh-row${item.id === itemId ? ' gzh-row--on' : ''}`,
                    tabIndex: 0,
                    title: `${item.id}｜更新 ${fmtTime(item.updatedAt)}｜配图 ${item.images} 张`,
                    onClick: () => { setItemId(item.id); setMarkdown(''); reset() },
                    onKeyDown: event => { if (event.key === 'Enter') { setItemId(item.id); setMarkdown(''); reset() } },
                  },
                  h('div', { className: 'gzh-rowtitle' }, item.title || item.id),
                  h('div', { className: 'gzh-rowmeta' }, `${item.id} · 图 ${item.images} · ${fmtTime(item.updatedAt)}`))))),

            // 两份正文时给一个能点的开关：不然「配图 0 张」的警告用户只能干看着。
            selected !== null && selected.hasSavedMarkdown === true && h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '正文来源'),
                h('span', { title: '两份正文的配图不一定一样：渲染出「配图 0 张」但工作台明明有图，就换一份再渲染' }, '这篇有两份')),
              h('div', { className: 'gzh-bar' },
                h('button', {
                  className: `gzh-btn gzh-btn--mini${markdownFrom === 'saved' ? '' : ' gzh-btn--on'}`, disabled: busy !== '',
                  onClick: () => { setMarkdownFrom(''); setRendered(null); setPushed(null) },
                }, '工作台 state'),
                h('button', {
                  className: `gzh-btn gzh-btn--mini${markdownFrom === 'saved' ? ' gzh-btn--on' : ''}`, disabled: busy !== '',
                  onClick: () => { setMarkdownFrom('saved'); setRendered(null); setPushed(null) },
                }, '导出的 .md'))),

            h('div', { className: 'gzh-card gzh-card--row' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '排版样稿'),
                h('span', { title: '用内置样文出一份，先看配色和落款，不用真渲染一篇' }, '先看配色')),
              h('button', {
                className: 'gzh-btn gzh-btn--mini', disabled: !canWork,
                onClick: () => run('排版样稿', 'gzh_layout_preview', { account }, result => showPreview(result.file, `${result.skin} 样稿`)),
              }, busy === '排版样稿' ? '生成中…' : '出当前皮肤样稿'))),

          // 中：大号预览，就是审阅区
          h('div', { className: 'gzh-col gzh-center' },
            h('div', { className: 'gzh-card gzh-stage' },
              h('div', { className: 'gzh-stagebar' },
                h('b', {}, preview.title || (rendered === null ? '预览' : rendered.title)),
                h('span', {
                  className: `gzh-tag${pushed !== null ? ' gzh-tag--ok' : rendered !== null ? ' gzh-tag--warn' : ''}`,
                  title: pushed !== null ? '这份已进草稿箱；要改就重新渲染再推'
                    : rendered !== null ? '中间这份就是最终版式，推送前在这里核对'
                      : '还没渲染：左边选文章，右边点「渲染并上传配图」',
                }, pushed !== null ? '已推送' : rendered !== null ? '待核对' : '未渲染'),
                rendered !== null && h('span', { className: 'gzh-tag' }, `皮肤 ${rendered.skin ?? ''}`),
                rendered !== null && h('span', { className: 'gzh-tag' }, fmtBytes(rendered.stats?.bytes)),
                preview.file !== '' && h('span', { className: 'gzh-mono', title: preview.file }, shortPath(preview.file)),
                preview.file !== '' && h('div', { className: 'gzh-spacer' }),
                preview.file !== '' && h('button', {
                  className: 'gzh-btn gzh-btn--mini', disabled: busy !== '',
                  title: '复制 HTML 源码（不是渲染后的文字）',
                  onClick: async () => {
                    try {
                      await navigator.clipboard.writeText(preview.html)
                      setAlert({ level: 'ok', text: `已复制 HTML 源码（${fmtBytes(preview.html.length)}）` })
                    } catch (cause) {
                      setAlert({ level: 'warn', text: `复制失败：${cause.message}｜浏览器不给剪贴板权限时，直接打开文件另存 ${shortPath(preview.file)}` })
                    }
                  },
                }, '复制 HTML')),
              preview.html === ''
                ? h('div', { className: 'gzh-frame gzh-frame--empty' },
                  h('div', { className: 'gzh-empty' },
                    '这里就是最终推出去的版式', h('br', {}),
                    '选文章 → 渲染并上传配图 → 核对 → 推送',
                    account === '' && h('div', {}, accounts.length === 0 ? '先配一个号（右上角设置）' : '先在左上选个号。')))
                : h('iframe', {
                  className: 'gzh-frame', title: '排版预览',
                  // srcDoc 而不是 src：同域渲染、无脚本执行，令牌不进 URL。
                  srcDoc: preview.html,
                  sandbox: 'allow-same-origin',
                }))),

          // 右：动作 + 本次结果 + 台账
          h('div', { className: 'gzh-col' },
            h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '动作'), h('div', { className: 'gzh-spacer' }),
                h('span', { title: '当前账号；在左上换号' }, accountLabel)),
              h('div', { className: 'gzh-rowmeta' }, selected === null
                ? (markdown.trim() === '' ? '还没选正文' : `粘贴正文 ${markdown.length} 字`)
                : (selected.title || selected.id)),
              h('div', { className: 'gzh-next' }, h('i', {}), nextStep()),
              h('div', { className: 'gzh-duo' },
                h('button', {
                  className: 'gzh-btn', disabled: !canRender,
                  title: '图留在本地路径，只用来看版式；这种产物推出去公众号里不显示图',
                  onClick: () => run('渲染', 'gzh_render', { ...renderArgs(), upload: false }, result => {
                    setRendered(result); setPushed(null); showPreview(result.previewFile ?? result.file, result.title)
                  }),
                }, busy === '渲染' ? '渲染中…' : '只渲染（不传图）'),
                h('button', {
                  className: 'gzh-btn', disabled: !canRender,
                  title: '要推草稿箱就走这个：配图压到 1MB 以内传到微信图床，正文里的图才会真的显示',
                  onClick: () => run('传图渲染', 'gzh_render', { ...renderArgs(), upload: true }, result => {
                    setRendered(result); setPushed(null); showPreview(result.previewFile ?? result.file, result.title)
                  }),
                }, busy === '传图渲染' ? '上传中…' : '渲染并传图')),
              h('button', {
                className: 'gzh-btn gzh-btn--go', disabled: !canPush,
                title: rendered === null ? '先渲染一次，中间看到版式后才能推' : (pushed === null ? '推之前在中间核对版式' : '这次已经推过了；要再推一份请先渲染'),
                onClick: () => run('推送草稿', 'gzh_push_draft', {
                  account,
                  htmlPath: rendered.file,
                  renderId: rendered.renderId,
                  title: rendered.title,
                  // 作者/摘要不传：留给账号默认值，工具是 fail-close，空串反而会顶掉默认
                  ...only('reason', force === true ? reason : ''),
                  ...(force === true ? { force: true } : {}),
                }, result => setPushed(result)),
              }, busy === '推送草稿' ? '推送中…' : (pushed === null ? '推送到草稿箱' : '已推送（再推请重新渲染）')),
              // 贴图走的是另一条链路：draft/add 里 article_type=newspic，不排版、不要作者。
              // 形式规范是配置的（默认 6~20 图 / 标题 ≤20 字），微信硬上限才是死的：1~20 图 / 32 字。
              h('div', { className: 'gzh-duo', style: { marginTop: '8px' } },
                h('button', {
                  className: 'gzh-btn', disabled: !canSticker,
                  title: itemId === ''
                    ? '贴图用的是工作台条目里登记的配图（封面 + 配图），先在左上选一篇文章'
                    : `图片消息没有版式可排版：这一步只把「用哪几张图、第一张当封面、说明洗成什么样」列给你看，一行网络都不发（本号规范：${sSum}）`,
                  onClick: () => run('贴图选图', 'gzh_push_sticker', { account, itemId, planOnly: true }, result => { setSticker(result); setStickerEdit(null); setPushed(null) }),
                }, busy === '贴图选图' ? '核对中…' : '贴图：先看选图（不联网）'),
                h('button', {
                  className: 'gzh-btn', disabled: !canStickerPush,
                  title: sticker === null
                    ? '先看一次选图再推：每张图都会传成永久素材，占号上的素材名额，推前值得核对一眼'
                    : `把 ${sLeft} 张图和一句说明推成贴图草稿（不套皮肤、不排版、不带作者）｜本号规范 ${sSum}`
                      + (sLeft < Number(sVals.minImages ?? 0) ? `；图数不足 ${sVals.minImages} 张，会被闸门拦下——勾 force 写清原因才放行` : ''),
                  onClick: () => run('推贴图', 'gzh_push_sticker', {
                    ...stickerBase(),
                    ...(force === true ? { force: true } : {}),
                    ...only('reason', force === true ? reason : ''),
                  }, result => { setPushed(result); setSticker(null); setStickerEdit(null) }),
                }, busy === '推贴图' ? '上传中…' : '推贴图到草稿箱')),
              h('div', { className: 'gzh-bar', style: { marginTop: '8px' } },
                h('button', {
                  className: `gzh-chip${autoPlace ? ' gzh-chip--on' : ''}`,
                  disabled: busy !== '',
                  title: autoPlace
                    ? '开：正文没引用的配图按节插入，末尾甩成一串的挪回各节后面，没登记封面时从配图挑一张。关掉 = 完全照稿子顺序，封面也不自动挑。'
                    : '关：不自动插图、不自动挑封面、末尾的图也不挪。点一下交回插件安排。',
                  onClick: () => { setAutoPlace(autoPlace === false); setRendered(null); setPushed(null) },
                }, h('i', {}), `封面与插图交给插件排 · ${autoPlace ? '开' : '关'}`),
                h('div', { className: 'gzh-spacer' }),
                h('button', {
                  className: 'gzh-btn gzh-btn--mini',
                  disabled: busy !== '' || (pushed === null && rendered === null),
                  title: '确认刚推的草稿真的在草稿箱里、标题对得上',
                  onClick: () => run('回读', 'gzh_draft_verify', {
                    account,
                    ...only('mediaId', pushed?.mediaId),
                    ...only('title', pushed?.articleType === 'newspic' ? pushed.title : rendered?.title),
                    ...only('articleType', pushed?.articleType),
                  }),
                }, busy === '回读' ? '回读中…' : '回读草稿箱')),
              h('div', { className: 'gzh-bar', style: { marginTop: '4px' } },
                h('label', { title: '危险项：跳过重复推送与外链检查，必须写原因，台账留痕' },
                  h('input', { type: 'checkbox', checked: force, onChange: event => setForce(event.target.checked) }), '允许重复推送'),
                force === true && h('input', {
                  className: 'gzh-input', style: { flex: '1', minWidth: '150px' },
                  placeholder: '绕过原因（必填，进台账）',
                  value: reason, onChange: event => setReason(event.target.value),
                }))),

            rendered !== null && h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '本次渲染')),
              h('div', { className: 'gzh-kv' },
                h('b', {}, '皮肤'), h('div', {}, `${rendered.skin}（${rendered.layout}）`),
                h('b', {}, '结构'), h('div', {}, `${rendered.stats?.sections ?? 0} 节 / ${rendered.stats?.paragraphs ?? 0} 段 / ${rendered.stats?.quotes ?? 0} 引文 / ${rendered.stats?.outlineCards ?? 0} 大纲`),
                h('b', {}, '封面'), h('div', {}, (() => {
                  const cv = rendered.cover ?? {}
                  if (String(cv.src ?? '') === '' && String(cv.thumbMediaId ?? '') === '') return '✗ 没有（推会被拦）：走「渲染并传图」，或在设置里给这个号配默认封面'
                  const who = cv.from === 'auto' ? '自动挑的' : cv.from === 'account' ? '账号默认' : cv.from === 'arg' ? '你指定的' : ''
                  const what = String(cv.src ?? '') === '' ? '' : shortPath(cv.src)
                  const mid = String(cv.thumbMediaId ?? '') === '' ? '还没传成素材（推要走「渲染并传图」）' : `素材 ${cv.thumbMediaId}`
                  return `${who} ${what}${what === '' ? '' : '｜'}${mid}`
                })()),
                h('b', {}, '摘要'), h('div', {}, String(rendered.digest ?? '') === ''
                  ? '✗ 没有（推会被拦）：插件配置开 autoDigest，或给这个号配默认摘要'
                  : `${rendered.digest}（${rendered.digestFrom ?? ''}）`),
                h('b', {}, '插图'), h('div', {}, (() => {
                  const p = rendered.placement ?? {}
                  const placed = (p.placed ?? []).length
                  return `${placed === 0 ? '按原稿位置' : `自动插 ${placed} 张${p.relocated > 0 ? `（末尾挪回 ${p.relocated}）` : ''}`} · 正文 ${rendered.stats?.images ?? 0} 张`
                })()),
                h('b', {}, '配图'), h('div', {}, `${rendered.stats?.images ?? 0} 张${rendered.stats?.droppedImages > 0 ? `（丢弃 ${rendered.stats.droppedImages} 张非图床图）` : ''} · ${(rendered.images ?? []).filter(row => String(row.error ?? '') === '').length}/${(rendered.images ?? []).length} 上传成功`),
                h('b', {}, '压图'), h('div', {}, rendered.imageEngine?.ready === true ? `Pillow ${rendered.imageEngine.version}` : `未用/不可用：${rendered.imageEngine?.error ?? '—'}`),
                h('b', {}, '文件'), h('div', { className: 'gzh-mono' }, shortPath(rendered.file)),
                h('b', {}, 'renderId'), h('div', { className: 'gzh-mono' }, String(rendered.renderId ?? ''))),
              (rendered.warnings ?? []).length > 0 && h('div', { className: 'gzh-warn', style: { marginTop: '8px' } },
                h('div', { className: 'gzh-cardhead' }, h('b', {}, `要看 ${rendered.warnings.length} 条`)),
                ...rendered.warnings.map((text, index) => h('div', { key: index, className: 'gzh-alert gzh-alert--warn' }, text))),
              (rendered.images ?? []).length > 0 && h('div', { className: 'gzh-imgs', style: { marginTop: '8px' } },
                ...rendered.images.map((row, index) => h('div', { key: index },
                  `${String(row.error ?? '') === '' ? '✓' : '✗'} ${shortPath(row.src ?? '')} ${fmtBytes(row.bytes)}${row.url ? `｜${shortPath(row.url)}` : ''}${row.note ? `｜${row.note}` : ''}${row.error ? `｜${row.error}` : ''}`)))),

            // 贴图没有 iframe 可看：中间那块给它没用，就把「选了哪几张图 + 那句说明」摊在右边。
            stickerView !== null && h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '贴图（图片消息）'),
                stickerView.pushed === true
                  ? h('span', { className: 'gzh-tag gzh-tag--ok' }, `已推 ${stickerView.mediaId}`)
                  : h('span', { className: 'gzh-tag gzh-tag--warn' }, '未推送'),
                h('div', { className: 'gzh-spacer' }),
                h('span', { title: '贴图正文只支持纯文本，皮肤、小标签、落款都用不上' }, '不套皮肤'),
                h('span', { title: `这条贴图生效的形式规范：${sSum}。数字来自哪一层看下面每行的「来自…」；微信硬上限 ${sHard.images ?? '—'} 图／标题 ${sHard.title ?? '—'} 字` }, `${stickerView.rows.length} 图／规范 ${sSum}`)),
              stickerView.rows.length < Number(sVals.minImages ?? 0) && h('div', { className: 'gzh-alert gzh-alert--warn' },
                `只有 ${stickerView.rows.length} 张图，不到「${sSum}」要求的 ${sVals.minImages} 张（这条规则来自${sWhere('minImages')}）：去工作台把配图补齐，或者这条改走图文；如果这个号的形式本来就不是 ${sVals.minImages} 张起步，那是设置→账号→贴图规则该改，不该天天勾 force。`),
              stickerView.stale === true && h('div', { className: 'gzh-alert gzh-alert--warn' },
                '这份选图计划不是当前这篇文章的：换了文章就重新点一次「先看选图」，推按钮已经锁住。'),
              h('div', { className: 'gzh-kv' },
                h('b', {}, '标题'), h('div', {}, `${sTitle}（${[...sTitle].length}/${sVals.titleMax ?? '—'} 字，规范来自${sWhere('titleMax')}；微信硬上限 ${sHard.title ?? '—'} 字）`),
                h('b', {}, '说明'), h('div', {}, sContent === ''
                  ? (Number(sVals.textMax ?? 0) === 0 ? `按「纯图不写说明」推（这条规则来自${sWhere('textMax')}）` : '✗ 没有说明文字：贴图可以只发图，但微信文档写 content 必填，真被拒了就补一句再推')
                  : `${sContent}（${[...sContent].length}/${sVals.textMax ?? '—'} 字，规范来自${sWhere('textMax')}；纯文本原样送达）`),
                h('b', {}, '说明来源'), h('div', {}, String(stickerView.contentFrom)),
                h('b', {}, '摘要'), h('div', {}, stickerView.digest === null ? String(stickerView.digestFrom) : `${stickerView.digest}（${stickerView.digestFrom}）`)),
              stickerView.rows.length > 0 && h('div', { className: 'gzh-imgs', style: { marginTop: '8px' } },
                ...stickerView.rows.map((text, index) => h('div', { key: index }, text))),
              (stickerView.skipped ?? []).length > 0 && h('div', { className: 'gzh-warn', style: { marginTop: '8px' } },
                h('div', { className: 'gzh-cardhead' }, h('b', {}, `跳过了 ${stickerView.skipped.length} 张图`)),
                ...stickerView.skipped.map((row, index) => h('div', { key: index, className: 'gzh-alert gzh-alert--warn' }, `${row.source ?? ''} ${row.src ?? ''}：${row.note ?? ''}`))),
              stickerView.warnings.length > 0 && h('div', { className: 'gzh-warn', style: { marginTop: '8px' } },
                h('div', { className: 'gzh-cardhead' }, h('b', {}, `要看 ${stickerView.warnings.length} 条`)),
                ...stickerView.warnings.map((text, index) => h('div', { key: index, className: 'gzh-alert gzh-alert--warn' }, text)))),

            // 选图之后、推之前：这是唯一还能反悔的窗口（一按「推」，每张图都要传成永久素材、占号上一格）。
            // 换封面 / 排掉某张 = 立刻 re-plan（仍然不联网）；标题、说明、「纯图」开关攒着，跟「推」那一下一起发。
            stickerView !== null && stickerView.pushed === false && stickerView.stale !== true && h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '推之前改一改'),
                h('div', { className: 'gzh-spacer' }),
                audit !== null && h('span', { title: String(audit.basis ?? '') }, `本号素材 ${audit?.materials?.tracked ?? '?'} 格`),
                h('button', {
                  className: 'gzh-btn gzh-btn--mini', disabled: busy !== '' || account === '',
                  title: '按本地台账算（默认不联网）：这个号的永久素材被贴图占了多少格、多少是一次性浪费的。要微信那边的真数，让 agent 跑一次 live 体检',
                  onClick: () => run('素材体检', 'gzh_material_audit', { account }, result => setAudit(result)),
                }, busy === '素材体检' ? '体检中…' : '查素材名额')),
              h('div', { className: 'gzh-kv' },
                h('b', {}, '标题'), h('div', {},
                  h('input', {
                    className: 'gzh-input', value: sTitle, disabled: busy !== '',
                    onChange: event => setStickerEdit({ ...sEdit, title: event.target.value }),
                  }),
                  h('span', { title: `规范 ${sVals.titleMax} 字（来自${sWhere('titleMax')}）；微信硬上限 ${sHard.title ?? '—'} 字，这一档 force 也绕不过` },
                    `${[...sTitle].length}/${sVals.titleMax ?? '—'} 字${[...sTitle].length > Number(sVals.titleMax ?? 0) ? ' ← 超了，推会被拦' : ''}`)),
                h('b', {}, '说明'), h('div', {},
                  h('textarea', {
                    className: 'gzh-textarea', style: { minHeight: '68px' }, value: sContent, disabled: busy !== '' || sEdit.noText === true,
                    placeholder: '贴图说明只收纯文本：链接、图片写进来会被拦',
                    onChange: event => setStickerEdit({ ...sEdit, content: event.target.value }),
                  }),
                  h('label', { title: 'noText：就是要一张说明都没有的纯图贴图（textMax=0 的号默认如此）；不勾又清空说明，插件会以为你要用账号默认口径' },
                    h('input', {
                      type: 'checkbox', checked: sEdit.noText === true, disabled: busy !== '',
                      onChange: event => setStickerEdit({ ...sEdit, noText: event.target.checked }),
                    }), ` 不要说明文字（当前 ${[...sContent].length}/${sVals.textMax ?? '—'} 字）`)),
                h('b', {}, '配图'), h('div', {},
                  ...sImages.map((row, index) => h('div', { key: row.fileName ?? index, className: 'gzh-bar' },
                    h('span', { className: `gzh-chip${row.isCover === true ? ' gzh-chip--on' : ''}` }, `${row.position ?? index + 1} ${row.fileName ?? ''}`),
                    h('button', {
                      className: 'gzh-btn gzh-btn--mini', disabled: busy !== '' || row.isCover === true,
                      title: '把这张挪到第一位当封面（贴图没有独立封面：第一张就是）。顺序变了，台账里算新的一条',
                      onClick: () => run('贴图选图', 'gzh_push_sticker', { ...stickerBase({ coverIndex: row.position ?? index + 1 }), planOnly: true }, result => { setSticker(result); setStickerEdit(null) }),
                    }, '设封面'),
                    h('button', {
                      className: 'gzh-btn gzh-btn--mini', disabled: busy !== '' || sLeft <= 1,
                      title: sLeft - 1 < Number(sVals.minImages ?? 0) ? `排掉后只剩 ${sLeft - 1} 张，低于 ${sVals.minImages ?? '—'} 张的规范，真推得勾 force` : '这条不用这张图（重新算一次选图）',
                      onClick: () => {
                        const keep = [...sDrops, row.fileName ?? '']
                        return run('贴图选图', 'gzh_push_sticker', { ...stickerBase({ dropImages: keep }), planOnly: true },
                          result => { setSticker(result); setStickerEdit({ ...sEdit, dropImages: keep, coverIndex: null }) })
                      },
                    }, '不用这张'))),
                  sDrops.length > 0 && h('div', {}, `已排掉 ${sDrops.length} 张：${sDrops.join('、')} `,
                    h('button', {
                      className: 'gzh-btn gzh-btn--mini', disabled: busy !== '', title: '把排掉的图全要回来',
                      onClick: () => run('贴图选图', 'gzh_push_sticker', { ...stickerBase({ dropImages: [] }), planOnly: true },
                        result => { setSticker(result); setStickerEdit({ ...sEdit, dropImages: [], coverIndex: null }) }),
                    }, '全部恢复')))),
              (stickerView.quota !== null || (stickerView.repeat ?? []).length > 0) && h('div', { className: 'gzh-kv', style: { marginTop: '6px' } },
                h('b', {}, '素材名额'), h('div', {}, stickerView.quota === null ? '—'
                  : `这批 ${stickerView.quota?.netNew ?? 0} 张要新传（${stickerView.quota?.alreadyUploaded ?? 0} 张这个号已经有了，直接复用）｜${stickerView.quota?.note ?? ''}`),
                (stickerView.repeat ?? []).length > 0 && h('b', {}, '重复图'),
                (stickerView.repeat ?? []).length > 0 && h('div', {},
                  `${stickerView.repeat.length} 张以前发过（最多的一张用过 ${stickerView.repeat[0]?.times ?? 0} 次）：不影响推，只是老图还在占格；要清得去公众平台素材库后台，插件不碰删除`))),

            h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '渲染记录'), '点一条在中间回看'),
              renders.length === 0
                ? h('div', { className: 'gzh-empty' }, '还没有渲染记录。')
                : h('div', { className: 'gzh-list' },
                  ...renders.slice(0, 12).map((entry, index) => h('div', {
                    key: `${entry.renderId}-${index}`, className: 'gzh-row',
                    onClick: () => showPreview(entry.previewFile ?? entry.file, entry.title),
                  },
                  h('div', { className: 'gzh-rowtitle' }, `${entry.account}｜${entry.title}`),
                  h('div', { className: 'gzh-rowmeta' }, renderMeta(entry)))))),

            h('div', { className: 'gzh-card' },
              h('div', { className: 'gzh-cardhead' }, h('b', {}, '推送台账'), '重复推送按这里的指纹拦'),
              pushes.length === 0
                ? h('div', { className: 'gzh-empty' }, '还没有推送记录。')
                : h('div', { className: 'gzh-list' },
                  ...pushes.slice(0, 12).map((entry, index) => h('div', { key: `${entry.at}-${index}`, className: 'gzh-row gzh-row--static' },
                    h('div', { className: 'gzh-rowtitle' }, `${entry.account}｜${entry.title}${entry.articleType === 'newspic' ? '［贴图］' : ''}`),
                    h('div', { className: 'gzh-rowmeta' }, pushMeta(entry)))))),
          ),
        ),

        settingsOpen === true && h(Settings, {
          snapshot, busy, setBusy,
          onNotify: text => setAlert({ level: 'ok', text }),
          onError: (kind, cause) => setAlert({ level: 'err', text: `${kind}失败：${cause.message}${cause.hint ? `｜${cause.hint}` : ''}` }),
          onClose: () => { setSettingsOpen(false); load(true) },
        }))
    }

    function Icon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
        'stroke-width': 1.3, 'aria-hidden': true, style: { display: 'block' },
      },
      h('rect', { x: 2.2, y: 2.6, width: 11.6, height: 10.8, rx: 2.2 }),
      h('path', { d: 'M4.6 6.2h6.8M4.6 8.6h4.4' }),
      h('path', { d: 'M9.4 11.6l1.5 1.9 1.5-1.9' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 挂载写法对齐已安装的 dsh-music-panel：每次 inject 包一层 ctx.effect，
        // 卸载时先退插槽再撤样式，插件被停用/热替换时不会留下野组件。
        ctx.effect(() => {
          const offStyle = ensureStyle()
          const offMain = ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, props => h(Boundary, {}, h(Panel, props))))
          const offSide = ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '公众号草稿' }, Icon))
          return () => {
            for (const dispose of [offSide, offMain, offStyle]) {
              if (typeof dispose === 'function') dispose()
            }
          }
        })
      },
    }
  },
})
