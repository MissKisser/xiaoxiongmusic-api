/**
 * QQ 音乐凭据解析
 *
 * 凭据一律从调用参数里取，接口层不保存任何登录态：
 * - `query.session`：服务层注入的凭据对象 `{ uin, cookies }`，推荐路径
 * - `query.cookie`：QQ 音乐自己的 cookie 字段
 * - `query.uin` / `query.qm_keyst` 等散字段
 *
 * 三者都取不到时返回 null，由调用方决定如何处理（未登录）。
 */

const { parseCookie } = require('../../shared/cookie')

const { LOGIN_TYPE } = require('./config')

/**
 * uin 在 cookie 中的取值顺序
 * @type {string[]}
 */
const UIN_COOKIE_KEYS = ['qm_str_musicid', 'uin', 'wxuin', 'p_uin']

/**
 * 可从散字段直接读取的 cookie 字段
 * @type {string[]}
 */
const SCATTER_COOKIE_KEYS = [
  'qm_keyst',
  'qqmusic_key',
  'qm_str_musicid',
  'wxuin',
  'p_uin',
  'p_skey',
  'skey',
  'pskey',
  'qm_refresh_key',
  'qm_key_expires_in',
  'tmeLoginType',
  'euin',
  'wxopenid',
  'psrf_qqopenid',
  'psrf_qqunionid',
  'wxrefresh_token',
  'psrf_qqrefresh_token',
  'psrf_qqaccess_token',
  'psrf_access_token_expiresAt',
  'psrf_musickey_createtime',
]

/**
 * 归一化 uin
 *
 * QQ 系 uin 可能带 `o` 前缀（互联域），音乐域账号是纯数字。
 * @param {any} value 原始 uin
 * @returns {string} 纯数字 uin，无有效值时返回空串
 */
const normalizeUin = (value) => {
  if (value === undefined || value === null) return ''
  const text = String(value).trim()
  if (!text || text === '0') return ''
  return text.replace(/^o/, '')
}

/**
 * 从 cookie 字段里取 uin
 * @param {Record<string, string>} cookies cookie 键值对
 * @returns {string} 纯数字 uin，无有效值时返回空串
 */
const pickUin = (cookies) => {
  if (!cookies) return ''
  for (const key of UIN_COOKIE_KEYS) {
    const uin = normalizeUin(cookies[key])
    if (uin) return uin
  }
  return ''
}

/**
 * 判断 cookie 是否带音乐账号凭据
 * @param {Record<string, string>} cookies cookie 键值对
 * @returns {boolean} 是否带 musickey
 */
const hasMusicKey = (cookies) =>
  Boolean(cookies && (cookies.qm_keyst || cookies.qqmusic_key))

/**
 * 拼出发给 QQ 音乐的 Cookie 请求头
 * @param {Record<string, string>} cookies cookie 键值对
 * @returns {string | undefined} Cookie 头，无可发送字段时返回 undefined
 */
const sessionToCookieHeader = (cookies) => {
  if (!cookies) return undefined
  const entries = Object.entries(cookies).filter(([, value]) => Boolean(value))
  if (entries.length === 0) return undefined
  return entries.map(([key, value]) => `${key}=${value}`).join('; ')
}

/**
 * 清洗 cookie 键值对，去掉空值
 * @param {Record<string, any>} cookies cookie 键值对
 * @returns {Record<string, string>} 清洗后的 cookie 键值对
 */
const normalizeCookies = (cookies) => {
  const normalized = {}
  for (const [key, value] of Object.entries(cookies || {})) {
    if (value === undefined || value === null) continue
    const text = String(value)
    if (text) normalized[key] = text
  }
  return normalized
}

/**
 * 组装一份凭据
 *
 * 只有拿到 uin 或 musickey 才算有效凭据。
 * @param {string} uin 纯数字 uin
 * @param {Record<string, any>} cookies cookie 键值对
 * @returns {{ uin: string, cookies: Record<string, string> } | null} 无有效凭据时返回 null
 */
const buildSession = (uin, cookies) => {
  const normalizedCookies = normalizeCookies(cookies)
  const normalizedUin = normalizeUin(uin) || pickUin(normalizedCookies)
  if (!normalizedUin && !hasMusicKey(normalizedCookies)) return null
  return { uin: normalizedUin, cookies: normalizedCookies }
}

/**
 * 归一化调用方显式给出的凭据
 *
 * 支持 `{ uin, cookies }`、`{ uin, cookie }`、cookie 字符串。
 * 与 readSession 的区别：这里只要求「调用方确实给了内容」，
 * 因此登录类接口可以显式传一个只有登录类型提示的空凭据。
 * @param {any} value 原始凭据
 * @returns {{ uin: string, cookies: Record<string, string> } | null} 无内容时返回 null
 */
const normalizeSession = (value) => {
  if (value === undefined || value === null || value === false) return null
  if (typeof value === 'string') {
    const cookies = normalizeCookies(parseCookie(value))
    const uin = pickUin(cookies)
    if (!uin && Object.keys(cookies).length === 0) return null
    return { uin, cookies }
  }
  if (typeof value !== 'object') return null
  const rawCookies =
    value.cookies !== undefined && value.cookies !== null
      ? value.cookies
      : value.cookie
  const cookies = normalizeCookies(parseCookie(rawCookies))
  const uin = normalizeUin(value.uin) || pickUin(cookies)
  if (!uin && Object.keys(cookies).length === 0) return null
  return { uin, cookies }
}

