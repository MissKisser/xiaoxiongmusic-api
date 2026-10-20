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
 * 返回体里的可播性判据直接取自官方响应，播放决策树按它们分流：
 * - `status`：`1` 可播 / `2` 付费墙 / `3` 该账号完全无授权
 * - `hash_offset`：付费墙时给出试听边界，`end_ms` 即试听时长
 * - `privilege`：资源授权位
 * - `trial`：试听请求（`IsFreePart=1`）的结果，含试听直链
 *
 * 试听直链的时长陷阱：试听文件的时长由 `hash_offset.end_ms` 给出，
 * 响应里的 `timeLength` 报的是整首时长，不可直接当片段长度用。
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
 * 收敛播放地址响应时需要剔除的播放凭证
 *
 * 直链本身由 `url` / `urls` 单独给出，播放票据类字段不再重复外泄。
 * @type {string[]}
 */
const RAW_EXCLUDED_FIELDS = [
  'url',
  'backupUrl',
  'backup_url',
  'hash_token',
  'hash_token_query',
  'q',
]

/**
 * 收敛播放地址响应，只保留判据与元信息
 * @param {any} response 上游原始响应
 * @returns {Record<string, any>} 收敛后的响应
 */
const sanitizeRaw = (response) => {
  if (!response || typeof response !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(response)) {
    if (RAW_EXCLUDED_FIELDS.includes(key)) continue
    out[key] = value
  }
  return out
}

/**
 * 把一次解析结果整理成对外的播放信息
 * @param {{ url: string, urls: string[], quality: string, response: any }} result 解析结果
 * @returns {{ url: string, urls: string[], quality: string, size: number, bitrate: number, duration: number, extName: string }} 播放信息
 */
const toPlaybackInfo = (result) => {
  const raw = result.response || {}
  return {
    url: result.url,
    urls: result.urls,
    quality: result.quality,
    size: Number(raw.fileSize ?? raw.size ?? 0),
    bitrate: Number(raw.bitRate ?? raw.bitrate ?? 0),
    duration: Number(raw.timeLength ?? raw.timelength ?? 0),
    extName: String(raw.extName ?? ''),
  }
}

/**
 * 读取酷狗播放地址
 *
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @param {string} [query.hash] 歌曲 hash（也可用 `id` 传入）
 * @param {number} [query.albumId] 专辑 ID
 * @param {number} [query.albumAudioId] 专辑音频 ID
 * @param {string} [query.level] 首选音质，默认 hq
 * @param {boolean} [query.freePart] 是否只请求试听片段
 * @param {number} [query.privilege] 调用方已知的资源授权位，取不到官方授权位时兜底
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
  const givenPrivilege =
    query.privilege === undefined || query.privilege === null
      ? null
      : Number(query.privilege) || 0

  let dfid = session.dfid
  if (!dfid) {
    try {
      dfid = await ensureKugouDfid(session)
    } catch (err) {
      logger.warn('注册酷狗设备指纹失败，按匿名设备继续：', err.message || err)
    }
  }
  const requestSession = { ...session, dfid: dfid || '' }

  const request = {
    hash,
    albumId,
    audioId,
    level,
  }

  let primary
  let probe = null
  try {
    primary = await resolveSongUrl(requestSession, {
      ...request,
      freePart,
    })

    // 正式请求拿不到直链时再探一次试听：付费墙歌曲由官方下发试听片段
    if (!freePart && !primary.ok) {
      probe = await resolveSongUrl(requestSession, {
        ...request,
        freePart: true,
      })
    }
  } catch (err) {
    logger.warn('解析酷狗播放地址失败：', err.message || err)
    return upstreamError(`解析酷狗播放地址失败：${err.message || err}`)
  }

  // 显式要求试听时主请求就是试听请求；否则试听结果来自额外的探测请求
  const trialSource = freePart ? primary : probe
  const trialPlayable = freePart ? primary.ok : Boolean(probe && probe.ok)

  const privilege = primary.privilege ?? givenPrivilege
  const playback = toPlaybackInfo(primary)
  const trialPlayback = trialSource ? toPlaybackInfo(trialSource) : null

  const trial = {
    requested: Boolean(trialSource),
    status: trialSource ? trialSource.status : 0,
    hash_offset: trialSource ? trialSource.hashOffset : null,
    privilege: trialSource ? (trialSource.privilege ?? privilege) : privilege,
    playable: trialPlayable,
    url: trialSource ? trialSource.url : '',
    urls: trialSource ? trialSource.urls : [],
    duration: Number((trialSource && trialSource.hashOffset?.end_ms) || 0),
    size: trialPlayback ? trialPlayback.size : 0,
    bitrate: trialPlayback ? trialPlayback.bitrate : 0,
    extName: trialPlayback ? trialPlayback.extName : '',
  }

  const playable = primary.ok || trialPlayable
  // 直链来自试听请求：显式试听，或正式请求无直链时回落到试听直链
  const isTrial = freePart || (!primary.ok && trialPlayable)

  // 主请求拿不到直链时，播放信息整体回落到试听请求的结果
  const effective = primary.ok ? playback : trialPlayback || playback
  const effectiveUrl = primary.ok
    ? primary.url
    : trialSource
      ? trialSource.url
      : ''
  const effectiveUrls = primary.ok
    ? primary.urls
    : trialSource
      ? trialSource.urls
      : []
  const effectiveQuality = primary.ok
    ? primary.quality
    : trialSource
      ? trialSource.quality
      : primary.quality

  const common = {
    hash,
    requestMode: freePart ? 'trial' : 'normal',
    status: primary.status,
    hash_offset: primary.hashOffset,
    privilege,
    playable,
    isTrial,
    freePart: isTrial,
    url: effectiveUrl,
    urls: effectiveUrls,
    quality: effectiveQuality,
    requestedQuality: primary.requestedQuality,
    downgraded: primary.quality !== primary.requestedQuality,
    size: effective.size,
    bitrate: effective.bitrate,
    duration: effective.duration,
    extName: effective.extName,
    usedPrivilege: primary.usedPrivilege,
    trial,
    raw: sanitizeRaw(primary.response),
  }

  if (!playable) {
    const reason =
      primary.status === 3
        ? '该账号对该资源完全无授权'
        : '无可用播放地址（可能需要会员或该歌曲不可播放）'
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
