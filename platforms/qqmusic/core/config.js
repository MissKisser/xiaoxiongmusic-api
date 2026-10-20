/**
 * QQ 音乐接口层常量
 *
 * 只放常量与纯函数，不含任何会话状态：接口层无状态是平台层契约的硬性要求，
 * 凭据一律由调用参数传入。
 */

/**
 * 统一接口入口
 * @type {string}
 */
const QM_API_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

/**
 * 默认请求头
 * @type {Record<string, string>}
 */
const QM_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'QQMusic 14090008(android 15)',
}

/**
 * 默认 Referer
 *
 * 必须带尾斜杠。QQ 音乐对写接口校验来源，无尾斜杠的 `https://y.qq.com`
 * 会让写操作一律返回 inner=1000 / "authorize fail"，而读操作正常。
 * @type {string}
 */
const QM_REFERER = 'https://y.qq.com/'

/**
 * 移动端 comm 字段（伪装 Android 客户端）
 * @type {Record<string, string | number>}
 */
const MOBILE_COMM = {
  ct: 11,
  cv: 14090008,
  v: 14090008,
  chid: '10003505',
  os_ver: '15',
  phonetype: '24122RKC7C',
  tmeAppID: 'qqmusic',
  nettype: 'NETWORK_WIFI',
  udid: '0',
  OpenUDID: '0',
  QIMEI36: '0',
  uin: '0',
}

/**
 * 网页端 comm 字段（歌单类接口使用）
 * @type {Record<string, string | number>}
 */
const WEB_COMM = {
  ct: 24,
  cv: 0,
  format: 'json',
  platform: 'yqq.json',
}

/**
 * 必须使用网页端 comm 的 module 前缀
 *
 * 这组歌单接口在移动端 comm 下会返回「invalid referer」。
 * @type {string[]}
 */
const WEB_COMM_MODULE_PREFIXES = ['music.srfDissInfo.']

/**
 * 需要 QQ 客户端会话（uid / sid / userip）的 module
 *
 * 这两个接口在客户端侧依赖客户端会话才能取到当前登录用户信息。
 * @type {string[]}
 */
const CLIENT_SESSION_MODULES = [
  'music.UserInfo.userInfoServer',
  'VipLogin.VipLoginInter',
]

/**
 * 默认超时（毫秒）
 * @type {number}
 */
const DEFAULT_TIMEOUT_MS = 8000

/**
 * 网络层重试次数与退避间隔（毫秒）
 *
 * 只对传输层故障重试，业务错误码不重试，避免写接口被重复执行。
 * @type {number}
 */
const MAX_RETRY = 2

/**
 * 重试退避间隔（毫秒）
 * @type {number}
 */
const RETRY_BACKOFF_MS = 300

/**
 * 登录类型
 * @type {{ WECHAT: number, QQ: number }}
 */
const LOGIN_TYPE = {
  WECHAT: 1,
  QQ: 2,
}

module.exports = {
  QM_API_URL,
  QM_HEADERS,
  QM_REFERER,
  MOBILE_COMM,
  WEB_COMM,
  WEB_COMM_MODULE_PREFIXES,
  CLIENT_SESSION_MODULES,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY,
  RETRY_BACKOFF_MS,
  LOGIN_TYPE,
}
