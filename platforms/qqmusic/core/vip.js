/**
 * QQ 音乐会员状态归一
 *
 * 只做纯数据整理，不发请求、不持有状态。
 */

/**
 * 会员响应中的身份字段
 * @typedef {object} QQMusicVipIdentity
 * @property {number} [vip] 会员标识
 * @property {number} [HugeVip] 豪华会员标识
 * @property {number} [huge_vip] 豪华会员标识
 * @property {number} [ExpVip] 体验会员标识
 * @property {number} [exp_vip] 体验会员标识
 * @property {number} [GroupVipFlag] 组合会员标识
 * @property {number} [group_vip_flag] 组合会员标识
 * @property {number} [CPLoverFlag] 情侣会员标识
 * @property {number} [cp_lover_flag] 情侣会员标识
 * @property {number} [level] 会员等级
 */

/**
 * 会员响应体
 * @typedef {object} QQMusicVipData
 * @property {number} [svip] 高级会员标识
 * @property {QQMusicVipIdentity} [identity] 身份字段
 * @property {{ music_level?: number }} [userinfo] 用户信息字段
 */

/**
 * 将会员响应归一为播放权限状态
 * @param {QQMusicVipData | null | undefined} data vip_login_base 响应
 * @returns {{ isVip: boolean, vipLevel: number }} 是否具有会员播放权限及会员等级
 */
const normalizeQQMusicVip = (data) => {
  const identity = data && data.identity
  const flags = [
    data && data.svip,
    identity && identity.vip,
    identity && identity.HugeVip,
    identity && identity.huge_vip,
    identity && identity.ExpVip,
    identity && identity.exp_vip,
    identity && identity.GroupVipFlag,
    identity && identity.group_vip_flag,
    identity && identity.CPLoverFlag,
    identity && identity.cp_lover_flag,
  ]

  return {
    isVip: flags.some((value) => Number(value) > 0),
    vipLevel: Number(
      (identity && identity.level) ||
        (data && data.userinfo && data.userinfo.music_level) ||
        0,
    ),
  }
}

module.exports = {
  normalizeQQMusicVip,
}
