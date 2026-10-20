/**
 * 酷狗播放地址解析
 *
 * `modules/song_url.js` 的私有辅助：把「音质档位 → 授权 → 直链」这条链路
 * 拆成可复用的两步，由模块层组装成统一响应。
 *
 * 链路形态：
 * - 单次请求：免费歌曲（或该档位本账号本就可播）用原始 hash 直接请求
 *   `GET /v5/url` 取直链。
 * - 两段式：VIP 高音质先由 `POST /v2/get_res_privilege/lite` 取得该档位的
 *   变体 hash（授权），再用变体 hash 请求 `GET /v5/url` 取直链。
 *
 * 本模块不持有任何跨请求状态：凭据一律由调用方传入。
 */

const { kgGatewayRequest } = require('./request')
const { getDeviceMid, signKey } = require('./crypto')
const { getKgAppid, getKgClientver, isConceptMode } = require('./config')

/** 音质档位，由低到高 */
const QUALITY_LEVELS = ['128', '320', 'flac', 'high']

/** 外部音质名 → 酷狗音质档位 */
const QUALITY_MAP = {
  'hi-res': 'high',
  lossless: 'flac',
  hq: '320',
  sq: '128',
  lq: '128',
}

/**
 * 取出响应里的播放直链
 * @param {any} response 酷狗网关响应
 * @returns {string[]} 直链列表，没有直链时返回空数组
 */
const extractUrls = (response) => {
  if (!response || typeof response !== 'object') return []

  return [response.url, response.backup_url, response.backupUrl]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => typeof value === 'string' && value.length > 0)
}

/**
 * 读取账号在各音质档位可用的变体 hash
 *
 * 变体 hash 与歌曲原始 hash 不同，是酷狗用来区分音质档位的凭据。
 * @param {{ token: string, userid: string }} session 酷狗会话凭据
 * @param {string} hash 歌曲 hash
 * @param {number} albumId 专辑 ID
 * @returns {Promise<Map<string, string>>} 音质档位 → 变体 hash 的映射
 */
const fetchLiteQualityOptions = async (session, hash, albumId) => {
  const response = await kgGatewayRequest(
    '/v2/get_res_privilege/lite',
    {
      appid: getKgAppid(),
      clientver: getKgClientver(),
      area_code: 1,
      behavior: 'play',
      need_hash_offset: 1,
      relate: 1,
      support_verify: 1,
      resource: [{ type: 'audio', page_id: 0, hash, album_id: albumId }],
      qualities: QUALITY_LEVELS,
    },
    {
      method: 'POST',
      headers: { 'x-router': 'media.store.kugou.com' },
      session,
    },
  )

  const options = new Map()
  for (const item of response.data || []) {
    for (const variant of [item, ...(item.relate_goods || [])]) {
      const quality = variant.quality
      if (!variant.hash || variant.level === 0) continue
      if (
        !quality ||
        !QUALITY_LEVELS.includes(quality) ||
        options.has(quality)
      ) {
        continue
      }
      options.set(quality, variant.hash)
    }
  }
  return options
}

/**
 * 请求单档音质的直链
 *
 * 概念版与标准版的页面来源标识不同，必须与当前客户端标识保持一致，
 * 否则网关会以「illegal key」拒绝。
 * @param {{ token: string, userid: string }} session 酷狗会话凭据
 * @param {{ hash: string, quality: string, albumId?: number, audioId?: number, freePart?: boolean }} options 请求参数
 * @returns {Promise<any>} 酷狗网关响应
 */
