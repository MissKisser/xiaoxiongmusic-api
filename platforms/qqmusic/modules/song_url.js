/**
 * QQ 音乐：单曲播放地址
 *
 * 走 vkey 协议解析直链，一次请求带上所有候选音质档位的文件名，
 * 按「首选档位 → 更低档位」的顺序取第一个命中的即为最高可用音质。
 *
 * 两个必须注意的点：
 * - vkey 的文件名前缀后面跟的是歌曲详情里的**媒体 mid**（`file.media_mid`），
 *   多数歌曲它与歌曲 mid 不同，取错就拿不到直链，因此先查一次歌曲详情。
 * - 付费 / VIP 歌曲对无权限账号一律返回空直链，此时返回 403 与明确原因。
 *
 * 返回体用 `available` 表达「有没有可播地址」，
 * `level` / `label` 表达音质档位，`isFallback` 表达是否降级。
 */

const { qmRequest } = require('../core/request')
const { requestSongUrl } = require('../core/song_url')
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
 * 从歌曲详情响应中取出歌曲主体
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

/**
 * 解析歌曲的 mid 与媒体 mid
 * @param {string} value 歌曲 mid 或数字歌曲 ID
 * @param {{ uin: string, cookies: Record<string, string> } | null} session 登录凭据
 * @returns {Promise<{ mid: string, mediaMid: string }>} 歌曲标识
 */
const resolveSong = async (value, session) => {
  const text = String(value).trim()
  const isNumeric = /^\d+$/.test(text) && text.length <= 15

  const detail = await qmRequest(
    'music.pf_song_detail_svr',
    'get_song_detail_yqq',
    isNumeric
      ? { song_num: 1, song_id: Number(text) }
      : { song_type: 0, song_mid: text },
    { session: session || null },
  )

  const track = pickTrack(detail)
  if (!track) return { mid: text, mediaMid: '' }

  return {
    mid: track.mid || text,
    mediaMid: (track.file && track.file.media_mid) || '',
  }
}

module.exports = async (query = {}) => {
  const raw = String(query.mid ?? query.song_mid ?? query.id ?? '').trim()
  if (!raw) return badRequest('mid required')

  const session = readSession(query)
  if (!session) return unauthorized('需要登录')

  const cookies =
    typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : session.cookies || {}
  const uin = String(
    session.uin || cookies.qm_str_musicid || cookies.uin || cookies.wxuin || '',
  ).replace(/^o/, '')
  if (!uin || uin === '0') return unauthorized('需要登录')

  const level = String(query.level ?? query.quality ?? 'hq')
  const givenMediaMid = String(query.mediaMid ?? query.media_mid ?? '').trim()

  try {
    let songMid = raw
    let mediaMid = givenMediaMid

    if (!mediaMid || /^\d+$/.test(raw)) {
      const resolved = await resolveSong(raw, session)
      songMid = resolved.mid || raw
      mediaMid = mediaMid || resolved.mediaMid
    }

    const result = await requestSongUrl({
      mid: songMid,
      mediaMid,
      level,
      uin,
      cookies,
    })

    if (!result.ok) {
      return failure(403, {
        code: 403,
        message: '无法获取播放链接，可能需要 VIP 或无版权',
        mid: songMid,
        available: false,
        reason: result.reason,
        triedLevels: result.triedLevels || [],
        raw: result.raw,
      })
    }

    return success({
      mid: songMid,
      available: true,
      url: result.url,
      level: result.level,
      label: result.label,
      format: result.format,
      isFallback: result.isFallback,
      triedLevels: result.triedLevels || [],
      raw: result.raw,
    })
  } catch (err) {
    logger.error('解析播放地址异常:', err && err.message)
    return upstreamError(`解析播放地址失败: ${err && err.message}`)
  }
}
