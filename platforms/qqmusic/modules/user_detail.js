/**
 * QQ 音乐：账号资料
 *
 * 读取当前登录账号的昵称、头像与会员播放权限。
 * 凭据全部来自调用参数，接口层不持有任何会话。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const { isQQMusicAuthExpired } = require('../core/auth')
const {
  success,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 生成 Set-Cookie 响应头数组
 * @param {Record<string, string>} cookies cookie 键值对
 * @returns {string[]} Set-Cookie 字符串数组
 */
const toSetCookieArray = (cookies) =>
  Object.entries(cookies || {})
    .filter(([, value]) => !!value)
    .map(([key, value]) => `${key}=${value}; Path=/`)

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
 *
 * 鉴权失效必须上抛：只有它代表凭据已死；
 * 网络异常不代表登录态变化，仍按「无资料」处理，避免误登出。
 * @param {{ uin: string, cookies: Record<string, string> }} session 登录会话
 * @param {Record<string, any>} [options] 透传给请求层的选项
 * @returns {Promise<{ nick: string, headpic: string } | null>} 账号资料，读取失败时为 null
 */
const fetchProfile = async (session, options = {}) => {
  try {
    const data = await qmRequest(
      'music.UserInfo.userInfoServer',
      'GetLoginUserInfo',
      {},
      { session, ...options },
    )
    const info = (data && data.info) || {}
    if (info.nick || info.nickname || info.name || info.logo) {
      return {
        nick: info.nick || info.nickname || info.name || '',
        headpic: info.logo || '',
      }
    }
  } catch (err) {
    if (isQQMusicAuthExpired(err)) throw err
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

  // 凭据失效时续期一次并重放；续期结果只返回给调用方，接口层不落库。
  // refresh_key 是一次性的，因此同一批请求里只让资料请求具备续期能力。
  let refreshedSession = null
  const refreshOptions = {
    autoRefresh: true,
    onRefreshed: (next) => {
      refreshedSession = next
    },
  }

  try {
    const [profile, vipData] = await Promise.all([
      fetchProfile(authSession, refreshOptions),
      fetchVip(authSession),
    ])
    if (!profile && !vipData) {
      return upstreamError('读取 QQ 音乐账号资料失败')
    }

    const vip = normalizeVip(vipData)
    const body = {
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
    }

    // 续期成功：新凭据随响应回传给调用方，由调用方决定如何落库
    if (refreshedSession) {
      body.cookie = refreshedSession.cookies
      return success(body, {
        cookie: toSetCookieArray(refreshedSession.cookies),
      })
    }

    return success(body)
  } catch (err) {
    // 鉴权失效且续期失败：明确回报未登录，由调用方重新登录
    if (isQQMusicAuthExpired(err)) {
      logger.warn('QQ 音乐凭据已失效:', err && err.message)
      return unauthorized('QQ 音乐登录已过期，请重新登录')
    }
    logger.error('读取账号资料异常:', err && err.message)
    return upstreamError(`读取 QQ 音乐账号资料失败: ${err && err.message}`)
  }
}
