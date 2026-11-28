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
 *   - 建贴图草稿：同一个 /cgi-bin/draft/add，articles[0].article_type="newspic"。
 *     与图文的三点不同（2026-11-27 在个人未认证订阅号真机验证过，见 tmp 探针记录）：
 *       1) 不要 thumb_media_id / show_cover_pic —— 首图即封面，微信回读时自己回填；
 *       2) 图必须是**永久素材 media_id**（add_material?type=image），
 *          uploadimg 只给 URL、不给 media_id，贴图用不了；
 *       3) 不要 cover_info —— 让微信自己算裁剪，手算的坐标对不上图片真实宽高比，
 *          会撞 53401「封面图片尺寸不合法」。
 *     content 仅支持纯文本（排版 HTML 到这里会变成一屏标签），title 上限 32 字。
 *   - 回读：POST /cgi-bin/draft/batchget?access_token=… {offset,count,no_content:1}
 *     贴图与图文都在 content.news_item[] 里，靠 article_type 区分。
 *   - 删草稿：POST /cgi-bin/draft/delete?access_token=… {media_id}
 *     （注意 /cgi-bin/draft/get 也是 POST，用 GET 会撞 43002 require POST method）
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
  // 贴图（newspic）这一族：都是内容校验，不是权限问题，号本身有调用权限。
  if (code === 53401) return '封面图片尺寸不合法（53401）：贴图草稿不要自己算 cover_info 的裁剪坐标——真机验证过，不传 cover_info 时微信会给 1_1 / 16_9 / 2.35_1 三种比例自动算居中裁剪，手算反而对不上图片真实宽高比。'
  if (code === 53402) return '图片消息（贴图）的图片不合法（53402）：image_info 里的 media_id 必须是**本号**的永久图片素材（add_material?type=image），最多 20 张；uploadimg 返回的 URL 不是 media_id，不能用。'
  if (code === 53404) return '账号已被限制带货能力（53404）：这篇带了 product_info 商品信息，去掉即可，或按后台提示处理带货权限。'
  if (code === 53405) return '插入商品信息有误（53405）：product_info.product_key 不对，本插件不产出商品信息，出现这条说明参数被手改过。'
  if (code === 53406) return '请先开通带货能力（53406）：贴图里带了商品组件，而这个号没开通带货，去掉 product_info 再推。'
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
    /** 这个客户端代表哪个 appid：素材缓存要按号存 media_id（A 号的图在 B 号不能用）。 */
    appid,

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
     * 永久素材数量（图片/语音/视频/图文各有多少，上限是账号级的）。
     * 贴图链路每张图都要占一格，攒多了得看得见。
     * @returns {Promise<{image:number,voice:number,video:number,image_text:number}>}
     */
    async materialCount() {
      const access = await this.accessToken()
      const data = await call('/cgi-bin/material/get_materialcount', {
        method: 'GET', query: { access_token: access }, context: '读永久素材数量',
      })
      return {
        image: Number(data.image_count ?? 0),
        voice: Number(data.voice_count ?? 0),
        video: Number(data.video_count ?? 0),
        image_text: Number(data.news_count ?? 0),
      }
    },

    /**
     * 删一张永久图片素材。
     * ⚠️ 已经进了草稿或已发布文章的图，删掉那边就裂图：调用方必须先确认没有草稿还在用它。
     * @param {string} mediaId 素材 id。
     * @returns {Promise<true>}
     */
    async deleteImageMaterial(mediaId) {
      const id = String(mediaId ?? '')
      if (id === '') throw new Error('删素材没给 media_id')
      const access = await this.accessToken()
      await call('/cgi-bin/material/del_material', {
        method: 'POST',
        query: { access_token: access },
        body: Buffer.from(JSON.stringify({ media_id: id }), 'utf8'),
        type: 'application/json; charset=utf-8',
        context: `删永久图片素材 ${id.slice(0, 12)}…`,
      })
      return true
    },

    /**
     * 建草稿。调用方自己保证幂等（本客户端不重试，插件侧有台账兜底）。
     * @param {object} article
     * @param {string} article.title 标题（图文上限 64 字；贴图是 32 字，见 addStickerDraft）。
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
     * 建**贴图**（图片消息）草稿：article_type="newspic"。
     *
     * 字段是按 2026-11-27 真机跑通的那一次逐字对齐的，刻意不带三样东西：
     *   - `thumb_media_id` / `show_cover_pic`：贴图没有独立封面，`image_list` 第一张就是封面，
     *     微信建成后会自己回填 thumb_media_id 与 mmbiz 的 thumb_url；
     *   - `cover_info`：裁剪比例交给微信算。带上手写坐标反而撞 53401——文档示例那组
     *     x1/x2 是针对近正方形图的，配到 3:4 的图上裁出来根本不是 1_1。
     * 与图文不同，`content` 只支持纯文本：排版 HTML 当贴图正文推上去，就是一屏可见的标签。
     * @param {object} article
     * @param {string} article.title 标题（贴图上限 32 字，比图文的 64 短）。
     * @param {string} article.content 说明文字（纯文本）。
     * @param {string[]} article.imageMediaIds 永久图片素材 media_id，1~20 张，**第一张当封面**。
     * @param {string} [article.digest] 摘要（≤120 字）；不传微信取正文前 54 字。
     * @param {{open?: boolean, fansOnly?: boolean}} [article.comment] 评论区开关。
     * @returns {Promise<string>} 草稿 media_id。
     */
    async addStickerDraft(article) {
      // 参数校验放在取 access_token 之前：字段就不对时，别先去消耗一次令牌请求。
      const ids = (Array.isArray(article.imageMediaIds) ? article.imageMediaIds : [])
        .map(id => String(id ?? '').trim())
        .filter(id => id !== '')
      if (ids.length === 0) throw new Error('贴图至少要 1 张图的永久素材 media_id（add_material?type=image）')
      if (ids.length > 20) throw new Error(`贴图最多 20 张图，这里给了 ${ids.length} 张`)
      const title = String(article.title ?? '').trim()
      if (title === '') throw new Error('贴图缺标题（贴图标题上限 32 字，比图文的 64 短；本项目推贴图的形式规范更严：20 字）')
      const access = await this.accessToken()
      const comment = article.comment ?? {}
      const item = {
        article_type: 'newspic',
        title,
        content: article.content,
        // 缺省与图文一致：开放评论 + 不限粉丝。
        need_open_comment: comment.open === false ? 0 : 1,
        only_fans_can_comment: comment.fansOnly === true ? 1 : 0,
        image_info: { image_list: ids.map(image_media_id => ({ image_media_id })) },
      }
      if (String(article.digest ?? '') !== '') item.digest = article.digest

      const data = await call('/cgi-bin/draft/add', {
        method: 'POST',
        query: { access_token: access },
        body: Buffer.from(JSON.stringify({ articles: [item] }), 'utf8'),
        type: 'application/json; charset=utf-8',
        context: '推送贴图草稿',
      })
      if (typeof data.media_id !== 'string' || data.media_id === '') {
        throw new Error('推送贴图草稿返回里没有 media_id，无法确认草稿是否建成（**不要盲目重推**，先用 gzh_draft_verify 回读）')
      }
      return data.media_id
    },

    /**
     * 回读草稿列表，用来验证推送结果（对齐 runtime/wechat_readback.py）。
     * @param {number} [offset] 分页起点。
     * @param {number} [count] 条数（≤20）。
     * @returns {Promise<Array<{mediaId: string, title: string, updatedAt: number, articleType: string}>>}
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
          // 贴图与图文都躺在 news_item[] 里，只有这个字段能分开它们（回读实测 news/newspic）。
          articleType: String(first?.article_type ?? 'news'),
          imageCount: Array.isArray(first?.image_info?.image_list) ? first.image_info.image_list.length : 0,
        }
      })
    },

    /**
     * 删掉一条草稿（探针、试错稿的清理）。删不掉不谎报成功。
     * @param {string} mediaId 草稿 media_id。
     */
    async deleteDraft(mediaId) {
      const access = await this.accessToken()
      await call('/cgi-bin/draft/delete', {
        method: 'POST',
        query: { access_token: access },
        body: Buffer.from(JSON.stringify({ media_id: String(mediaId ?? '') }), 'utf8'),
        type: 'application/json; charset=utf-8',
        context: '删除草稿',
      })
      return true
    },
  }
}
