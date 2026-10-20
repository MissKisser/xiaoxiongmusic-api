/**
 * 平台接口统一响应形状
 *
 * 与上游 `module/` 的返回约定保持一致：{ status, body, cookie }
 * 上游 server.js 会把 moduleResponse.status 作为 HTTP 状态码、
 * moduleResponse.body 作为响应体、moduleResponse.cookie 回写 Set-Cookie。
 */

/**
 * 构造成功响应
 * @param {any} body 业务响应体
 * @param {Record<string, any>} [extra] 追加字段
 * @returns {{ status: number, body: any, cookie: string[] }}
 */
const success = (body, extra = {}) => ({
  status: 200,
  body,
  cookie: [],
  ...extra,
})

/**
 * 构造失败响应
 * @param {number} status HTTP 状态码
 * @param {any} body 业务响应体
 * @returns {{ status: number, body: any, cookie: string[] }}
 */
const failure = (status, body) => ({ status, body, cookie: [] })

/**
 * 构造「需要登录」响应
 *
 * 上游 server.js 约定：body.code 为 301 时会被改写 msg 为「需要登录」。
 * @param {string} [message] 提示文案
 * @returns {{ status: number, body: any, cookie: string[] }}
 */
const unauthorized = (message = '需要登录') =>
  failure(301, { code: 301, message })

/**
 * 构造参数错误响应
 * @param {string} message 提示文案
 * @returns {{ status: number, body: any, cookie: string[] }}
 */
const badRequest = (message) => failure(400, { code: 400, message })

/**
 * 构造上游平台调用失败响应
 * @param {string} message 提示文案
 * @param {any} [body] 追加到响应体的字段
 * @returns {{ status: number, body: any, cookie: string[] }}
 */
const upstreamError = (message, body = {}) =>
  failure(502, { code: 502, message, ...body })

module.exports = {
  success,
  failure,
  unauthorized,
  badRequest,
  upstreamError,
}
