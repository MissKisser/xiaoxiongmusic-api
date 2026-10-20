/**
 * QQ 音乐：账号资料
 *
 * 读取当前登录账号的昵称、头像与会员播放权限。
 * 凭据全部来自调用参数，接口层不持有任何会话。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 归一化会员信息
 * @param {Record<string, any> | null} data vip_login_base 的响应数据
 * @returns {{ isVip: boolean, vipLevel: number }} 会员播放权限与等级
 */
const normalizeVip = (data) => {
  const identity = (data && data.identity) || {}
  const flags = [
    data && data.svip,
    identity.vip,
    identity.HugeVip,
    identity.huge_vip,
    identity.ExpVip,
    identity.exp_vip,
    identity.GroupVipFlag,
    identity.group_vip_flag,
    identity.CPLoverFlag,
    identity.cp_lover_flag,
  ]
  return {
    isVip: flags.some((value) => Number(value) > 0),
    vipLevel: Number(
      identity.level ||
        (data && data.userinfo && data.userinfo.music_level) ||
        0,
    ),
  }
}

/**
 * 读取账号昵称与头像
 * @param {{ uin: string, cookies: Record<string, string> }} session 登录会话
 * @returns {Promise<{ nick: string, headpic: string } | null>} 账号资料，读取失败时为 null
 */
const fetchProfile = async (session) => {
  try {
    const data = await qmRequest(
      'music.UserInfo.userInfoServer',
      'GetLoginUserInfo',
      {},
      { session },
    )
    const info = (data && data.info) || {}
    if (info.nick || info.nickname || info.name || info.logo) {
      return {
        nick: info.nick || info.nickname || info.name || '',
        headpic: info.logo || '',
      }
    }
  } catch (err) {
    logger.warn('GetLoginUserInfo 接口请求失败:', err && err.message)
  }
  return null
}

/**
 * 读取账号的会员播放权限
 * @param {{ uin: string, cookies: Record<string, string> }} session 登录会话
 * @returns {Promise<Record<string, any> | null>} 会员数据，读取失败时为 null
 */
const fetchVip = async (session) => {
  try {
    return await qmRequest(
      'VipLogin.VipLoginInter',
      'vip_login_base',
      {},
      { session },
    )
  } catch (err) {
    logger.warn('vip_login_base 接口请求失败:', err && err.message)
    return null
  }
}

module.exports = async (query = {}) => {
  const session = readSession(query)
  if (!session) return unauthorized('未登录 QQ 音乐账号')

  const cookies =
    typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : session.cookies || {}
  const uin = String(
    session.uin || cookies.qm_str_musicid || cookies.uin || cookies.wxuin || '',
  ).replace(/^o/, '')
  const hasKey = !!(
    cookies.qm_keyst ||
    cookies.qqmusic_key ||
    cookies.pskey ||
    cookies.p_skey ||
    cookies.skey
  )
  if (!uin || uin === '0' || !hasKey) {
    return unauthorized('未登录 QQ 音乐账号')
  }

  const authSession = { ...session, uin, cookies }

  try {
    const [profile, vipData] = await Promise.all([
      fetchProfile(authSession),
      fetchVip(authSession),
    ])
    if (!profile && !vipData) {
      return upstreamError('读取 QQ 音乐账号资料失败')
    }

    const vip = normalizeVip(vipData)
    return success({
      loggedIn: true,
      profile: {
        userId: uin,
        nickname: profile ? profile.nick : '',
        avatarUrl: profile
          ? profile.headpic.replace(/^http:\/\//, 'https://')
          : '',
        isVip: vip.isVip,
        vipLevel: vip.vipLevel,
      },
    })
  } catch (err) {
    logger.error('读取账号资料异常:', err && err.message)
    return upstreamError(`读取 QQ 音乐账号资料失败: ${err && err.message}`)
  }
}
