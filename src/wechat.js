/**
 * 微信公众号 API 客户端（走代理，或直连）。
 *
 * 契约是从产线脚本 `vendor-scripts/wechat-publish/scripts/push_draft.py`
 * 逐字对齐出来的，不靠猜：
 *   - 代理是微信接口的**薄转发**：`{proxy}/cgi-bin/...` 原样透传，多一个
 *     `X-Proxy-Token` 请求头做鉴权，别的什么都不改。
 *   - 取 token：GET /cgi-bin/token?grant_type=client_credential&appid=&secret=
 *   - 建草稿：POST /cgi-bin/draft/add?access_token=…
 *     Content-Type: application/json; charset=utf-8
 *     body = {"articles":[{title,author,digest,content,need_open_comment:1,
 *              only_fans_can_comment:0,show_cover_pic,content_source_url?,thumb_media_id?}]}
 *     成功判据：返回里**有 media_id**。
 *   - 回读：POST /cgi-bin/draft/batchget?access_token=… {offset,count,no_content:1}
 *
 * 刻意不做的事：
 *   - 不内置任何默认 appsecret / proxy token（产线脚本里有硬编码兜底，
 *     那是它自己的历史包袱，不能带进插件）。
 *   - 不重试 draft/add：草稿重复 = 线上事故。
 *
 * @module dsh-gzh-publisher/wechat
 */

/** 没有配代理时的直连地址（`proxyUrl` 留空且允许直连才用）。 */
export const DIRECT_BASE = 'https://api.weixin.qq.com'

/** 掩码：只露尾 4 位，任何返回值里都不出现原文。 */
export function mask(secret) {
  const value = String(secret ?? '')
  if (value === '') return ''
  if (value.length <= 8) return '****'
  return `${'*'.repeat(Math.max(value.length - 4, 4))}${value.slice(-4)}`
}

/** 微信返回的错误 → 人话，保留 errcode 便于对账。 */
export class WeChatError extends Error {
  constructor(errcode, errmsg, context) {
    super(`${context ?? '微信接口'}失败：${errcode ?? '无 errcode'} ${errmsg ?? '无 errmsg'}`)
    this.name = 'WeChatError'
    this.errcode = errcode
    this.errmsg = errmsg
    this.context = context
  }
}

/**
 * 把常见 errcode 翻译成能直接照着做的下一步。
 * @param {WeChatError} error 待解释的错误。
 * @returns {string} 处置建议；没有匹配时返回空串。
 */
export function hintOf(error) {
  const code = Number(error?.errcode)
  if (code === 40164) return '调用方 IP 不在公众号「IP 白名单」里：把这台机器的出口 IP 加进后台「设置与开发 → 基本配置 → IP 白名单」，或改成走代理（proxyUrl）出口。'
  if (code === 40001 || code === 42001 || code === 40014) return 'access_token 无效或过期：确认 appid/appsecret 是这个号的，代理地址没填错，然后重推一次（token 每次都是新取的）。'
  if (code === 45009) return '接口调用超过当日频次上限。'
  if (code === 41001) return '缺少 access_token：多半是代理把查询串吃掉了，检查 proxyUrl 是否带了路径前缀。'
  if (code === 44002 || code === 40007) return '正文/素材不合法：图文里只能引用 mmbiz.qpic.cn 的图片，确认配图都已上传成功。'
  if (code === 53404 || code === 53405 || code === 53406) return '草稿内容命中内容安全校验，按 errmsg 改文案后重推。'
  // 个人订阅号（未认证）没有发布类接口权限；这类错误不是配置能修的，别再重试。
  if (code === 48001 || code === 200002 || code === 200003) return '这个接口你的号没有调用权限（48001 API unauthorized / 200002）：个人订阅号未认证，发布类接口（freepublish 等）不开放。本插件只走草稿链路（draft/add + 图床 + 素材），出现这条说明请求越界了，请把 errmsg 一起反馈。'
  return ''
}

