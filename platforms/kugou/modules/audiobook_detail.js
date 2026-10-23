/**
 * 酷狗听书专辑详情与章节列表
 *
 * 听书专辑与普通音乐专辑共用同一套 ID 体系，本模块直接取
 * mobilecdn 的专辑接口：
 * - 专辑元信息：`GET /api/v3/album/info`
 * - 章节列表：`GET /api/v3/album/song`
 *
 * 专辑标识支持两种写法：数字专辑 ID，以及听书官网页面路径里用的
 * base36 别名（`e_album_id`），后者由 `core/audiobook.js` 反解。
 *
 * 章节即专辑曲目，章节音频用条目里的 `hash` 走普通歌曲的播放链路
 * （见 `audiobook_track_url`）。
 */

const {
  KG_AUDIOBOOK_CATEGORY,
  normalizeAlbumId,
  fetchAudiobookDetail,
  fetchAudiobookTracks,
  normalizeAlbum,
  normalizeTrack,
} = require('../core/audiobook')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 每页最大章节数 */
const MAX_LIMIT = 100

/**
 * 读取酷狗听书专辑详情与章节
 *
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @param {string} [query.id] 专辑 ID（数字专辑 ID 或官网 base36 别名）
 * @param {number} [query.page] 章节页码，从 1 开始
 * @param {number} [query.limit] 每页章节数
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const rawId = String(query.id || query.albumId || query.album_id || '').trim()
  if (!rawId) return badRequest('id 不能为空')

  const albumId = normalizeAlbumId(rawId)
  if (!albumId) return badRequest(`无法解析的酷狗听书专辑标识：${rawId}`)

  const page = Math.max(1, Number(query.page || 1) || 1)
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(query.limit || query.pagesize || 30) || 30),
  )

  try {
    const { detail } = await fetchAudiobookDetail(albumId)
    if (!detail.albumname) {
      return upstreamError(`酷狗听书专辑不存在：${albumId}`)
    }

    const tracks = await fetchAudiobookTracks(albumId, page, limit)
    const offset = (page - 1) * limit
    const chapters = tracks.list.map((item, index) =>
      normalizeTrack(item, offset + index + 1),
    )

    const album = normalizeAlbum({
      ...detail,
      albumid: detail.albumid ?? albumId,
      category: detail.category ?? KG_AUDIOBOOK_CATEGORY,
    })

    return success({
      code: 200,
      id: String(detail.albumid ?? albumId),
      albumId,
      name: album.name,
      cover: album.cover,
      coverOriginal: album.coverOriginal,
      speaker: album.speaker,
      speakers: album.speakers,
      intro: album.intro,
      publishTime: album.publishTime,
      playCount: Number(detail.play_count ?? 0),
      category: album.category,
      privilege: album.privilege,
      total: tracks.total,
      page,
      limit,
      hasMore: page * limit < tracks.total,
      chapters,
      items: chapters,
      raw: {
        detail,
        tracks: tracks.list,
      },
    })
  } catch (err) {
    logger.warn('读取酷狗听书专辑详情失败：', err.message || err)
    return upstreamError(`读取酷狗听书专辑详情失败：${err.message || err}`)
  }
}
