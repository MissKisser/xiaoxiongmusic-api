/**
 * 酷狗歌手详情
 *
 * 端点：
 * - 歌手详情：POST /kmr/v3/author（x-router `openapi.kugou.com`，kg-tid 36）
 * - 歌手单曲：POST /kmr/v1/audio_group/author（x-router `openapi.kugou.com`，kg-tid 220）
 * - 歌手专辑：POST /kmr/v1/author/albums（x-router `openapi.kugou.com`，kg-tid 36）
 * - 名称转 ID：GET /v1/search/author（x-router `complexsearch.kugou.com`）
 *
 * 单曲接口的 `key` 由 `signParamsKey(clienttime)` 签出，客户端标识随
 * 概念版 / 标准版切换而变化。
 */

const { kgGatewayRequest, kgErrorCode } = require('../core/request')
const { readSession } = require('../core/session')
const { signParamsKey } = require('../core/crypto')
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
 * 填充并安全化头像地址
 * @param {any} url 头像模板
 * @param {number} size 尺寸
 * @returns {string} 头像地址
 */
const fillCover = (url, size = 300) => {
  if (!url) return ''
  return String(url)
    .replace(/\{size\}/g, String(size))
    .replace(/^http:\/\//, 'https://')
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
  put('320k', raw.hash_320, raw.filesize_320)
  put('flac', raw.hash_flac, raw.filesize_flac)
  put('flac24bit', raw.hash_high, raw.filesize_high)

  return { qualities: Object.keys(hashes), hashes, sizes }
}

/**
 * 归一化歌手单曲
 * @param {any} raw 原始歌曲条目
 * @param {string} artistId 当前歌手 ID
 * @param {string} defaultCover 兜底封面模板
 * @returns {any} 对外歌曲对象
 */
const normalizeArtistSong = (raw, artistId, defaultCover) => {
  const trans = raw.trans_param || {}
  const coverTemplate = trans.union_cover || defaultCover
  const duration = Number(
    raw.timelength_320 ||
      raw.timelength_flac ||
      raw.timelength_128 ||
      raw.timelength_high ||
      raw.timelength ||
      raw.duration_320 ||
      raw.duration_128 ||
      raw.duration_flac ||
      raw.duration ||
      0,
  )
  const qualities = collectQualities(raw)
  const authors = Array.isArray(raw.authors) ? raw.authors : []

  const artistName = decodeName(
    authors
      .map((author) => author.author_name)
      .filter(Boolean)
      .join(' / ') || raw.author_name,
  )

  return {
    id: String(raw.audio_id || raw.hash || ''),
    audioId: Number(raw.audio_id || 0),
    albumAudioId: Number(raw.album_audio_id || 0),
    hash: raw.hash_128 || raw.hash || '',
    name: decodeName(raw.audio_name),
    artist: artistName,
    artistId,
    artists: authors.length
      ? authors.map((author) => ({
          id:
            author.author_id === undefined
              ? artistId
              : String(author.author_id),
          name: decodeName(author.author_name),
        }))
      : [{ id: artistId, name: artistName }],
    album: decodeName(raw.album_name),
    albumId: String(raw.album_id || ''),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    duration,
    interval: Math.round(duration / 1000),
    qualities: qualities.qualities,
    hashes: qualities.hashes,
    sizes: qualities.sizes,
    pay: {
      payplay: Number(raw.pay_type || 0),
      privilege: Number(raw.privilege || 0),
      pkgPrice: Number(raw.pkg_price || 0),
      price: Number(raw.price || 0),
    },
  }
}

/**
 * 归一化歌手专辑
 * @param {any} raw 原始专辑条目
 * @param {string} artistId 当前歌手 ID
 * @param {string} artistName 歌手名
 * @returns {any} 对外专辑对象
 */
const normalizeArtistAlbum = (raw, artistId, artistName) => ({
  id: String(raw.album_id || ''),
  name: decodeName(raw.album_name),
  cover: fillCover(raw.sizable_cover, 300),
  coverOriginal: fillCover(raw.sizable_cover, 480),
  artist: decodeName(raw.author_name || artistName),
  artistId,
  trackCount: Number(raw.song_count || 0),
  publishTime: raw.publish_date || '',
  description: decodeName(raw.intro),
  type: raw.type || '',
  language: raw.language || '',
})

/**
 * 由歌手名反查歌手 ID
 * @param {string} idOrName 歌手 ID 或歌手名
 * @param {any} session 酷狗会话凭据
 * @returns {Promise<string>} 歌手 ID
 */
const resolveAuthorId = async (idOrName, session) => {
  if (/^\d+$/.test(idOrName)) return idOrName

  try {
    const response = await kgGatewayRequest(
      '/v1/search/author',
      {},
      {
        method: 'GET',
        params: {
          keyword: idOrName,
          page: 1,
          pagesize: 1,
          platform: 'AndroidFilter',
          iscorrection: 1,
        },
        headers: { 'x-router': 'complexsearch.kugou.com' },
        session,
      },
    )

    const list = response.data.lists || response.data.info || []
    if (list[0] && list[0].AuthorId) return String(list[0].AuthorId)
  } catch (err) {
    logger.warn('歌手名转 ID 失败：', err.message || err)
  }
  return idOrName
}

/**
 * 读取酷狗歌手详情
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const rawId = String(
    query.id || query.author_id || query.artist_id || '',
  ).trim()
  if (!rawId) return badRequest('id 不能为空')

  const session = readSession(query)
  const artistId = await resolveAuthorId(rawId, session)
  const clienttime = Math.floor(Date.now() / 1000)

  let detail
  let rawSongs
  let rawAlbums
  let songTotal
  let albumTotal

  try {
    const detailResponse = await kgGatewayRequest(
      '/kmr/v3/author',
      { author_id: artistId },
      {
        method: 'POST',
        headers: { 'x-router': 'openapi.kugou.com', 'kg-tid': '36' },
        session,
      },
    )
    const detailCode = kgErrorCode(detailResponse)
    if (detailCode !== 0) throw new Error(`error_code=${detailCode}`)
    detail = detailResponse.data || {}

    const songsResponse = await kgGatewayRequest(
      '/kmr/v1/audio_group/author',
      {
        author_id: artistId,
        pagesize: 50,
        page: 1,
        sort: 1,
        area_code: 'all',
        clienttime,
        key: signParamsKey(clienttime),
      },
      {
        method: 'POST',
        baseURL: 'https://openapi.kugou.com',
        headers: { 'x-router': 'openapi.kugou.com', 'kg-tid': '220' },
        session,
      },
    )
    const songsCode = kgErrorCode(songsResponse)
    if (songsCode !== 0) throw new Error(`error_code=${songsCode}`)
    rawSongs = songsResponse.data || []
    songTotal = Number(songsResponse.total || rawSongs.length)

    const albumsResponse = await kgGatewayRequest(
      '/kmr/v1/author/albums',
      {
        author_id: artistId,
        pagesize: 50,
        page: 1,
        sort: 3,
        category: 1,
        area_code: 'all',
      },
      {
        method: 'POST',
        headers: { 'x-router': 'openapi.kugou.com', 'kg-tid': '36' },
        session,
      },
    )
    const albumsCode = kgErrorCode(albumsResponse)
    if (albumsCode !== 0) throw new Error(`error_code=${albumsCode}`)
    rawAlbums = albumsResponse.data || []
    albumTotal = Number(albumsResponse.total || rawAlbums.length)
  } catch (err) {
    logger.warn('读取歌手失败：', err.message || err)
    return upstreamError(`读取歌手失败：${err.message || err}`)
  }

  const name = decodeName(detail.author_name || rawId)
  const avatar = fillCover(detail.sizable_avatar, 300)
  const intro = decodeName(
    detail.intro ||
      (Array.isArray(detail.long_intro)
        ? detail.long_intro
            .map((item) => item.content)
            .filter(Boolean)
            .join('\n\n')
        : ''),
  )

  return success({
    code: 200,
    artist: {
      id: String(detail.author_id || artistId),
      name,
      cover: avatar,
      avatar: fillCover(detail.sizable_avatar, 480),
      songCount: songTotal,
      albumCount: Number(detail.album_count || albumTotal),
      mvCount: Number(detail.mv_count || 0),
      fansCount: Number(detail.fansnums || 0),
      birthday: detail.birthday || '',
      intro,
    },
    songs: rawSongs.map((song) => normalizeArtistSong(song, artistId)),
    albums: rawAlbums.map((album) =>
      normalizeArtistAlbum(album, artistId, name),
    ),
    raw: { detail, songs: rawSongs, albums: rawAlbums },
  })
}
