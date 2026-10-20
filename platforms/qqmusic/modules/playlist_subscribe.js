/**
 * QQ 音乐：收藏 / 取消收藏歌单
 *
 * 写完读回 `IsPlaylistFan`，确认收藏状态与预期一致才返回成功。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  failure,
  unauthorized,
  badRequest,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 写入类接口要求的 Referer
 *
 * QQ 音乐对写接口校验来源：`https://y.qq.com`（无尾斜杠）会被判为非法来源，
 * 写接口统一返回 inner=1000 / authorize fail；带尾斜杠的 `https://y.qq.com/` 才能写入。
 */
const WRITE_REFERER = 'https://y.qq.com/'

/**
 * 把接口返回的标识字段解析为正整数
 * @param {unknown} value 原始值
 * @returns {number | undefined} 合法正整数，非法时返回 undefined
 */
const positiveInt = (value) => {
  const num =
    typeof value === 'string' && /^\d{1,15}$/.test(value)
      ? Number(value)
      : value
  return typeof num === 'number' && Number.isSafeInteger(num) && num > 0
    ? num
    : undefined
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

  const tid = positiveInt(query.tid)
  const subscribed = query.subscribed
  if (!tid) return badRequest('tid required')
  if (typeof subscribed !== 'boolean') {
    return badRequest('subscribed 必须是布尔值')
  }

  try {
    const data = await qmRequest(
      'music.musicasset.PlaylistFavWrite',
      subscribed ? 'FavPlaylist' : 'CancelFavPlaylist',
      { uin, v_playlistId: [tid] },
      { session: authSession, referer: WRITE_REFERER },
    )

    if (
      !data ||
      data.result !== 0 ||
      (data.v_failedPlaylistId || []).length > 0
    ) {
      logger.warn('收藏状态写入失败:', data && data.result)
      return upstreamError('收藏状态写入失败', { result: data && data.result })
    }

    // 读回确认：收藏状态应与预期一致
    const status = await qmRequest(
      'music.musicasset.PlaylistFavRead',
      'IsPlaylistFan',
      { uin, v_tid: [tid] },
      { session: authSession, referer: WRITE_REFERER },
    )
    const actual = Boolean(status && status.m_fan && status.m_fan[String(tid)])
    if (actual !== subscribed) {
      return failure(502, {
        code: 502,
        message: `收藏状态读回校验失败：当前为 ${actual ? '已收藏' : '未收藏'}`,
        tid,
        subscribed,
      })
    }

    return success({ tid, subscribed, verified: true })
  } catch (err) {
    logger.error('收藏状态写入异常:', err && err.message)
    return upstreamError(`收藏状态写入失败: ${err && err.message}`)
  }
}
