/**
 * 酷狗请求层
 *
 * 提供三种请求方式：
 * - kgGatewayRequest：协议 A，网关 Android 签名 + 明文 JSON body
 * - kgCloudRequest：协议 B，key + p 双因子 + AES 加密 body
 * - kgRequest：公开接口的普通 GET 请求
 *
 * 凭据全部来自 `options.session` 入参，本层不持有任何会话状态。
 */

const {
  KG_CLOUD_APPID,
  KG_CLOUD_CLIENTVER,
  KG_CLOUD_SIGN_SALT,
  KG_DEFAULT_TIMEOUT_MS,
  KG_GATEWAY_URL,
  getKgAppid,
  getKgClientver,
  getSignSalt,
} = require('./config')

const { cleanKgResponse, getDeviceMid } = require('./crypto')
const {
  buildCloudRequest,
  buildGatewayRequest,
  decryptCloudResponse,
} = require('./cloud')

/**
 * 解析响应文本
 * @param {string} text 响应文本
 * @returns {any} 解析结果，失败时返回原文
 */
const parseBody = (text) => {
  try {
    return JSON.parse(cleanKgResponse(text))
  } catch {
    return text
  }
}

/**
 * 由会话构造协议请求上下文
 * @param {any} session 会话凭据
 * @param {Record<string, any>} [overrides] 需要覆盖的上下文字段
 * @returns {import('./cloud').KgRequestContext} 请求上下文
 */
const buildContext = (session, overrides = {}) => ({
  appid: getKgAppid(),
  clientver: getKgClientver(),
  signSalt: getSignSalt(),
  mid: getDeviceMid(),
  dfid: (session && session.dfid) || '-',
  userid: session && session.userid ? String(session.userid) : '',
  token: session && session.token ? String(session.token) : '',
  clienttime: Math.floor(Date.now() / 1000),
  ...overrides,
})

/**
 * 协议 A：网关 Android 签名（明文 JSON body）
 *
 * 业务级 `error_code` 不会抛异常，由调用方判定；HTTP 与网络异常抛错。
 * @param {string} path 网关相对路径
 * @param {Record<string, any>} body 业务请求体
 * @param {{ params?: Record<string, any>, headers?: Record<string, string>, timeoutMs?: number, session?: any, baseURL?: string, method?: 'GET' | 'POST' }} [options] 请求配置
 * @returns {Promise<any>} 网关响应体
 */
const kgGatewayRequest = async (path, body, options = {}) => {
  const {
    params = {},
    headers = {},
    timeoutMs = KG_DEFAULT_TIMEOUT_MS,
    session = null,
    baseURL = KG_GATEWAY_URL,
    method = 'POST',
  } = options

  const built = buildGatewayRequest(path, body, buildContext(session), {
    params,
    headers,
    baseURL,
    method,
  })

  const isGet = built.method === 'GET'
  const res = await fetch(built.url, {
    method: built.method,
    headers: built.headers,
    body: isGet ? undefined : built.body,
    signal: AbortSignal.timeout(timeoutMs),
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`酷狗网关 HTTP ${res.status}`)
  return parseBody(text)
}

/**
 * 协议 B：云歌单新协议（key + p 双因子，AES-128-CBC body）
 *
 * 业务级 `error_code` 不会抛异常，由调用方判定；HTTP 与网络异常抛错。
 * @param {string} path 网关相对路径
 * @param {Record<string, any>} body 业务请求体
 * @param {{ session?: any, timeoutMs?: number, baseURL?: string }} [options] 请求配置
 * @returns {Promise<any>} 解密后的响应体
 */
const kgCloudRequest = async (path, body, options = {}) => {
  const {
    session = null,
    timeoutMs = KG_DEFAULT_TIMEOUT_MS,
    baseURL = KG_GATEWAY_URL,
  } = options

  if (!session || !session.token || !session.userid) {
    throw new Error('酷狗未登录：协议 B 需要同时提供 token 与 userid')
  }

  const built = buildCloudRequest(
    path,
    body,
    buildContext(session, {
      appid: KG_CLOUD_APPID,
      clientver: KG_CLOUD_CLIENTVER,
      signSalt: KG_CLOUD_SIGN_SALT,
    }),
    { baseURL },
  )

  const res = await fetch(built.url, {
    method: 'POST',
    headers: built.headers,
    body: built.body,
    signal: AbortSignal.timeout(timeoutMs),
  })

  const raw = Buffer.from(await res.arrayBuffer())
  if (!res.ok) throw new Error(`酷狗云歌单 HTTP ${res.status}`)
  return parseBody(decryptCloudResponse(raw, built.aes))
}

/**
 * 公开接口的普通 GET 请求
 * @param {string} url 完整请求地址
 * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [options] 请求配置
 * @returns {Promise<any>} 解析后的响应体
 */
const kgRequest = async (url, options = {}) => {
  const { headers = {}, timeoutMs = KG_DEFAULT_TIMEOUT_MS } = options

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`酷狗 HTTP ${res.status}`)
  return parseBody(text)
}

/**
 * 取出响应体里的业务错误码
 * @param {any} body 响应体
 * @returns {number} 错误码，没有错误码时返回 0
 */
const kgErrorCode = (body) => {
  if (!body || typeof body !== 'object') return 0
  const code = body.error_code ?? body.errcode ?? body.err_code ?? 0
  return Number(code) || 0
}

module.exports = {
  kgGatewayRequest,
  kgCloudRequest,
  kgRequest,
  kgErrorCode,
  buildContext,
}
