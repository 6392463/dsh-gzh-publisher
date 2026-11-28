/**
 * 插件自己的存储：账号表 + 皮肤表 + 渲染台账 + 推送台账，都在 `~/.dsh/gzh-publisher/`。
 *
 * 为什么不用 cordis.patch.yml：账号和皮肤都是可增删的表，补丁层不是给它用的；
 * 为什么不用 ctx.credentials：这台机器上的同类插件（自媒体工作台）把接口密钥
 * 放在自己的 settings 文件里，这里保持一致，代价与好处都写在 README 里
 * —— 文件只在本机，工具与面板输出永远掩码。
 *
 * 推送台账解决的是**唯一的线上事故**：重复推草稿。每次 push 前按
 * sha256(账号 + 标题 + 正文) 查一遍，命中就拒，除非调用方明确 force。
 * 渲染台账解决第二个：面板必须能证明「这条草稿是排版渲染出来的产物」，
 * 而不是随手贴进去的一段 HTML/Markdown。
 *
 * @module dsh-gzh-publisher/store
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SKINS, normalizeSkinColors, migrateSkinKey, SKIN_KEY_PATTERN } from './layout.js'
import { normalizeStickerRules } from './sticker.js'

/** 需要掩码的字段。 */
const SECRET_FIELDS = ['appsecret', 'proxyToken']

/** 账号里允许出现的键；写错键名直接拒，不静默忽略。 */
export const ACCOUNT_FIELDS = [
  'name', 'alias', 'appid', 'appsecret', 'proxyUrl', 'proxyToken',
  'author', 'digest', 'thumbMediaId', 'contentSourceUrl',
  'layout', 'skin', 'eyebrows', 'foot', 'tail', 'enabled', 'note', 'comment', 'sticker',
]

/**
 * 账号里「块状、块内合并」的字段：整块传 null/'' 才清空，传部分字段只改那几项。
 * 贴图规则必须走合并——它是闸门本身，模型只想放宽 minImages 却把 titleMax/textMax
 * 顺手抹回默认值，等于悄悄改了另一道闸门。
 */
const MERGED_BLOCKS = { comment: normalizeComment, sticker: normalizeStickerRules }

/**
 * 评论开关归一化：存成 `{ open?: boolean, fansOnly?: boolean }` 两个布尔。
 * 面板/工具传字符串（'true'/'开'）也认，避免把 "false" 这种真值串写进配置后开关永远关不掉。
 * 返回 null 表示「不存这个字段」= 回到微信默认（开放评论、不限粉丝）。
 * @param {unknown} value 用户传的 comment 值。
 * @returns {{open?: boolean, fansOnly?: boolean}|null}
 */
export function normalizeComment(value) {
  if (value === null || value === undefined || value === false || value === '') return null
  const source = typeof value === 'boolean' ? { open: value } : value
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('comment 要传对象：{ open: true|false, fansOnly: true|false }')
  }
  const boolOf = raw => {
    if (raw === undefined || raw === null || raw === '') return undefined
    if (typeof raw === 'boolean') return raw
    const text = String(raw).trim().toLowerCase()
    if (['true', '1', 'yes', 'on', '开', '是'].includes(text)) return true
    if (['false', '0', 'no', 'off', '关', '否'].includes(text)) return false
    throw new Error(`comment 里的「${String(raw)}」认不出是开还是关：只接受 true/false`)
  }
  const out = {}
  const open = boolOf(source.open)
  const fansOnly = boolOf(source.fansOnly)
  if (open !== undefined) out.open = open
  if (fansOnly !== undefined) out.fansOnly = fansOnly
  return Object.keys(out).length === 0 ? null : out
}

/** 掩码一个值，只露尾 4 位。 */
function masked(value) {
  const text = String(value ?? '')
  if (text === '') return ''
  return text.length <= 8 ? '****' : `****${text.slice(-4)}`
}

/**
 * @param {{ dir?: string }} [options]
 * @returns {{dir: string, accountsFile: string, skinsFile: string, rendersFile: string,
 *            ledgerFile: string, materialsFile: string, outDir: string,
 *            readAccounts: () => object, writeAccount: Function, deleteAccount: Function,
 *            publicAccount: Function, migrateAccounts: () => Array,
 *            readSkins: () => object, writeSkin: Function, deleteSkin: Function,
 *            readRenders: () => Array, appendRender: Function, findRender: Function,
 *            readLedger: () => Array, appendLedger: Function,
 *            readMaterials: () => Array, findMaterial: Function, appendMaterial: Function,
 *            fingerprint: Function, atomicWrite: Function}}
 */
