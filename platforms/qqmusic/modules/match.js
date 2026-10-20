/**
 * QQ 音乐听歌识曲取词
 *
 * 组合 `search` 与 `lyric`：先按关键词搜歌，取第一条命中再取它的歌词。
 * 建议关键词用「歌曲名-歌手名」格式。
 *
 * 两个子模块都是无状态的纯函数式模块，直接组合调用不会引入跨请求状态。
 */

const searchModule = require('./search')
const lyricModule = require('./lyric')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

module.exports = async (query = {}) => {
  const keywords = String(query.keywords ?? query.keyword ?? '').trim()
  if (!keywords) return badRequest('keywords required')

  try {
    const searched = await searchModule({
      ...query,
      keywords,
      type: 0,
      page: 1,
      limit: 1,
    })

    if (searched.status !== 200) return searched

    const song =
      (searched.body && searched.body.songs && searched.body.songs[0]) || null
    if (!song) {
      return {
        status: 404,
        body: { code: 404, message: '未找到匹配的歌曲' },
        cookie: [],
      }
    }

    const lyricData = await lyricModule({
      ...query,
      id: song.id,
      name: song.name,
      artist: song.artist,
      album: song.album,
      duration: Math.floor((song.duration || 0) / 1000),
    })

    if (lyricData.status !== 200) return lyricData

    const body = lyricData.body || {}

    return success({
      keywords,
      song,
      lrc: body.lrc ?? '',
      qrc: body.qrc ?? '',
      trans: body.trans ?? '',
      roma: body.roma ?? '',
      format: body.format ?? 'lrc',
      lines: body.lines ?? [],
      hasLyric: Boolean(body.hasLyric),
      raw: { song, lyric: body.raw },
    })
  } catch (err) {
    logger.error('QQ 音乐听歌识曲取词异常:', err && err.message)
    return upstreamError(`QQ 音乐听歌识曲取词失败: ${err && err.message}`)
  }
}
