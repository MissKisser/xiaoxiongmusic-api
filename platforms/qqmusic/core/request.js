/**
 * QQ 音乐接口请求层
 *
 * 协议要点：
 * - 接口是双段式：`module` + `method`，统一走 musicu.fcg 的
 *   `{ comm, request: { module, method, param } }` 结构
 * - 请求本身不加密，靠 UA 与 comm 字段伪装客户端
 * - Referer 统一带尾斜杠（`https://y.qq.com/`），否则写接口会被判为非法来源
 *
 * 无状态约束：
 * - 凭据只从 `options.session` 取，取不到就抛未登录错误，绝不回退到模块级状态
 * - 不做任何跨请求缓存，也不保存刷新结果；刷新由服务层独占
 */

const { createLogger } = require('../../shared/logger')

const {
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
} = require('./config')

const {
  readSession,
  normalizeSession,
  sessionToCookieHeader,
  resolveLoginType,
  credentialToSession,
  buildRefreshParam,
} = require('./credential')

const {
  QQMusicApiError,
  isAuthExpiredCode,
  isQQMusicAuthExpired,
} = require('./auth')

const logger = createLogger('qqmusic')

/**
 * 等待指定毫秒
 * @param {number} ms 等待毫秒数
 * @returns {Promise<void>} 等待结束
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 发起一次 musicu.fcg 请求
 * @param {Record<string, any>} body 请求体
 * @param {Record<string, any>} [options] { referer, timeoutMs, cookie }
 * @returns {Promise<Record<string, any>>} 解析后的响应体
 */
const postFcg = async (body, options = {}) => {
  const {
    referer = QM_REFERER,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cookie,
  } = options

  const headers = { ...QM_HEADERS, Referer: referer }
  if (cookie) headers.Cookie = cookie

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(QM_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`QQ 音乐接口 HTTP ${response.status}`)
    }

    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 传输层重试
 *
 * 只重试网络故障，业务错误码不在这里重试，避免写接口被重复执行。
 * @param {() => Promise<any>} task 待执行的任务
 * @returns {Promise<any>} 任务结果
 */
const withRetry = async (task) => {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      return await task()
    } catch (err) {
      lastError = err
      if (attempt < MAX_RETRY) await delay(RETRY_BACKOFF_MS)
    }
  }
  throw lastError
}

/**
 * 解析本次请求使用的凭据
 *
 * @param {any} session 调用方传入的凭据
 * @returns {{ uin: string, cookies: Record<string, string> }} 归一化后的凭据
 */
const resolveCredential = (session) => {
  if (session === undefined) {
    throw new Error('QQ 音乐未登录：缺少 session 凭据')
  }
  if (session === null || session === false) {
    return { uin: '', cookies: {} }
  }
  const credential = normalizeSession(session)
  if (!credential) {
    throw new Error('QQ 音乐未登录：session 凭据无效')
  }
  return credential
}

/**
 * 判定本次请求用网页端 comm 还是移动端 comm
 * @param {string} module 接口模块名
 * @param {boolean} [explicit] 调用方显式指定
 * @returns {boolean} 是否使用网页端 comm
 */
const resolveWebComm = (module, explicit) => {
  if (typeof explicit === 'boolean') return explicit
  return WEB_COMM_MODULE_PREFIXES.some((prefix) =>
    String(module).startsWith(prefix),
  )
}

/**
 * 取一次 QQ 客户端会话（uid / sid / userip）
 *
 * 每次请求独立取，不做跨请求缓存，避免多账号场景串号。
 * @param {string} module 接口模块名
 * @param {{ uin: string, cookies: Record<string, string> }} credential 归一化凭据
 * @param {Record<string, any>} [options] { initSession, referer, timeoutMs }
 * @returns {Promise<Record<string, any>>} 客户端会话字段，取不到时为空对象
 */
const loadClientSession = async (module, credential, options = {}) => {
  const wanted =
    options.initSession === true ||
    CLIENT_SESSION_MODULES.includes(String(module))
  if (!wanted) return {}
  if (!credential.uin || credential.uin === '0') return {}

  try {
    const response = await postFcg(
      {
        comm: { ...MOBILE_COMM, uin: credential.uin, qq: credential.uin },
        request: {
          module: 'music.getSession.session',
          method: 'GetSession',
          param: { caller: 0, uid: credential.uin, vkey: 0 },
        },
      },
      {
        referer: options.referer || QM_REFERER,
        timeoutMs: options.timeoutMs,
        cookie: sessionToCookieHeader(credential.cookies),
      },
    )

    if (
      response.code === 0 &&
      response.request &&
      response.request.code === 0
    ) {
      const info = response.request.data && response.request.data.session
      if (info) {
        return { uid: info.uid, sid: info.sid, userip: info.userip }
      }
    }
  } catch (err) {
    logger.warn(
      'QQ 音乐客户端会话初始化失败，按无会话继续：',
      err && err.message,
    )
  }

  return {}
}

/**
 * 发送 QQ 音乐接口请求
 *
 * `options` 支持的字段：
 * - `session`：凭据对象 `{ uin, cookies }`；不传则抛未登录错误，
 *   传 `null` / `false` 表示显式匿名请求（登录类接口用）
 * - `referer`：覆盖本次请求的 Referer，默认 `https://y.qq.com/`
 * - `timeoutMs`：请求超时毫秒数
 * - `webComm`：强制使用网页端 comm
 * - `comm`：追加到 comm 的字段
 * - `initSession`：本次请求前是否先取一次 QQ 客户端会话
 * - `autoRefresh`：凭据失效时是否先续期再重放一次（默认关闭）
 * - `onRefreshed`：续期成功后的回调，参数为新的凭据 `{ uin, cookies }`
 *
 * @param {string} module 接口模块名，如 music.musicasset.PlaylistBaseRead
 * @param {string} method 接口方法名，如 GetPlaylistByUin
 * @param {Record<string, any>} param 业务参数
 * @param {Record<string, any>} [options] { session, referer, timeoutMs }
 * @returns {Promise<any>} 接口返回的业务数据段
 */
