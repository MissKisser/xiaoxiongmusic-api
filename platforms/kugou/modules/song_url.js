/**
 * 酷狗播放地址
 *
 * 端点：
 * - 播放权限（VIP 授权）：POST /v2/get_res_privilege/lite（x-router `media.store.kugou.com`）
 * - 播放直链：GET /v5/url（x-router `trackercdn.kugou.com`）
 *
 * 签名链路见 `core/song_url.js`：免费歌曲单次请求即可取到直链，VIP 高音质
 * 先用权限接口换取变体 hash 再取直链（两段式）。请求参数里的 `key` 由
 * `signKey(hash, mid, userid)` 签出，账号 ID 参与签名，因此必须带凭据。
 *
 * 本模块不持有任何跨请求状态：凭据与设备指纹都由调用参数决定。
 */

const { readSession } = require('../core/session')
const { ensureKugouDfid } = require('../core/device')
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
 * 读取酷狗播放地址
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
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
  const audioId = Number(
    query.albumAudioId ||
      query.album_audio_id ||
      query.audioId ||
      query.audio_id ||
      0,
  )
  const level = String(query.level || query.quality || 'hq')
  const freePart = Boolean(query.freePart || query.free_part)

  let dfid = session.dfid
  if (!dfid) {
    try {
      dfid = await ensureKugouDfid(session)
    } catch (err) {
      logger.warn('注册酷狗设备指纹失败，按匿名设备继续：', err.message || err)
    }
  }
  const requestSession = { ...session, dfid: dfid || '' }

  let result
  try {
    result = await resolveSongUrl(requestSession, {
      hash,
      albumId,
      audioId,
      level,
      freePart,
    })
  } catch (err) {
    logger.warn('解析酷狗播放地址失败：', err.message || err)
    return upstreamError(`解析酷狗播放地址失败：${err.message || err}`)
  }

  if (!result.ok) {
    const raw = result.response || {}
    const reason = String(raw.error || raw.errmsg || raw.msg || '')
    return failure(403, {
      code: 403,
      message: reason || '无可用播放地址（可能需要会员或该歌曲不可播放）',
      hash,
      quality: result.quality,
      requestedQuality: result.requestedQuality,
      downgraded: result.quality !== result.requestedQuality,
      playable: false,
      url: '',
      urls: [],
      freePart,
      usedPrivilege: result.usedPrivilege,
      raw,
    })
  }

  const raw = result.response || {}
  return success({
    code: 200,
    hash,
    quality: result.quality,
    requestedQuality: result.requestedQuality,
    downgraded: result.quality !== result.requestedQuality,
    playable: true,
    url: result.url,
    urls: result.urls,
    size: Number(raw.size || 0),
    bitrate: Number(raw.bitrate || 0),
    duration: Number(raw.timeLength || raw.timelength || 0),
    extName: raw.extName || '',
    freePart,
    usedPrivilege: result.usedPrivilege,
    message: '',
    raw,
  })
}