/**
 * 按文件名猜 Content-Type。原来两处上传一律填 `image/png`，等于给 jpg 发假声明：
 * 微信多数接口靠嗅探内容，但素材库会把类型记错，遇到严格按 MIME 校验的代理还会被拒。
 * 认不出来的扩展名一律按 jpg（压缩引擎的输出就是 jpg），绝不再谎报 png。
 * @param {string} filename 文件名（取扩展名）。
 * @returns {string} MIME 类型。
 */
export function mimeOf(filename) {
  const ext = String(filename ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

/**
 * @param {object} options
 * @param {string} options.baseUrl 代理根地址（如 https://proxy.example.com/wxproxy，务必 https）；留空 = 直连。
 * @param {string} [options.token] 代理鉴权头 X-Proxy-Token 的值。
 * @param {string} options.appid 公众号 AppID。
 * @param {string} options.secret 公众号 AppSecret。
 * @param {number} [options.timeoutMs] 单次请求超时。
 */
export function createClient({ baseUrl, token, appid, secret, timeoutMs = 60_000 }) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  const endpoint = base === '' ? DIRECT_BASE : base
  const direct = base === ''
  const headers = token !== undefined && String(token) !== '' ? { 'X-Proxy-Token': String(token) } : {}

  /** 发一次请求并解析 JSON；微信的错误码在这里统一抛错。 */
  async function call(path, { method = 'GET', query = {}, body, type, context }) {
    const url = new URL(`${endpoint}${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) }
    if (body !== undefined) {
      // FormData 交给 undici 自己拼 boundary，这里不能碰 Content-Type。
      if (type !== undefined) init.headers['Content-Type'] = type
      init.body = body
    }
    let response
    try {
      response = await fetch(url, init)
    } catch (cause) {
      const reason = cause?.name === 'TimeoutError' ? `${timeoutMs}ms 超时` : cause?.message ?? String(cause)
      throw new Error(`${context ?? path}请求失败（${url.origin}${url.pathname}）：${reason}。代理不通时先确认这条 URL 在本机能访问，或换回直连（proxyUrl 留空）。`)
    }
    const text = await response.text()
    let data
    try {
      data = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new Error(`${context ?? path}返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }
    if (!response.ok || (data.errcode !== undefined && Number(data.errcode) !== 0)) {
      const error = new WeChatError(data.errcode, data.errmsg ?? `HTTP ${response.status}`, context ?? path)
      const hint = hintOf(error)
      if (hint !== '') error.hint = hint
      throw error
    }
    return data
  }

  return {
    /** 当前端点（诊断用，绝不含密钥）。 */
    endpoint,
    direct,

    /** 取 access_token；每次调用都现取，和产线脚本一致。 */
    async accessToken() {
      const data = await call('/cgi-bin/token', {
        query: { grant_type: 'client_credential', appid, secret },
        context: '取 access_token',
      })
      if (typeof data.access_token !== 'string' || data.access_token === '') {
        throw new Error('取 access_token 成功但响应里没有 access_token 字段')
      }
      return data.access_token
    },

    /**
     * 正文配图上传（返回 mmbiz 图床 URL，可写进 content）。
     * 微信侧限制 1MB，jpg/png。
     * @param {Buffer|Uint8Array} buffer 图片字节。
     * @param {string} filename 文件名（微信按扩展名判类型）。
     * @returns {Promise<string>} 图片 URL。
     */
    async uploadImage(buffer, filename) {
      const access = await this.accessToken()
      const form = new FormData()
      form.set('media', new Blob([buffer], { type: mimeOf(filename) }), filename)
      const data = await call('/cgi-bin/media/uploadimg', {
        method: 'POST', query: { access_token: access }, body: form, type: undefined, context: '上传正文配图',
      })
      if (typeof data.url !== 'string') throw new Error('上传正文配图成功但没有返回 url')
      return data.url
    },

    /**
     * 永久图片素材（封面用，返回 media_id；上限 10MB）。
     * @param {Buffer|Uint8Array} buffer 图片字节。
     * @param {string} filename 文件名。
     * @returns {Promise<string>} media_id。
     */
    async addImageMaterial(buffer, filename) {
      const access = await this.accessToken()
      const form = new FormData()
      form.set('media', new Blob([buffer], { type: mimeOf(filename) }), filename)
      const data = await call('/cgi-bin/material/add_material', {
        method: 'POST', query: { access_token: access, type: 'image' }, body: form, type: undefined, context: '上传封面素材',
      })
      if (typeof data.media_id !== 'string') throw new Error('上传封面素材成功但没有返回 media_id')
      return data.media_id
    },

    /**
     * 建草稿。调用方自己保证幂等（本客户端不重试，插件侧有台账兜底）。
     * @param {object} article
     * @param {string} article.title 标题（微信限 64 字）。
     * @param {string} article.author 作者。
     * @param {string} article.digest 摘要（微信限 120 字）。
     * @param {string} article.content 正文 HTML。
     * @param {string} [article.thumbMediaId] 封面素材 id。
     * @param {string} [article.contentSourceUrl] 阅读原文链接。
     * @param {{open?: boolean, fansOnly?: boolean}} [article.comment] 评论区开关：
     *   `open` 是否开放评论（缺省开放），`fansOnly` 是否仅关注者可评论（缺省不限）。
     * @returns {Promise<string>} 草稿 media_id。
     */
    async addDraft(article) {
      const access = await this.accessToken()
      const comment = article.comment ?? {}
      const item = {
        title: article.title,
        author: article.author,
        digest: article.digest,
        content: article.content,
        // 缺省必须和线上老行为一致：开放评论 + 不限粉丝。字段缺失不能把评论莫名关掉。
        need_open_comment: comment.open === false ? 0 : 1,
        only_fans_can_comment: comment.fansOnly === true ? 1 : 0,
        show_cover_pic: article.thumbMediaId === undefined ? 0 : 1,
      }
      if (article.thumbMediaId !== undefined && article.thumbMediaId !== '') item.thumb_media_id = article.thumbMediaId
      if (article.contentSourceUrl !== undefined && article.contentSourceUrl !== '') item.content_source_url = article.contentSourceUrl

      const body = JSON.stringify({ articles: [item] })
      const data = await call('/cgi-bin/draft/add', {
        method: 'POST',
        query: { access_token: access },
        body: Buffer.from(body, 'utf8'),
        type: 'application/json; charset=utf-8',
        context: '推送草稿',
      })
      if (typeof data.media_id !== 'string' || data.media_id === '') {
        throw new Error('推送草稿返回里没有 media_id，无法确认草稿是否建成（**不要盲目重推**，先去后台或 gzh_draft_verify 看有没有）')
      }
      return data.media_id
    },

    /**
     * 回读草稿列表，用来验证推送结果（对齐 runtime/wechat_readback.py）。
     * @param {number} [offset] 分页起点。
     * @param {number} [count] 条数（≤20）。
     * @returns {Promise<Array<{mediaId: string, title: string, updatedAt: number}>>}
     */
    async listDrafts(offset = 0, count = 10) {
      const access = await this.accessToken()
      const data = await call('/cgi-bin/draft/batchget', {
        method: 'POST',
        query: { access_token: access },
        body: Buffer.from(JSON.stringify({ offset, count, no_content: 1 }), 'utf8'),
        type: 'application/json; charset=utf-8',
        context: '回读草稿箱',
      })
      const list = data?.item?.list ?? data?.item ?? []
      return (Array.isArray(list) ? list : []).map(entry => {
        const first = entry?.content?.news_item?.[0] ?? {}
        return {
          mediaId: String(entry?.media_id ?? ''),
          title: String(first?.title ?? ''),
          // 微信给秒级时间戳；转不成数字就留 0——NaN 不能出现在工具返回值里（宿主按无损 JSON 校验会整体拒绝）
          updatedAt: Number.isFinite(Number(entry?.update_time)) ? Number(entry.update_time) : 0,
          articleCount: Array.isArray(entry?.content?.news_item) ? entry.content.news_item.length : 0,
        }
      })
    },
  }
}