const requestTrackUrl = async (session, options) => {
  const { hash, quality, albumId = 0, audioId = 0, freePart = false } = options
  const concept = isConceptMode()

  const params = {
    area_code: 1,
    hash,
    ssa_flag: 'is_fromtrack',
    version: 11430,
    page_id: concept ? 967177915 : 151369488,
    quality,
    behavior: 'play',
    pid: concept ? 411 : 2,
    cmd: 26,
    pidversion: 3001,
    IsFreePart: freePart ? 1 : 0,
    ppage_id: concept
      ? '356753938,823673182,967485191'
      : '463467626,350369493,788954147',
    cdnBackup: 1,
    module: '',
    clientver: 11430,
    key: signKey(hash, getDeviceMid(), Number(session.userid || 0)),
  }

  if (Number(albumId) > 0) params.album_id = Number(albumId)
  if (Number(audioId) > 0) params.album_audio_id = Number(audioId)

  return kgGatewayRequest(
    '/v5/url',
    {},
    {
      method: 'GET',
      params,
      headers: { 'x-router': 'trackercdn.kugou.com' },
      session,
    },
  )
}

/**
 * 判断响应里是否带可播放的直链
 * @param {any} response 酷狗网关响应
 * @returns {string[]} 直链列表
 */
const playableUrls = (response) => {
  const urls = extractUrls(response)
  if (urls.length === 0) return []
  if (response.extName === 'mp4') return []
  return urls
}

/**
 * 解析歌曲的播放地址
 *
 * 按「偏好音质 → 逐档降级」的顺序尝试；VIP 档位先用授权接口换取变体 hash。
 * @param {{ token: string, userid: string }} session 酷狗会话凭据
 * @param {{ hash: string, albumId?: number, audioId?: number, level?: string, freePart?: boolean }} options 解析参数
 * @returns {Promise<{ ok: boolean, url: string, urls: string[], quality: string, requestedQuality: string, usedPrivilege: boolean, response: any }>} 解析结果
 */
const resolveSongUrl = async (session, options) => {
  const {
    hash,
    albumId = 0,
    audioId = 0,
    level = 'hq',
    freePart = false,
  } = options

  const requestedQuality = QUALITY_MAP[String(level).toLowerCase()] || '320'
  const chain = QUALITY_LEVELS.slice(
    0,
    QUALITY_LEVELS.indexOf(requestedQuality) + 1,
  ).reverse()

  let candidates = chain.map((quality) => ({ quality, hash }))
  let usedPrivilege = false

  if (isConceptMode() && session.token) {
    try {
      const variants = await fetchLiteQualityOptions(session, hash, albumId)
      const privileged = chain
        .map((quality) => ({ quality, variantHash: variants.get(quality) }))
        .filter((item) => Boolean(item.variantHash))
        .map((item) => ({ quality: item.quality, hash: item.variantHash }))
      if (privileged.length > 0) {
        candidates = privileged
        usedPrivilege = true
      }
    } catch {
      // 授权探测失败时退回原始 hash，不影响免费歌曲直连
    }
  }

  let lastResponse = {}
  for (const candidate of candidates) {
    const request = {
      hash: candidate.hash,
      quality: candidate.quality,
      albumId,
      audioId,
      freePart,
    }

    let response = await requestTrackUrl(session, request)
    let urls = playableUrls(response)

    if (urls.length === 0 && Number(audioId) > 0) {
      // album_audio_id 不匹配时酷狗会返回「Hash not found」，去掉该字段重试
      const retry = await requestTrackUrl(session, { ...request, audioId: 0 })
      const retryUrls = playableUrls(retry)
      if (retryUrls.length > 0) {
        response = retry
        urls = retryUrls
      }
    }

    lastResponse = response
    if (urls.length > 0) {
      return {
        ok: true,
        url: urls[0],
        urls,
        quality: candidate.quality,
        requestedQuality,
        usedPrivilege,
        response,
      }
    }
  }

  return {
    ok: false,
    url: '',
    urls: [],
    quality: requestedQuality,
    requestedQuality,
    usedPrivilege,
    response: lastResponse,
  }
}

module.exports = {
  QUALITY_LEVELS,
  QUALITY_MAP,
  extractUrls,
  fetchLiteQualityOptions,
  requestTrackUrl,
  resolveSongUrl,
}
