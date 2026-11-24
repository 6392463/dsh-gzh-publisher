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

    function AccountForm({ account, skins, onSaved, onClose, onError, busy, setBusy }) {
      const blank = { key: '', name: '', alias: '', appid: '', proxyUrl: '', author: '', digest: '', thumbMediaId: '', contentSourceUrl: '', layout: '', note: '', enabled: true }
      const [draft, setDraft] = React.useState(() => {
        const base = { ...blank, ...(account ?? {}), appsecret: '', proxyToken: '' }
        // 评论开关在账号表里是 { open, fansOnly }，表单里拍平成两个 checkbox 好绑；
        // 缺省必须和微信默认一致（开放评论、不限粉丝），别让人以为勾上才是默认。
        const comment = account?.comment ?? {}
        base.commentOpen = comment.open !== false
        base.commentFansOnly = comment.fansOnly === true
        return base
      })
      const [clearSecret, setClearSecret] = React.useState(false)
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
        if (kind === '回读') {
          return result.ok === true
            ? `草稿箱已确认：${result.found?.title ?? result.checked?.mediaId ?? ''}`
            : `回读有问题：${(result.problems ?? []).join('；')}`
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
      const accountLabel = activeAccount === null ? '（未选）' : `${activeAccount.name || activeAccount.key}｜${activeAccount.layoutLabel}`
      // 台账那两行现在要带封面与正文图数（老记录没这两个字段，就不显示，别编）。
      const renderMeta = entry => `${entry.layoutLabel ?? entry.layout} · ${fmtTime(entry.at)}`
        + (entry.bodyImages === undefined ? '' : ` · 封面 ${(entry.thumbMediaId ?? '') !== '' ? '✓' : entry.coverFrom === 'auto' ? '挑好未传' : '✗'} · 正文 ${entry.bodyImages} 图${(entry.placed ?? 0) > 0 ? `（自动插 ${entry.placed}）` : ''}`)
      const pushMeta = entry => (entry.error !== undefined && entry.error !== null && entry.error !== ''
        ? `失败：${entry.error}`
        : `media_id=${entry.mediaId ?? ''}${entry.forced === true ? '（强制重推）' : ''} · ${fmtTime(entry.at)}`)
        + (entry.thumbMediaId === undefined ? '' : ` · 封面 ${(entry.thumbMediaId ?? '') !== '' ? '✓' : '✗（force 推的）'} · 正文 ${entry.bodyImages ?? 0} 图`)

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
                  onClick: () => run('回读', 'gzh_draft_verify', { account, ...only('mediaId', pushed?.mediaId), ...only('title', rendered?.title) }),
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
                    h('div', { className: 'gzh-rowtitle' }, `${entry.account}｜${entry.title}`),
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
