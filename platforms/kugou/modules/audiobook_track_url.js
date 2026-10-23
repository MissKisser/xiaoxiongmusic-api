/**
 * 酷狗听书章节播放地址
 *
 * 听书章节的音频就是普通歌曲音频：章节条目自带 `hash`，
 * 因此播放链路直接复用 `core/song_url.js` 的协议 A（`GET /v5/url`），
 * 不另造请求层。
 *
 * 章节的 `album_id` 与 `album_audio_id` 随请求带上，网关据此定位资源；
 * `album_audio_id` 不匹配时 `core/song_url.js` 会自动去掉该字段重试。
 *
 * 听书内容多为会员专享，签名里的 `key` 需要账号参与，
 * 因此本接口要求登录。
 */

const { readSession } = require('../core/session')
const { resolveSongUrl } = require('../core/song_url')
const {
  success,
  failure,
  badRequest,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/**
 * 读取酷狗听书章节播放地址
 *
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @param {string} [query.hash] 章节 hash（也可用 `id` 传入）
 * @param {number} [query.albumId] 所属专辑 ID
 * @param {number} [query.albumAudioId] 章节在专辑内的曲目 ID
 * @param {string} [query.level] 首选音质，默认 hq
 * @param {boolean} [query.freePart] 是否只请求试听片段
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const hash = String(query.hash || query.id || '')
    .trim()
    .toLowerCase()
  if (!hash) return badRequest('hash 不能为空')

  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('需要登录')
  }

  const albumId = Number(query.albumId || query.album_id || 0)
  const albumAudioId = Number(
    query.albumAudioId || query.album_audio_id || query.audioId || 0,
  )
  const level = String(query.level || query.quality || 'hq')
  const freePart = Boolean(query.freePart || query.free_part)

  let result
  try {
    result = await resolveSongUrl(session, {
      hash,
      albumId,
      audioId: albumAudioId,
      level,
      freePart,
    })
  } catch (err) {
    logger.warn('解析酷狗听书章节播放地址失败：', err.message || err)
    return upstreamError(`解析酷狗听书章节播放地址失败：${err.message || err}`)
  }

  const raw = result.response || {}
  const common = {
    hash,
    albumId: albumId || undefined,
    albumAudioId: albumAudioId || undefined,
    status: result.status,
    privilege: result.privilege,
    privilegeUsed: result.usedPrivilege,
    playable: result.ok,
    quality: result.quality,
    requestedQuality: result.requestedQuality,
    downgraded: result.quality !== result.requestedQuality,
    url: result.url,
    urls: result.urls,
    size: Number(raw.fileSize ?? raw.size ?? 0),
    bitrate: Number(raw.bitRate ?? raw.bitrate ?? 0),
    duration: Number(raw.timeLength ?? raw.timelength ?? 0),
    extName: String(raw.extName ?? ''),
    hash_offset: result.hashOffset,
  }

  if (!result.ok) {
    const reason =
      result.status === 3
        ? '该账号对该章节完全无授权'
        : '无可用播放地址（该章节可能为会员专享）'
    return failure(403, {
      code: 403,
      message: reason,
      ...common,
      url: '',
      urls: [],
    })
  }

  return success({
    code: 200,
    message: '',
    ...common,
  })
}
