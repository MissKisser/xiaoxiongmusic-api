/**
 * 酷狗音乐账号资料（轻量版）
 *
 * 只读取昵称、头像与会员等级，供列表页、设置页等轻量场景使用。
 * 完整版资料见 user_detail。
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const {
  success,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { businessError } = require('./user_playlist_list')

const logger = createLogger('kugou')

/** 用户中心路由头 */
const USER_CENTER_ROUTER = 'usercenter.kugou.com'

/**
 * 读取账号资料
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  let body
  try {
    body = await kgGatewayRequest(
      '/v3/get_my_info',
      {
        visit_time: Math.floor(Date.now() / 1000),
        usertype: 1,
        p: '',
        userid: Number(session.userid),
      },
      {
        params: { plat: 1 },
        headers: { 'x-router': USER_CENTER_ROUTER },
        session,
      },
    )
  } catch (err) {
    logger.warn('读取账号资料失败：', err.message || err)
    return upstreamError(`读取账号资料失败：${err.message || err}`)
  }

  const error = businessError(body)
  if (error) {
    logger.warn('读取账号资料失败：', error)
    return upstreamError(`读取账号资料失败：${error}`)
  }

  const info = (body && body.data) || {}
  return success({
    code: 200,
    userId: String(session.userid),
    nickname: String(
      info.nickname ||
        info.username ||
        info.user_name ||
        session.nickname ||
        '',
    ),
    avatar: String(
      info.pic || info.userpic || info.user_pic || session.avatar || '',
    ),
    vipType: Number(info.vip_type || session.vipType || 0),
  })
}