export function createStore(options = {}) {
  const dir = options.dir ?? join(homedir(), '.dsh', 'gzh-publisher')
  const accountsFile = join(dir, 'accounts.json')
  const skinsFile = join(dir, 'skins.json')
  const rendersFile = join(dir, 'renders.json')
  const ledgerFile = join(dir, 'ledger.json')
  const materialsFile = join(dir, 'materials.json')
  const outDir = join(dir, 'out')

  /** 原子写：先写同目录 tmp 再 rename，避免半截文件。 */
  function atomicWrite(path, text) {
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
    return path
  }

  /** 读账号表；文件不存在返回空表，格式坏了抛错（不静默当空表，免得覆盖用户的表）。 */
  function readAccounts() {
    if (!existsSync(accountsFile)) return {}
    let data
    try {
      data = JSON.parse(readFileSync(accountsFile, 'utf8'))
    } catch (cause) {
      throw new Error(`账号表读不了（${accountsFile}）：${cause.message}。修好之前不要写账号，否则会覆盖原文件。`)
    }
    const accounts = data?.accounts
    if (accounts === null || typeof accounts !== 'object' || Array.isArray(accounts)) {
      throw new Error(`账号表格式不对（${accountsFile}）：期望 { "accounts": { "key": {…} } }`)
    }
    return accounts
  }

  function writeAll(accounts) {
    atomicWrite(accountsFile, `${JSON.stringify({ accounts, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  }

  /** 去掉密钥后的账号视图，工具返回值只用这个。 */
  function publicAccount(key, account) {
    const out = { key, ...account }
    for (const field of SECRET_FIELDS) {
      out[field] = masked(account?.[field])
      out[`has${field[0].toUpperCase()}${field.slice(1)}`] = String(account?.[field] ?? '') !== ''
    }
    return out
  }

  /**
   * 建/改账号（合并式：只改传进来的字段）。
   * @param {string} key 账号 key（推送时用它，防串号）。
   * @param {object} patch 要改的字段。
   * @param {string[]} [secrets] 明确按密钥处理的字段名（空串 = 删除）。
   * @returns {object} 掩码后的账号。
   */
  function writeAccount(key, patch, secrets = []) {
    const id = String(key ?? '').trim()
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id)) {
      throw new Error(`账号 key「${key}」不合法：用小写字母/数字/-/_，2-32 位，例如 my-gzh`)
    }
    const unknown = Object.keys(patch ?? {}).filter(field => !ACCOUNT_FIELDS.includes(field) && !secrets.includes(field))
    if (unknown.length > 0) {
      throw new Error(`未知字段「${unknown.join('、')}」：gzh_account_set 只接受 ${ACCOUNT_FIELDS.join(' / ')}`)
    }
    const accounts = readAccounts()
    const current = accounts[id] ?? {}
    const next = { ...current }
    for (const [field, value] of Object.entries(patch ?? {})) {
      if (value === null || value === '') delete next[field]
      else if (MERGED_BLOCKS[field] !== undefined) {
        // 归一化后再存：面板传的是 checkbox（布尔），模型可能传 'false' 字符串或字符串数字。
        // 块内合并——只改传进来的那几项（见 MERGED_BLOCKS 的注释）。
        const normalized = MERGED_BLOCKS[field](value, { where: field })
        const merged = { ...(current[field] ?? {}), ...(normalized ?? {}) }
        if (Object.keys(merged).length === 0) delete next[field]
        else next[field] = merged
      } else next[field] = value
    }
    for (const field of secrets) {
      const value = patch?.[field]
      if (value === null || value === '') delete next[field]
      else if (typeof value === 'string' && value !== '') next[field] = value
    }
    accounts[id] = next
    writeAll(accounts)
    return publicAccount(id, next)
  }

  /** 删账号（台账留着，它是历史事实）。 */
  function deleteAccount(key) {
    const accounts = readAccounts()
    if (!(key in accounts)) return false
    delete accounts[key]
    writeAll(accounts)
    return true
  }

  /**
   * 把老配置里的皮肤名（曾按号命名，如 `account-a`）迁到中性 key（`teal`）。
   * 只在激活时跑一次；写了就返回改动的账号，方便面板提示「已为你迁移」。
   * @returns {Array<{ key: string, from: string, to: string }>}
   */
  function migrateAccounts() {
    const accounts = readAccounts()
    const changed = []
    for (const [key, account] of Object.entries(accounts)) {
      for (const field of ['layout', 'defaultLayout']) {
        const value = String(account?.[field] ?? '')
        if (value === '') continue
        const next = migrateSkinKey(value)
        if (next !== value) {
          account[field] = next
          changed.push({ key, from: value, to: next })
        }
      }
    }
    if (changed.length > 0) writeAll(accounts)
    return changed
  }

  /* ---------------------------- 皮肤表（用户可自定义） ---------------------------- */

  /** 读自定义皮肤（skins.json）；内置四套不在这里，由 layout.listSkins 合并。 */
  function readSkins() {
    if (!existsSync(skinsFile)) return {}
    let data
    try {
      data = JSON.parse(readFileSync(skinsFile, 'utf8'))
    } catch (cause) {
      throw new Error(`皮肤表读不了（${skinsFile}）：${cause.message}。修好之前别写皮肤，否则会覆盖原文件。`)
    }
    const skins = data?.skins
    if (skins === null || typeof skins !== 'object' || Array.isArray(skins)) {
      throw new Error(`皮肤表格式不对（${skinsFile}）：期望 { "skins": { "key": {…} } }`)
    }
    return skins
  }

  function writeAllSkins(skins) {
    atomicWrite(skinsFile, `${JSON.stringify({ skins, updatedAt: new Date().toISOString() }, null, 2)}\n`)
  }

  /**
   * 建/改自定义皮肤（合并式）。内置名不可覆盖，避免别人的示例被改掉。
   * @param {string} key 皮肤 key。
   * @param {{ label?: string }} patch label + 若干 `SKIN_FIELDS` 颜色。
   * @returns {object} 存好的皮肤（label + 全部颜色字段）。
   */
  function writeSkin(key, patch) {
    const id = String(key ?? '').trim()
    if (!SKIN_KEY_PATTERN.test(id)) {
      throw new Error(`皮肤 key「${key}」不合法：用小写字母/数字/-/_，2-32 位，例如 my-dark`)
    }
    if (id in SKINS) throw new Error(`「${id}」是内置皮肤名，不能覆盖；换个 key（例如 ${id}-mine）`)
    const { label, ...rest } = patch ?? {}
    const { colors, unknown, invalid } = normalizeSkinColors(rest)
    if (invalid.length > 0) {
      throw new Error(`配色必须是 #RGB 或 #RRGGBB，不能是别的写法：${invalid.join('、')}`)
    }
    if (unknown.length > 0) throw new Error(`未知皮肤字段「${unknown.join('、')}」：只能填颜色字段`)
    const skins = readSkins()
    const next = { ...(skins[id] ?? {}), ...colors }
    const labelText = label === undefined ? next.label : String(label).trim()
    if (labelText === undefined || labelText === '') delete next.label
    else next.label = labelText
    if (Object.keys(next).length === 0) throw new Error('没有要写入的字段：至少给一个 label 或颜色')
    skins[id] = next
    writeAllSkins(skins)
    return { key: id, ...next }
  }

  /** 删自定义皮肤；内置皮肤删不掉（返回 false 并说明）。 */
  function deleteSkin(key) {
    const id = String(key ?? '').trim()
    if (id in SKINS) return { removed: false, reason: `「${id}」是内置皮肤，删不掉；不想要就别选它` }
    const skins = readSkins()
    if (!(id in skins)) return { removed: false, reason: `没有这套皮肤：${id}` }
    delete skins[id]
    writeAllSkins(skins)
    return { removed: true, key: id }
  }

  /* ---------------------------- 渲染台账 ---------------------------- */

  /** 最近渲染过什么：面板据此判断「要推的这份 HTML 是渲染产物」。 */
  function readRenders() {
    if (!existsSync(rendersFile)) return []
    try {
      const data = JSON.parse(readFileSync(rendersFile, 'utf8'))
      return Array.isArray(data?.renders) ? data.renders : []
    } catch {
      return []
    }
  }

  /**
   * 记一次渲染（最新的排最前，只留最近 100 条）。
   * renderId 缺省时用内容 sha 的前 12 位补上：同一份内容重复渲染 → 同一个 id，
   * 面板上「重新渲染一次」不会凭空多出一条对不上的记录。
   * @returns {object} 真正存进台账的那条（带 renderId / at）。
   */
  function appendRender(entry) {
    const saved = { ...entry }
    if (String(saved.renderId ?? '').trim() === '') {
      saved.renderId = createHash('sha256').update(String(saved.sha ?? JSON.stringify(saved)), 'utf8').digest('hex').slice(0, 12)
    }
    if (String(saved.at ?? '') === '') saved.at = new Date().toISOString()
    const renders = readRenders()
    renders.unshift(saved)
    atomicWrite(rendersFile, `${JSON.stringify({ renders: renders.slice(0, 100) }, null, 2)}\n`)
    return saved
  }

  /** 按 renderId 找渲染记录（面板推的就是刚渲染那份）。 */
  function findRender(id) {
    const wanted = String(id ?? '').trim()
    if (wanted === '') return null
    const renders = readRenders()
    const exact = renders.find(entry => String(entry?.renderId ?? '') === wanted)
    if (exact !== undefined) return exact
    const prefixed = renders.filter(entry => String(entry?.renderId ?? '').startsWith(wanted))
    return prefixed.length === 1 ? prefixed[0] : null
  }

  function readLedger() {
    if (!existsSync(ledgerFile)) return []
    try {
      const data = JSON.parse(readFileSync(ledgerFile, 'utf8'))
      return Array.isArray(data?.pushes) ? data.pushes : []
    } catch {
      return []
    }
  }

  /** 一次推送一条台账。 */
  function appendLedger(entry) {
    const pushes = readLedger()
    pushes.unshift({ ...entry, at: new Date().toISOString() })
    atomicWrite(ledgerFile, `${JSON.stringify({ pushes: pushes.slice(0, 500) }, null, 2)}\n`)
    return entry
  }

  /** 推送指纹：账号 + 标题 + 正文，内容一样就是同一次推送。 */
  function fingerprint({ account, title, content }) {
    return createHash('sha256').update(`${account}\n${title}\n${content}`, 'utf8').digest('hex').slice(0, 16)
  }

  /* ---------------------------- 永久素材缓存 ---------------------------- */

  /**
   * 贴图要的是**永久图片素材**的 media_id，一张就占一格永久素材库（上限 10 万，
   * 但一张图重复上传十次就是十格，而且回看时根本分不清哪张是废的）。
   * 所以按「哪个号 + 图片字节 sha256」记一次，同一张图在同一个号上只上传一次。
   * key 里必须带 appid：media_id 是号内的 ID，A 号传的图在 B 号那儿不能用。
   */
  function readMaterials() {
    if (!existsSync(materialsFile)) return []
    try {
      const data = JSON.parse(readFileSync(materialsFile, 'utf8'))
      return Array.isArray(data?.materials) ? data.materials : []
    } catch {
      return []
    }
  }

  /** @param {{appid: string, sha: string}} key 图片内容指纹。 */
  function findMaterial(key) {
    const wanted = `${String(key?.appid ?? '')}|${String(key?.sha ?? '')}`
    if (String(key?.sha ?? '').trim() === '') return null
    const hit = readMaterials().find(entry => `${entry?.appid ?? ''}|${entry?.sha ?? ''}` === wanted)
    return hit === undefined ? null : hit
  }

  /** 记一次上传（同 key 覆盖，最新的排最前，只留最近 2000 条）。 */
  function appendMaterial(entry) {
    const saved = { ...entry, at: new Date().toISOString() }
    const key = `${saved.appid ?? ''}|${saved.sha ?? ''}`
    const materials = readMaterials().filter(row => `${row?.appid ?? ''}|${row?.sha ?? ''}` !== key)
    materials.unshift(saved)
    atomicWrite(materialsFile, `${JSON.stringify({ materials: materials.slice(0, 2000) }, null, 2)}\n`)
    return saved
  }

  // 这里故意没有 removeMaterial：贴图素材是**永久**素材，只删本地缓存不删微信那边，
  // 号里就多一张没人认领的图，缓存反而变成假的。清理只在公众平台素材库后台做，
  // 插件这边由 gzh_material_audit 负责把「哪格是一次性浪费」报清楚。

  mkdirSync(outDir, { recursive: true })

  return {
    dir, accountsFile, skinsFile, rendersFile, ledgerFile, materialsFile, outDir,
    readAccounts, writeAccount, deleteAccount, publicAccount, migrateAccounts,
    readSkins, writeSkin, deleteSkin,
    readRenders, appendRender, findRender,
    readLedger, appendLedger, fingerprint, atomicWrite,
    readMaterials, findMaterial, appendMaterial,
  }
}
