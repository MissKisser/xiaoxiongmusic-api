/**
 * QQ 音乐鉴权状态判定
 *
 * QM 后端把「凭据失效」「授权失败」「参数错误」都塞进同一个 inner 业务码，
 * 其中 1000 尤其多义：
 * - 登录态读取类接口（资料、歌单、推荐、电台）的 1000 表示凭据已过期；
 * - 写类 musicasset.* 接口的 1000 只表示缺少 p_skey 一类互联 cookie 的授权失败，
 *   仍在线的用户也会命中。
 *
 * 两者不分开就会把在线用户误判为登录过期并踢下线，因此按 module 名单分类。
 *
 * 与 electron 侧同构（electron/main/apis/qqmusic/core/auth.ts）：
 * 两端判定口径必须一致，否则同一次故障在两端会得到不同结论。
 */

/** 明确表示「未登录 / 登录态失效」的 inner 业务码（与 module 无关） */
const LOGIN_REQUIRED_INNER_CODES = new Set([104400, 104401])

/** 读取类接口上表示「凭据已过期」的 inner 业务码 */
const AUTH_EXPIRED_INNER_CODE = 1000

/** 写类授权接口的 module 命名规律（music.musicasset.*Write） */
const WRITE_ASSET_MODULE_PATTERN = /^music\.musicasset\..*Write$/

/** 写类授权接口的 module 白名单 */
const WRITE_ASSET_MODULES = new Set(['music.asset.MusicAsset'])

/**
 * 判断某个 module 是否属于写类授权接口
 *
 * 写类接口的 1000 表示「缺少互联 cookie 的授权失败」，不代表凭据过期。
 * @param {string} module 业务 module 名
 * @returns {boolean} 是否为写类授权接口
 */
const isWriteAssetModule = (module) =>
  WRITE_ASSET_MODULE_PATTERN.test(String(module)) ||
  WRITE_ASSET_MODULES.has(String(module))

/**
 * 判定业务码是否代表凭据失效
 *
 * 104400 / 104401 明确表示未登录，任何 module 都按凭据失效处理；
 * 1000 只在读取类接口上表示凭据过期，写类接口上表示授权失败。
 * @param {string} module 业务 module 名
 * @param {number} innerCode 内层业务码
 * @returns {boolean} 是否为凭据失效
 */
const isAuthExpiredCode = (module, innerCode) => {
  if (LOGIN_REQUIRED_INNER_CODES.has(innerCode)) return true
  if (innerCode !== AUTH_EXPIRED_INNER_CODE) return false
  return !isWriteAssetModule(module)
}

/**
 * QQ 音乐业务错误
 *
 * 取代纯字符串异常：调用方据此区分「凭据失效」（需要续期或重新登录）
 * 与「网络故障 / 业务拒绝」（不应动登录态）。
 */
class QQMusicApiError extends Error {
  /**
   * 构造 QQ 音乐业务错误
   * @param {{ outer: number, inner: number, module: string, method: string, authExpired: boolean }} info 错误信息
   */
  constructor({ outer, inner, module, method, authExpired }) {
    super(
      `QQ 音乐接口错误: outer=${outer} inner=${inner} module=${module} method=${method}`,
    )
    this.name = 'QQMusicApiError'
    this.outer = outer
    this.inner = inner
    this.module = module
    this.method = method
    this.authExpired = authExpired
  }
}

/**
 * 判断异常是否为「凭据失效」的 QQ 音乐业务错误
 * @param {any} error 异常对象
 * @returns {boolean} 是否为凭据失效
 */
const isQQMusicAuthExpired = (error) =>
  error instanceof QQMusicApiError && error.authExpired

module.exports = {
  AUTH_EXPIRED_INNER_CODE,
  LOGIN_REQUIRED_INNER_CODES,
  QQMusicApiError,
  isAuthExpiredCode,
  isQQMusicAuthExpired,
  isWriteAssetModule,
}
