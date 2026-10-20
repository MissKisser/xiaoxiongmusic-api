/**
 * 酷狗音乐扫码登录：获取二维码
 *
 * 走酷狗 Web 登录通道（login-user.kugou.com），请求参数按 Web 签名规则排序后
 * 与盐值拼接做 MD5 校验。本模块不保存任何会话状态，二维码 key 直接返回给调用方，
 * 由调用方在轮询时带回。
 *
 * 除对外处理函数外，本模块还导出同目录 login_qr_check 复用的登录通道工具。
 */

const { kgRequest } = require('../core/request')
const {
  KG_LOGIN_URL,
  KG_ANDROID_UA,
  getKgAppid,
  getKgClientver,
} = require('../core/config')
const { signatureWebParams, getDeviceMid } = require('../core/crypto')
const { success, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** Web 通道固定的应用标识 */
const KG_WEB_APPID = 1001

/** 登录来源应用标识 */
const KG_SRC_APPID = 2919

/**
 * 发送酷狗 Web 登录请求
 * @param {string} path 接口相对路径
 * @param {Record<string, any>} input 业务参数
 * @returns {Promise<any>} 解析后的响应体
 * @throws {Error} 网络异常或响应格式异常时抛出
 */
const loginRequest = async (path, input) => {
  const params = {
    dfid: '-',
    mid: getDeviceMid(),
    uuid: '-',
    appid: KG_WEB_APPID,
    clientver: getKgClientver(),
    clienttime: Math.floor(Date.now() / 1000),
    ...input,
  }
  params.signature = signatureWebParams(params)

  const search = new URLSearchParams()
  Object.keys(params).forEach((key) => {
    search.append(key, String(params[key]))
  })

  return kgRequest(`${KG_LOGIN_URL}${path}?${search.toString()}`, {
    headers: { 'User-Agent': KG_ANDROID_UA },
  })
}

/**
 * 获取扫码登录的二维码
 * @param {Record<string, any>} [query] 调用参数，本接口无需业务参数
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  let body
  try {
    body = await loginRequest('/v2/qrcode', {
      type: 1,
      plat: 4,
      qrcode_txt: `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${getKgAppid()}&`,
      srcappid: KG_SRC_APPID,
    })
  } catch (err) {
    logger.warn('获取酷狗登录二维码失败：', err.message || err)
    return upstreamError(`获取酷狗登录二维码失败：${err.message || err}`)
  }

  const data = (body && body.data) || {}
  const key = String(data.qrcode || '')
  if (!key) {
    return upstreamError('获取酷狗登录二维码失败：响应中缺少二维码 key')
  }

  return success({
    code: 200,
    key,
    content: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${key}`,
  })
}

module.exports.loginRequest = loginRequest