/**
 * 从调用参数中取出 QQ 音乐凭据
 *
 * 读取优先级：`query.session` → `query.cookie` → 散字段。
 * @param {any} query 调用参数
 * @returns {{ uin: string, cookies: Record<string, string> } | null} 无凭据时返回 null
 */
const readSession = (query) => {
  if (!query || typeof query !== 'object') return null

  const injected = normalizeSession(query.session)
  if (injected && (injected.uin || hasMusicKey(injected.cookies)))
    return injected

  const cookieFields = parseCookie(query.cookie)
  const fromCookie = buildSession(pickUin(cookieFields), cookieFields)
  if (fromCookie) return fromCookie

  const scatterCookies = {}
  for (const key of SCATTER_COOKIE_KEYS) {
    const value = query[key]
    if (value === undefined || value === null) continue
    const text = String(value)
    if (text) scatterCookies[key] = text
  }
  return buildSession(query.uin, scatterCookies)
}

/**
 * 判定登录类型
 *
 * 没有任何线索时返回 0（未知），不擅自假定登录类型。
 * @param {Record<string, string>} cookies cookie 键值对
 * @param {string} [musickey] 音乐凭据
 * @returns {number} 1 = 微信，2 = QQ，0 = 未知
 */
const resolveLoginType = (cookies, musickey) => {
  const raw = cookies ? cookies.tmeLoginType : undefined
  if (raw !== undefined && raw !== null && raw !== '') {
    const value = Number(raw)
    if (value) return value
  }
  if (!musickey) return 0
  return String(musickey).startsWith('W_X') ? LOGIN_TYPE.WECHAT : LOGIN_TYPE.QQ
}

/**
 * 取凭据对应的真实音乐账号 ID
 * @param {Record<string, any>} credential QQ 音乐登录凭据
 * @param {string} [fallback] 未返回账号 ID 时的回退值
 * @returns {string} 音乐账号 ID
 */
const getCredentialMusicId = (credential, fallback = '') => {
  const source = credential || {}
  return String(source.str_musicid || source.musicid || fallback).replace(
    /^o/,
    '',
  )
}

/**
 * 把登录响应转换为可持久化的会话字段
 * @param {Record<string, any>} credential QQ 音乐登录凭据
 * @param {number} loginType 登录类型
 * @param {string} [fallbackMusicId] 未返回账号 ID 时的回退值
 * @returns {Record<string, string>} 可持久化的会话字段
 */
const credentialToSession = (credential, loginType, fallbackMusicId = '') => {
  const source = credential || {}
  const musicId = getCredentialMusicId(source, fallbackMusicId)
  const session = {
    uin: musicId,
    qm_str_musicid: musicId,
    qm_keyst: source.musickey || '',
    qqmusic_key: source.musickey || '',
    tmeLoginType: String(source.loginType || loginType),
  }

  if (loginType === LOGIN_TYPE.WECHAT) session.wxuin = musicId
  if (source.encryptUin) session.euin = source.encryptUin
  if (source.openid) {
    session[loginType === LOGIN_TYPE.WECHAT ? 'wxopenid' : 'psrf_qqopenid'] =
      source.openid
  }
  if (source.unionid) session.psrf_qqunionid = source.unionid
  if (source.refresh_token) {
    session[
      loginType === LOGIN_TYPE.WECHAT
        ? 'wxrefresh_token'
        : 'psrf_qqrefresh_token'
    ] = source.refresh_token
  }
  if (source.access_token) session.psrf_qqaccess_token = source.access_token
  if (source.refresh_key) session.qm_refresh_key = source.refresh_key
  if (source.expired_at)
    session.psrf_access_token_expiresAt = String(source.expired_at)
  if (source.musickeyCreateTime) {
    session.psrf_musickey_createtime = String(source.musickeyCreateTime)
  }
  if (source.keyExpiresIn)
    session.qm_key_expires_in = String(source.keyExpiresIn)

  return session
}

/**
 * 构造刷新凭据用的 LoginServer.Login 参数
 * @param {{ uin: string, cookies: Record<string, string> }} session 待刷新的凭据
 * @param {number} loginType 登录类型
 * @returns {Record<string, any>} LoginServer.Login 的 param
 */
const buildRefreshParam = (session, loginType) => {
  const cookies = (session && session.cookies) || {}
  const uin = (session && session.uin) || ''
  const musickey = cookies.qm_keyst || cookies.qqmusic_key || ''
  const refreshKey = cookies.qm_refresh_key || ''

  if (loginType === LOGIN_TYPE.WECHAT) {
    return {
      openid: cookies.wxopenid || cookies.psrf_qqopenid || '',
      refresh_token:
        cookies.wxrefresh_token || cookies.psrf_qqrefresh_token || '',
      str_musicid: cookies.qm_str_musicid || uin,
      musickey,
      unionid: cookies.psrf_qqunionid || '',
      refresh_key: refreshKey,
      loginMode: 2,
    }
  }

  return {
    openid: cookies.psrf_qqopenid || cookies.wxopenid || '',
    access_token: cookies.psrf_qqaccess_token || '',
    refresh_token:
      cookies.psrf_qqrefresh_token || cookies.wxrefresh_token || '',
    expired_in: Number(cookies.psrf_access_token_expiresAt) || 0,
    musicid: Number(uin) || 0,
    musickey,
    refresh_key: refreshKey,
    loginMode: 2,
  }
}

module.exports = {
  readSession,
  normalizeSession,
  normalizeUin,
  pickUin,
  hasMusicKey,
  sessionToCookieHeader,
  resolveLoginType,
  getCredentialMusicId,
  credentialToSession,
  buildRefreshParam,
}
