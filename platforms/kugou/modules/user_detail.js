/**
 * 酷狗音乐账号资料（完整版）
 *
 * 与轻量版 user_profile 走同一接口，差别在于：
 * - 请求体携带按酷狗协议加密的 p 参数，服务端返回的账号资料更完整
 * - 额外探测概念版会员状态，标准版会员与概念版会员是两套体系
 *
 * 概念版会员探测依赖网关核心层支持 baseURL 覆盖；核心层不支持时自动降级为
 * 仅依据 vip_type 与会话中的 vipType 判断会员状态。
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { rsaEncryptKugou } = require('../core/crypto')
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

/** 会员服务地址 */
const VIP_SERVICE_URL = 'https://kugouvip.kugou.com'

/**
 * 探测概念版会员状态
 * @param {{ token: string, userid: string | number }} session 酷狗会话凭据
 * @returns {Promise<boolean>} 是否为概念版会员
 */
const unionVipEnabled = async (session) => {
  try {
    const body = await kgGatewayRequest(
      '/v1/get_union_vip',
      {},
      {
        params: { busi_type: 'concept' },
        baseURL: VIP_SERVICE_URL,
        session,
      },
    )

    if (businessError(body)) return false

    const list = (body && body.data && body.data.busi_vip) || []
    const first = Array.isArray(list) ? list[0] : null
    return Number((first || {}).is_vip) === 1
  } catch (err) {
    logger.debug('概念版会员状态探测失败，按非会员处理：', err.message || err)
    return false
  }
}

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

  const clienttime = Math.floor(Date.now() / 1000)

  let body
  try {
    body = await kgGatewayRequest(
      '/v3/get_my_info',
      {
        visit_time: clienttime,
        usertype: 1,
        p: rsaEncryptKugou({ token: session.token, clienttime }).toUpperCase(),
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
  const nickname = String(
    info.nickname || info.username || info.user_name || session.nickname || '',
  )
  const avatar = String(
    info.pic || info.userpic || info.user_pic || session.avatar || '',
  ).replace(/^http:\/\//, 'https://')
  const vipType = Number(info.vip_type || session.vipType || 0)

  const isVip =
    vipType > 0 ||
    (await unionVipEnabled(session)) ||
    Number(session.vipType || 0) > 0

  return success({
    code: 200,
    loggedIn: true,
    profile: {
      userId: String(session.userid),
      nickname: nickname || `KG ${session.userid}`,
      avatarUrl: avatar,
      isVip,
      vipLevel: vipType,
    },
  })
}
