/**
 * 酷狗专辑详情
 *
 * 端点：
 * - 专辑详情：POST /kmr/v2/albums（x-router `openapi.kugou.com`，kg-tid 255）
 * - 专辑歌曲：POST /v1/album_audio/lite（x-router `openapi.kugou.com`，kg-tid 255）
 * - 兜底详情：GET http://mobilecdn.kugou.com/api/v3/album/info
 * - 兜底歌曲：GET http://mobilecdn.kugou.com/api/v3/album/song
 * - 名称转 ID：GET /v1/search/album（x-router `complexsearch.kugou.com`）
 *
 * 网关的专辑歌曲接口对当前客户端会返回 `error_code=20010`，因此歌曲列表
 * 统一走 mobilecdn 兜底；专辑元信息优先取网关，失败时回落到 mobilecdn。
 *
 * 专辑名只由专辑详情接口提供：网关为 `album_name`，mobilecdn 为
 * `albumname`；歌曲条目本身不带专辑名（只有 `album_id`），因此歌曲的
 * 专辑名统一取所属专辑详情。
 */

const { kgGatewayRequest, kgRequest, kgErrorCode } = require('../core/request')
const { readSession } = require('../core/session')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** HTML 实体表 */
const ENTITY_MAP = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#039;': "'",
}

/**
 * 反转义 HTML 实体
 * @param {any} text 原始文本
 * @returns {string} 清洗后的文本
 */
const decodeName = (text) => {
  if (!text) return ''
  return String(text).replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#039;/g,
    (entity) => ENTITY_MAP[entity] ?? entity,
  )
}

/**
 * 填充并安全化封面地址
 * @param {any} url 封面模板
 * @param {number} size 尺寸
 * @returns {string} 封面地址
 */
