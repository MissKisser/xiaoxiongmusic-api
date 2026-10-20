/**
 * 酷狗会话凭据读取
 *
 * 接口层不保存任何会话状态，凭据一律来自调用参数。
 * 读取优先级：
 * 1. `query.session` —— 服务层注入的凭据对象
 * 2. `query.cookie` —— cookie 里的酷狗字段
 * 3. `query.token` / `query.userid` 等散字段
 */

const { parseCookie } = require('../../shared/cookie')

/**
 * 酷狗会话凭据
 *
 * @typedef {object} KgSession
 * @property {string} token 登录 token
 * @property {string} userid 账号 ID
 * @property {string} dfid 设备指纹
 * @property {string} vipToken 会员 token
 * @property {string} vipType 会员类型
 */

/** 各字段的可接受别名，带平台前缀的优先 */
const FIELD_ALIASES = {
  token: ['kg_token', 'kugou_token', 'token'],
  userid: ['kg_userid', 'kugou_userid', 'userid', 'user_id', 'uid'],
  dfid: ['kg_dfid', 'kugou_dfid', 'dfid'],
  vipToken: ['kg_vip_token', 'kugou_vip_token', 'vipToken', 'vip_token'],
  vipType: ['kg_vip_type', 'kugou_vip_type', 'vipType', 'vip_type'],
}

/**
 * 从任意来源里取第一个非空字段
 * @param {Record<string, any>} source 字段来源
 * @param {string[]} aliases 候选字段名
 * @returns {string} 字段值，取不到时返回空串
 */
const readField = (source, aliases) => {
  for (const alias of aliases) {
    const value = source[alias]
    if (value === undefined || value === null) continue
    const text = String(value)
    if (text) return text
  }
  return ''
}

/**
 * 从一个对象里提取酷狗会话
 * @param {any} source 字段来源
 * @returns {KgSession | null} 会话，无凭据时返回 null
 */
const pickSession = (source) => {
  if (!source || typeof source !== 'object') return null

  const session = {
    token: readField(source, FIELD_ALIASES.token),
    userid: readField(source, FIELD_ALIASES.userid),
    dfid: readField(source, FIELD_ALIASES.dfid),
    vipToken: readField(source, FIELD_ALIASES.vipToken),
    vipType: readField(source, FIELD_ALIASES.vipType),
  }

  if (!session.token && !session.userid) return null
  return session
}

/**
 * 读取酷狗会话凭据
 *
 * 优先取服务层注入的 `query.session`，其次取 cookie 里的酷狗字段，
 * 最后取 `query.token` / `query.userid` 等散字段。
 * @param {any} query 调用参数
 * @returns {KgSession | null} 会话凭据，没有任何凭据时返回 null
 */
const readSession = (query) => {
  if (!query || typeof query !== 'object') return null

  const injected = pickSession(query.session)
  if (injected) return injected

  const fromCookie = pickSession(parseCookie(query.cookie))
  if (fromCookie) return fromCookie

  return pickSession({
    token: query.token,
    userid: query.userid ?? query.uid,
    dfid: query.dfid,
    vipToken: query.vipToken ?? query.vip_token,
    vipType: query.vipType ?? query.vip_type,
  })
}

/**
 * 判断会话是否可用于需要账号的接口
 * @param {KgSession | null} session 会话凭据
 * @returns {boolean} 同时具备 token 与 userid 时为 true
 */
const isLoggedIn = (session) =>
  Boolean(session && session.token && session.userid)

module.exports = {
  readSession,
  pickSession,
  isLoggedIn,
}
