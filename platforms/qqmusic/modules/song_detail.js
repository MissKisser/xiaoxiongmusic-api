/**
 * QQ 音乐：歌曲详情
 *
 * 支持用 mid 或数字 id 查询：
 * - 传 `mid` 时按 `song_mid` 检索
 * - 传 `id` 时按 `song_id` 检索（加歌接口需要数字 id）
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  badRequest,
  failure,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

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

/**
 * 从响应中取出歌曲主体
 * @param {Record<string, any>} data 接口返回的数据段
 * @returns {Record<string, any> | null} 歌曲主体
 */
const pickTrack = (data) => {
  if (!data) return null
  if (data.track_info) return data.track_info
  if (data.song_info) return data.song_info
  if (Array.isArray(data.songs) && data.songs[0]) return data.songs[0]
  if (data.songid || data.mid) return data
  return null
}

module.exports = async (query = {}) => {
  const mid = String(query.mid ?? query.song_mid ?? '').trim()
  const songId = positiveInt(query.id ?? query.song_id)
  if (!mid && !songId) return badRequest('mid 或 id required')

  const session = readSession(query)
  const cookies =
    session && typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : (session && session.cookies) || {}
  const uin = String(
    (session && session.uin) ||
      cookies.qm_str_musicid ||
      cookies.uin ||
      cookies.wxuin ||
      '',
  ).replace(/^o/, '')
  const authSession = session ? { ...session, uin, cookies } : null

  const param = mid
    ? { song_type: 0, song_mid: mid }
    : { song_num: 1, song_id: songId }

  try {
    const data = await qmRequest(
      'music.pf_song_detail_svr',
      'get_song_detail_yqq',
      param,
      { session: authSession },
    )

    const track = pickTrack(data)
    if (!track || (!track.id && !track.mid)) {
      return failure(404, { code: 404, message: '歌曲不存在' })
    }

    return success({
      id: track.id ?? songId ?? 0,
      mid: track.mid ?? mid,
      name: track.name ?? track.title ?? '',
      artist: (track.singer ?? [])
        .map((item) => item.name ?? '')
        .filter(Boolean)
        .join(' / '),
      album: (track.album && track.album.name) || track.album || '',
      duration: (track.interval ?? 0) * 1000,
    })
  } catch (err) {
    logger.error('读取歌曲详情异常:', err && err.message)
    return upstreamError(`读取歌曲详情失败: ${err && err.message}`)
  }
}