const fillCover = (url, size = 300) => {
  if (!url) return ''
  return String(url)
    .replace(/\{size\}/g, String(size))
    .replace(/^http:\/\//, 'https://')
}

/**
 * 从歌曲条目里取专辑名
 *
 * 各端点的专辑名字段并不统一：网关为 `album_info.album_name`，云歌单为
 * `albuminfo.name`，而 mobilecdn 的专辑歌曲条目完全不带专辑名（只有
 * `album_id`），此时要回落到专辑详情给出的专辑名。
 * @param {any} raw 原始歌曲条目
 * @returns {string} 专辑名，取不到时返回空串
 */
const pickAlbumName = (raw) => {
  const info = raw.albuminfo || raw.album_info || {}
  const candidate =
    raw.album_name || raw.albumname || info.name || info.album_name || ''
  return decodeName(candidate)
}

/**
 * 把音质 hash 与体积整理成对外结构
 * @param {any} raw 原始歌曲条目
 * @returns {{ qualities: string[], hashes: Record<string, string>, sizes: Record<string, number> }} 音质信息
 */
const collectQualities = (raw) => {
  const hashes = {}
  const sizes = {}

  const put = (quality, hash, size) => {
    if (!hash || !size) return
    hashes[quality] = hash
    sizes[quality] = size
  }

  put('128k', raw.hash_128 ?? raw.hash, raw.filesize_128 ?? raw.filesize)
  put(
    '320k',
    raw.hash_320 ?? raw['320hash'],
    raw.filesize_320 ?? raw['320filesize'],
  )
  put('flac', raw.hash_flac ?? raw.sqhash, raw.filesize_flac ?? raw.sqfilesize)
  put(
    'flac24bit',
    raw.hash_high ?? raw.hires_hash ?? raw.reshash,
    raw.filesize_high ?? raw.hires_filesize ?? raw.resfilesize,
  )

  return { qualities: Object.keys(hashes), hashes, sizes }
}

/**
 * 归一化 mobilecdn 专辑歌曲
 * @param {any} raw 原始歌曲条目
 * @param {string} fallbackCover 兜底封面模板
 * @param {string} fallbackAlbumName 兜底专辑名
 * @returns {any} 对外歌曲对象
 */
const normalizeMobileSong = (raw, fallbackCover, fallbackAlbumName) => {
  const trans = raw.trans_param || {}
  const coverTemplate = trans.union_cover || fallbackCover
  const interval = Number(raw.duration || 0)
  const qualities = collectQualities(raw)

  const filename = String(raw.filename || '')
  const artistName = decodeName(
    raw.singername || filename.split(' - ')[0] || '',
  )
  const songName = decodeName(
    raw.songname || filename.split(' - ').slice(1).join(' - '),
  )

  return {
    id: String(raw.audio_id || raw.hash || ''),
    audioId: Number(raw.audio_id || 0),
    albumAudioId: Number(raw.album_audio_id || 0),
    /** 歌曲主键（album_audio_id 口径），查评论、签播放地址都用它 */
    mixSongId: String(raw.album_audio_id || ''),
    hash: raw.hash || '',
    name: songName,
    artist: artistName,
    artists: artistName
      ? artistName.split(' / ').map((name) => ({ id: '', name }))
      : [],
    album: pickAlbumName(raw) || fallbackAlbumName,
    albumId: String(raw.album_id || ''),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    duration: interval * 1000,
    interval,
    qualities: qualities.qualities,
    hashes: qualities.hashes,
    sizes: qualities.sizes,
    pay: {
      payplay: Number(raw.pay_type || 0),
      privilege: Number(raw.privilege || 0),
      feetype: Number(raw.feetype || 0),
      pkgPrice: Number(raw.pkg_price || 0),
      price: Number(raw.price || 0),
    },
  }
}

/**
 * 归一化网关专辑歌曲
 * @param {any} raw 原始歌曲条目
 * @param {string} fallbackCover 兜底封面模板
 * @param {string} fallbackAlbumName 兜底专辑名
 * @returns {any} 对外歌曲对象
 */
const normalizeGatewaySong = (raw, fallbackCover, fallbackAlbumName) => {
  const base = raw.base || {}
  const audio = raw.audio_info || {}
  const albumInfo = raw.album_info || {}
  const trans = raw.trans_param || {}
  const deprecated = raw.deprecated || {}
  const authors = Array.isArray(raw.authors) ? raw.authors : []

  const coverTemplate = albumInfo.cover || trans.union_cover || fallbackCover
  const duration = Number(
    audio.duration_320 ||
      audio.duration_128 ||
      audio.duration_flac ||
      audio.duration ||
      0,
  )
  const qualities = collectQualities(audio)

  const artistName = decodeName(
    authors
      .map((author) => author.author_name)
      .filter(Boolean)
      .join(' / ') || base.author_name,
  )

  return {
    id: String(base.audio_id || audio.hash || ''),
    audioId: Number(base.audio_id || 0),
    albumAudioId: Number(base.album_audio_id || 0),
    /** 歌曲主键（album_audio_id 口径），查评论、签播放地址都用它 */
    mixSongId: String(base.album_audio_id || ''),
    hash: audio.hash_128 || audio.hash || '',
    name: decodeName(base.audio_name),
    artist: artistName,
    artists: authors.length
      ? authors.map((author) => ({
          id: author.author_id === undefined ? '' : String(author.author_id),
          name: decodeName(author.author_name),
        }))
      : [{ id: '', name: artistName }],
    album: pickAlbumName(raw) || fallbackAlbumName,
    albumId: String(base.album_id || ''),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    duration,
    interval: Math.round(duration / 1000),
    qualities: qualities.qualities,
    hashes: qualities.hashes,
    sizes: qualities.sizes,
    pay: {
      payplay: Number(deprecated.pay_type || 0),
      pkgPrice: Number(deprecated.pkg_price || 0),
      price: Number(deprecated.price || 0),
    },
  }
}

/**
 * 由专辑名反查专辑 ID
 * @param {string} idOrName 专辑 ID 或专辑名
 * @param {any} session 酷狗会话凭据
 * @returns {Promise<string>} 专辑 ID
 */
const resolveAlbumId = async (idOrName, session) => {
  if (/^[1-9]\d*$/.test(idOrName)) return idOrName

  try {
    const response = await kgGatewayRequest(
      '/v1/search/album',
      {},
      {
        method: 'GET',
        params: {
          keyword: idOrName,
          page: 1,
          pagesize: 1,
          platform: 'AndroidFilter',
          iscorrection: 1,
          nocollect: 0,
        },
        headers: { 'x-router': 'complexsearch.kugou.com' },
        session,
      },
    )

    const list = response.data.lists || response.data.info || []
    if (list[0] && list[0].albumid) return String(list[0].albumid)
  } catch (err) {
    logger.warn('专辑名转 ID 失败：', err.message || err)
  }
  return idOrName
}

/**
 * 读取专辑元信息
 * @param {string} albumId 专辑 ID
 * @param {any} session 酷狗会话凭据
 * @returns {Promise<{ detail: any, source: string }>} 专辑元信息与来源
 */
const loadAlbumDetail = async (albumId, session) => {
  try {
    const response = await kgGatewayRequest(
      '/kmr/v2/albums',
      {
        data: [{ album_id: albumId }],
        fields:
          'album_id,album_name,publish_date,sizable_cover,intro,language,authors,author_name,songcount',
      },
      {
        method: 'POST',
        headers: { 'x-router': 'openapi.kugou.com', 'kg-tid': '255' },
        session,
      },
    )

    const code = kgErrorCode(response)
    if (code !== 0) throw new Error(`error_code=${code}`)

    const detail = (response.data || [])[0] || {}
    if (detail.album_name) return { detail, source: 'gateway' }
  } catch (err) {
    logger.warn('读取专辑详情失败，回落 mobilecdn：', err.message || err)
  }

  const response = await kgRequest(
    `http://mobilecdn.kugou.com/api/v3/album/info?albumid=${encodeURIComponent(albumId)}&format=json`,
  )
  return { detail: response.data || {}, source: 'mobilecdn' }
}

/**
 * 读取专辑歌曲列表
 * @param {string} albumId 专辑 ID
 * @param {any} session 酷狗会话凭据
 * @returns {Promise<{ songs: any[], total: number, source: string }>} 歌曲条目与来源
 */
const loadAlbumSongs = async (albumId, session) => {
  try {
    const response = await kgGatewayRequest(
      '/v1/album_audio/lite',
      { album_id: albumId, page: 1, pagesize: 300 },
      {
        method: 'POST',
        headers: { 'x-router': 'openapi.kugou.com', 'kg-tid': '255' },
        session,
      },
    )

    const code = kgErrorCode(response)
    if (code !== 0) throw new Error(`error_code=${code}`)

    const raw = Array.isArray(response.data)
      ? response.data
      : response.data.songs || []
    if (raw.length > 0) {
      return {
        songs: raw,
        total: Number(response.total || response.data.total || raw.length),
        source: 'gateway',
      }
    }
  } catch (err) {
    logger.warn('读取专辑歌曲失败，回落 mobilecdn：', err.message || err)
  }

  const response = await kgRequest(
    `http://mobilecdn.kugou.com/api/v3/album/song?albumid=${encodeURIComponent(albumId)}&page=1&pagesize=300&format=json`,
  )
  const raw = (response.data && response.data.info) || []
  return {
    songs: raw,
    total: Number((response.data && response.data.total) || raw.length),
    source: 'mobilecdn',
  }
}

/**
 * 读取酷狗专辑详情
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const rawId = String(query.id || query.album_id || query.albumId || '').trim()
  if (!rawId) return badRequest('id 不能为空')

  const session = readSession(query)
  const albumId = await resolveAlbumId(rawId, session)

  let detail
  let detailSource
  let songs
  let songsSource
  let total

  try {
    const detailResult = await loadAlbumDetail(albumId, session)
    detail = detailResult.detail
    detailSource = detailResult.source

    const songsResult = await loadAlbumSongs(albumId, session)
    songs = songsResult.songs
    songsSource = songsResult.source
    total = songsResult.total
  } catch (err) {
    logger.warn('读取专辑失败：', err.message || err)
    return upstreamError(`读取专辑失败：${err.message || err}`)
  }

  // 详情与歌曲可能来自不同来源，各自按来源的结构归一化
  const detailIsGateway = detailSource === 'gateway'
  const songsAreGateway = songsSource === 'gateway'
  const coverTemplate = detailIsGateway ? detail.sizable_cover : detail.imgurl
  const authors = Array.isArray(detail.authors) ? detail.authors : []
  const artistName = detailIsGateway
    ? decodeName(
        detail.author_name ||
          authors
            .map((author) => author.author_name)
            .filter(Boolean)
            .join(' / '),
      )
    : decodeName(detail.singername)

  // 专辑名只有详情接口提供（歌曲条目不带），网关为 `album_name`，
  // mobilecdn 为 `albumname`
  const albumName = detailIsGateway
    ? decodeName(detail.album_name)
    : decodeName(detail.albumname)

  const normalized = songs.map((song) =>
    songsAreGateway
      ? normalizeGatewaySong(song, coverTemplate, albumName)
      : normalizeMobileSong(song, coverTemplate, albumName),
  )

  const name = albumName

  return success({
    code: 200,
    id: String(detail.album_id || detail.albumid || albumId),
    name,
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    artist: artistName,
    artists: detailIsGateway
      ? authors.map((author) => ({
          id: author.author_id === undefined ? '' : String(author.author_id),
          name: decodeName(author.author_name),
        }))
      : detail.singername
        ? [
            {
              id:
                detail.singerid === undefined
                  ? String(detail.singername)
                  : String(detail.singerid),
              name: decodeName(detail.singername),
            },
          ]
        : [],
    publishTime: detailIsGateway ? detail.publish_date : detail.publishtime,
    description: decodeName(detail.intro),
    language: decodeName(detail.language),
    total: Number(detail.songcount || total || normalized.length),
    songs: normalized,
    raw: {
      detail,
      songs,
      source: { detail: detailSource, songs: songsSource },
    },
  })
}