const qmRequest = async (module, method, param, options = {}) => {
  const credential = resolveCredential(options.session)

  /**
   * 用一份凭据发起请求
   * @param {{ uin: string, cookies: Record<string, string> }} current 归一化凭据
   * @returns {Promise<any>} 接口返回的业务数据段
   */
  const execute = async (current) => {
    const cookies = current.cookies
    const uin = current.uin
    const musickey = cookies.qm_keyst || cookies.qqmusic_key
    const loginType = resolveLoginType(cookies, musickey)
    const useWebComm = resolveWebComm(module, options.webComm)

    const clientSession = await loadClientSession(module, current, options)

    const comm = {
      ...(useWebComm ? WEB_COMM : MOBILE_COMM),
      ...(uin && uin !== '0' ? { uin, qq: uin } : {}),
      ...(musickey ? { authst: musickey } : {}),
      ...(loginType ? { tmeLoginType: loginType } : {}),
      ...(clientSession.uid ? { uid: clientSession.uid } : {}),
      ...(clientSession.sid ? { sid: clientSession.sid } : {}),
      ...(clientSession.userip ? { userip: clientSession.userip } : {}),
      ...(options.comm || {}),
    }

    const body = { comm, request: { module, method, param } }

    const response = await withRetry(() =>
      postFcg(body, {
        referer: options.referer || QM_REFERER,
        timeoutMs: options.timeoutMs,
        cookie: sessionToCookieHeader(cookies),
      }),
    )

    const outerCode = response.code === undefined ? 0 : response.code
    const innerCode =
      response.request && response.request.code !== undefined
        ? response.request.code
        : 0

    if (outerCode !== 0 || innerCode !== 0) {
      throw new QQMusicApiError({
        outer: outerCode,
        inner: innerCode,
        module,
        method,
        authExpired: isAuthExpiredCode(module, innerCode),
      })
    }

    return response.request ? response.request.data : undefined
  }

  try {
    return await execute(credential)
  } catch (err) {
    // 鉴权失效：续期后重放一次。
    // refresh_key 是一次性的，接口层不保存刷新结果，只把新凭据交回调用方。
    if (!isQQMusicAuthExpired(err) || options.autoRefresh !== true) throw err

    const refreshed = await refreshQQMusicCredential(credential, options)
    if (!refreshed.ok || !refreshed.session) throw err
    if (typeof options.onRefreshed === 'function') {
      options.onRefreshed(refreshed.session)
    }
    return await execute(refreshed.session)
  }
}

/**
 * 用给定凭据刷新一次 musickey
 *
 * QQ 音乐的 refresh_key 是一次性的，刷新后旧 key 立即失效，
 * 因此刷新结果只返回给调用方，由服务层决定如何落库，接口层不保存。
 * @param {any} session 待刷新的凭据
 * @param {Record<string, any>} [options] { referer, timeoutMs }
 * @returns {Promise<{ ok: boolean, session: { uin: string, cookies: Record<string, string> } | null, reason?: string }>} 刷新结果
 */
const refreshQQMusicCredential = async (session, options = {}) => {
  const credential = normalizeSession(session)
  if (!credential) {
    return { ok: false, session: null, reason: '缺少凭据' }
  }

  const musickey = credential.cookies.qm_keyst || credential.cookies.qqmusic_key
  if (!credential.uin || credential.uin === '0' || !musickey) {
    return { ok: false, session: null, reason: '凭据不完整' }
  }

  const loginType = resolveLoginType(credential.cookies, musickey)

  try {
    const response = await postFcg(
      {
        comm: {
          ...MOBILE_COMM,
          uin: credential.uin,
          qq: credential.uin,
          authst: musickey,
          tmeLoginType: loginType,
        },
        request: {
          module: 'music.login.LoginServer',
          method: 'Login',
          param: buildRefreshParam(credential, loginType),
        },
      },
      {
        referer: options.referer || QM_REFERER,
        timeoutMs: options.timeoutMs,
        cookie: sessionToCookieHeader(credential.cookies),
      },
    )

    const outerCode = response.code === undefined ? 0 : response.code
    const innerCode =
      response.request && response.request.code !== undefined
        ? response.request.code
        : 0

    if (outerCode !== 0 || innerCode !== 0) {
      return {
        ok: false,
        session: null,
        reason: `刷新被拒绝: outer=${outerCode} inner=${innerCode}`,
      }
    }

    const data = (response.request && response.request.data) || {}
    if (!data.musickey) {
      return { ok: false, session: null, reason: '刷新响应缺少 musickey' }
    }

    const refreshed = credentialToSession(data, loginType, credential.uin)
    return {
      ok: true,
      session: {
        uin: refreshed.uin || credential.uin,
        cookies: { ...credential.cookies, ...refreshed },
      },
    }
  } catch (err) {
    return {
      ok: false,
      session: null,
      reason: (err && err.message) || '刷新失败',
    }
  }
}

module.exports = {
  qmRequest,
  refreshQQMusicCredential,
  readSession,
}
