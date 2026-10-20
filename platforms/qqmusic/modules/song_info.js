/**
 * QQ 音乐单曲详情
 *
 * 走 `music.pf_song_detail_svr` / `get_song_detail_yqq`，
 * 按 songmid 查询单曲的完整信息（含文件规格与付费标记）。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 去掉搜索结果的命中高亮标签
 * @param {any} text 原始文本
 * @returns {string} 处理后的文本
 */
const stripHighlight = (text) =>
  typeof text === 'string' ? text.replace(/<\/?em>/g, '') : ''

/**
 * 拼接歌手名
 * @param {any} singers 歌手数组
 * @returns {string} 形如 `A / B` 的歌手名
 */
const formatSingerName = (singers) => {
  if (!Array.isArray(singers)) return ''
  return singers
    .map((item) => stripHighlight(item && item.name))
    .filter(Boolean)
    .join(' / ')
}

/**
 * 归一化单曲
 * @param {any} track 接口返回的曲目信息
 * @returns {Record<string, any>} 归一化后的单曲
 */
const normalizeTrack = (track) => {
  const source = track || {}
  const album = source.album || {}
  const file = source.file || {}
  return {
    id: String(source.id ?? ''),
    mid: source.mid ?? '',
    name: stripHighlight(source.title || source.name || ''),
    artist: formatSingerName(source.singer),
    artists: (Array.isArray(source.singer) ? source.singer : []).map(
      (item) => ({
        id: String((item && item.id) ?? ''),
        mid: (item && item.mid) ?? '',
        name: stripHighlight((item && item.name) ?? ''),
      }),
    ),
    album: stripHighlight(album.name ?? ''),
    albumMid: album.mid ?? '',
    albumId: String(album.id ?? ''),
    duration: (source.interval ?? 0) * 1000,
    publishTime: album.time_public ?? source.time_public ?? '',
    mediaMid: file.media_mid ?? '',
    cover: album.mid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${album.mid}.jpg`
      : '',
    file,
    pay: source.pay ?? {},
  }
}

module.exports = async (query = {}) => {
  const mid = String(query.mid ?? query.songmid ?? '').trim()
  if (!mid) return badRequest('mid required')

  const session = readSession(query)

  try {
    const data =
      (await qmRequest(
        'music.pf_song_detail_svr',
        'get_song_detail_yqq',
        { song_type: 0, song_mid: mid },
        { session },
      )) || {}

    const track = data.track_info
    if (!track) {
      return {
        status: 404,
        body: { code: 404, message: 'song not found' },
        cookie: [],
      }
    }

    return success({
      song: normalizeTrack(track),
      raw: data,
    })
  } catch (err) {
    logger.error('QQ 音乐单曲详情获取异常:', err && err.message)
    return upstreamError(`QQ 音乐单曲详情获取失败: ${err && err.message}`)
  }
}
