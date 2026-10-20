/**
 * 酷狗音乐扫码登录：轮询扫码结果
 *
 * 轮询登录通道的扫码状态。status=4 表示用户已确认登录，此时响应里带有账号
 * 凭据（token / userid / vip_token / vip_type），本模块原样返回给调用方，
 * 由调用方持久化；接口层自身不保存任何会话状态。
 */

const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { getKgAppid } = require('../core/config')
const { loginRequest } = require('./login_qr_key')

const logger = createLogger('kugou')

/** 登录来源应用标识 */
const KG_SRC_APPID = 2919

/** 扫码确认成功的状态值 */
const KG_LOGIN_CONFIRMED = 4

/**
 * 轮询扫码登录结果
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const key = String(query.key || query.qrcode || '').trim()
  if (!key) return badRequest('key 不能为空')

  let body
  try {
    body = await loginRequest('/v2/get_userinfo_qrcode', {
      plat: 4,
      appid: getKgAppid(),
      srcappid: KG_SRC_APPID,
      qrcode: key,
    })
  } catch (err) {
    logger.warn('查询酷狗扫码登录状态失败：', err.message || err)
    return upstreamError(`查询酷狗扫码登录状态失败：${err.message || err}`)
  }

  const data = (body && body.data) || {}
  const status = Number(data.status || 1)
  const nickname =
    data.username || data.nickname || data.nick_name || data.user_name
  const avatarUrl =
    data.userpic || data.user_pic || data.avatar || data.avatar_url || data.pic

  if (status !== KG_LOGIN_CONFIRMED) {
    return success({
      code: 200,
      status,
      loggedIn: false,
      nickname: nickname ? String(nickname) : '',
      avatarUrl: avatarUrl
        ? String(avatarUrl).replace(/^http:\/\//, 'https://')
        : '',
    })
  }

  const token = String(data.token || '')
  const userid = String(data.userid || '')
  if (!token || !userid) {
    return upstreamError('酷狗扫码登录失败：响应中缺少登录凭据')
  }

  return success({
    code: 200,
    status,
    loggedIn: true,
    nickname: String(nickname || `KG ${userid}`),
    avatarUrl: avatarUrl
      ? String(avatarUrl).replace(/^http:\/\//, 'https://')
      : '',
    session: {
      token,
      userid,
      vipToken: String(data.vip_token || ''),
      vipType: Number(data.vip_type || 0),
    },
  })
}
