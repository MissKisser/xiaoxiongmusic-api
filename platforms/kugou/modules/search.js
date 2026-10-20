/**
 * 酷狗多分类搜索
 *
 * 支持的分类：
 * - 0 / "song"：单曲（主走 mobilecdn，含封面与音质分级；失败兜底 songsearch）
 * - 8 / "album"：专辑（网关 /v1/search/album，带 Android 签名与 complexsearch 路由）
 * - 9 / "artist" / "author"：歌手（网关 /v1/search/author）
 * - 2 / "playlist" / "special"：歌单（网关 /v1/search/special）
 *
 * 公开读接口，不依赖登录态，免登录即可调用；调用方带了凭据时随请求透传给网关。
 *
 * @param {Record<string, any>} query 调用参数
 * @param {string} query.keywords 搜索关键词
 * @param {number} [query.page] 页码，从 1 开始
 * @param {number} [query.limit] 每页数量
 * @param {number | string} [query.type] 搜索分类
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */

const { kgGatewayRequest, kgRequest, kgErrorCode } = require('../core/request')
const { KG_MOBILECDN_URL, KG_SEARCH_URL } = require('../core/config')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 搜索网关的路由头 */
const SEARCH_ROUTER = 'complexsearch.kugou.com'

/** HTML 实体反转义映射 */
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
 * HTML 实体反转义并清洗
 * @param {string | null | undefined} str 原始字符串
 * @returns {string} 清洗后的字符串
 */
const decodeName = (str) => {
  if (!str) return ''
  return String(str).replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#039;/g,
    (s) => ENTITY_MAP[s] ?? s,
  )
}

/**
 * 把 http 链接升级为 https
 * @param {string | undefined} url 原始链接
 * @returns {string} 安全链接
 */
const secureUrl = (url) =>
  url ? String(url).replace(/^http:\/\//, 'https://') : ''

/**
 * 填充并安全化酷狗图片模板中的尺寸占位符
 * @param {string | undefined} url 封面模板
 * @param {number} [size] 尺寸
 * @returns {string} 封面链接，无封面时返回空串
 */
const fillCover = (url, size = 300) => {
  if (!url) return ''
  return secureUrl(String(url).replace(/\{size\}/g, String(size)))
}

/**
 * 格式化歌手数组
 * @param {Array<{ name?: string }> | undefined} singers 歌手列表
 * @param {string} [join] 连接符
 * @returns {string} 格式化后的歌手名
 */
const formatSingerName = (singers, join = ' / ') => {
  if (!Array.isArray(singers) || !singers.length) return ''
  return singers
    .map((s) => s.name)
    .filter(Boolean)
    .map(decodeName)
    .join(join)
}

/**
 * 格式化 mobilecdn 返回的歌手串
 * @param {string | undefined} name 原始歌手串
 * @returns {string} 格式化后的歌手名
 */
const formatMobileArtist = (name) => {
  if (!name) return ''
  return decodeName(name)
    .split(/、|,|;|\//)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' / ')
}

/**
 * 提取可选的调用凭据
 *
 * 搜索是公开读接口，没有凭据也能调用；调用方带了凭据时按上游行为透传给网关。
 * @param {Record<string, any>} query 调用参数
 * @returns {{ token: string, userid: string, dfid: string } | null} 凭据，没有时返回 null
 */
const optionalCredentials = (query) => {
  const session = query && query.session
  const source = session && typeof session === 'object' ? session : query || {}
  const token = String(source.token || (query && query.token) || '').trim()
  const userid = String(source.userid || (query && query.userid) || '').trim()
  const dfid = String(source.dfid || (query && query.dfid) || '').trim()
  if (!token && !userid && !dfid) return null
  return { token, userid, dfid }
}

/**
 * 把搜索分类归一成内部类型名
 * @param {number | string | undefined} type 分类
 * @returns {string | null} 内部类型名，非法分类返回 null
 */
const resolveType = (type) => {
  const key = String(
    type === undefined || type === null ? 0 : type,
  ).toLowerCase()
  if (key === '0' || key === 'song') return 'song'
  if (key === '8' || key === 'album') return 'album'
  if (key === '9' || key === 'artist' || key === 'author') return 'artist'
  if (key === '2' || key === 'playlist' || key === 'special') return 'playlist'
  return null
}

/**
 * 把 mobilecdn 歌曲条目映射为对外结构
 * @param {any} raw 酷狗歌曲条目
 * @returns {any} 对外歌曲对象
 */
const normalizeFromMobile = (raw) => {
  const sizes = {}
  const hashes = {}

  if (raw.filesize && raw.hash) {
    sizes['128k'] = raw.filesize
    hashes['128k'] = raw.hash
  }
  if (raw['320filesize'] && raw['320hash']) {
    sizes['320k'] = raw['320filesize']
    hashes['320k'] = raw['320hash']
  }
  if (raw.sqfilesize && raw.sqhash) {
    sizes.flac = raw.sqfilesize
    hashes.flac = raw.sqhash
  }
  const hrSize = raw.hires_filesize ?? raw.resfilesize
  const hrHash = raw.hires_hash ?? raw.reshash
  if (hrSize && hrHash) {
    sizes.flac24bit = hrSize
    hashes.flac24bit = hrHash
  }

  const interval = raw.duration ?? 0
  const coverTpl = raw.trans_param && raw.trans_param.union_cover
  const artistName = formatMobileArtist(raw.singername)
  const artists = artistName
    ? artistName.split(' / ').map((name) => ({ id: name, name }))
    : []

  return {
    id: String(raw.audio_id || raw.hash || ''),
    audioId: raw.audio_id ?? 0,
    albumAudioId: raw.album_audio_id,
    hash: raw.hash ?? '',
    name: decodeName(raw.songname || raw.filename || ''),
    artist: artistName,
    artists,
    album: decodeName(raw.album_name ?? ''),
    albumId: String(raw.album_id ?? ''),
    cover: fillCover(coverTpl, 300),
    coverOriginal: fillCover(coverTpl, 480),
    interval,
    duration: interval * 1000,
    qualities: Object.keys(hashes),
    hashes,
    sizes,
    pay: {
      payplay: raw.pay_type ?? 0,
      privilege: raw.privilege ?? 0,
      feetype: raw.feetype ?? 0,
      pkgPrice: raw.pkg_price ?? 0,
      price: raw.price ?? 0,
    },
  }
}

/**
 * 把兜底 songsearch 的歌曲条目映射为对外结构
 * @param {any} raw 酷狗歌曲条目
 * @returns {any} 对外歌曲对象
 */
const normalizeFromLegacy = (raw) => {
  const sizes = {}
  const hashes = {}

  if (raw.FileSize && raw.FileHash) {
    sizes['128k'] = raw.FileSize
    hashes['128k'] = raw.FileHash
  }
  if (raw.HQFileSize && raw.HQFileHash) {
    sizes['320k'] = raw.HQFileSize
    hashes['320k'] = raw.HQFileHash
  }
  if (raw.SQFileSize && raw.SQFileHash) {
    sizes.flac = raw.SQFileSize
    hashes.flac = raw.SQFileHash
  }
  if (raw.ResFileSize && raw.ResFileHash) {
    sizes.flac24bit = raw.ResFileSize
    hashes.flac24bit = raw.ResFileHash
  }

  const singers = Array.isArray(raw.Singers) ? raw.Singers : []
  const artistName = formatSingerName(singers)
  const artists = singers.length
    ? singers.map((s) => ({
        id: s.id !== undefined ? String(s.id) : s.name || undefined,
        name: decodeName(s.name || ''),
      }))
    : artistName
      ? [{ id: artistName, name: artistName }]
      : []

  return {
    id: String(raw.Audioid || raw.FileHash || ''),
    audioId: raw.Audioid,
    albumAudioId: raw.MixSongID ?? raw.AlbumAudioId,
    hash: raw.FileHash || '',
    name: decodeName(raw.SongName || ''),
    artist: artistName,
    artists,
    album: decodeName(raw.AlbumName ?? ''),
    albumId: String(raw.AlbumID ?? ''),
    cover: '',
    coverOriginal: '',
    interval: raw.Duration ?? 0,
    duration: (raw.Duration ?? 0) * 1000,
    qualities: Object.keys(hashes),
    hashes,
    sizes,
    pay: {
      payplay: raw.PayType ?? 0,
      privilege: raw.Privilege ?? 0,
      pkgPrice: raw.PkgPrice ?? 0,
      price: raw.Price ?? 0,
    },
  }
}

/**
 * 走 mobilecdn 搜索歌曲
 * @param {string} keywords 关键词
 * @param {number} page 页码
 * @param {number} limit 每页数量
 * @returns {Promise<{ total: number, songs: any[], raw: any }>} 歌曲、总数与上游原始响应
 */
const searchSongsMobile = async (keywords, page, limit) => {
  const url =
    `${KG_MOBILECDN_URL}?keyword=${encodeURIComponent(keywords)}` +
    `&page=${page}&pagesize=${limit}&format=json&showtype=1`

  const body = await kgRequest(url)
  const raw = (body && body.data && body.data.info) || []

  const songs = []
  const seen = new Set()
  const push = (item) => {
    const key = `${item.audio_id ?? ''}_${item.hash ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    songs.push(normalizeFromMobile(item))
  }
  for (const item of Array.isArray(raw) ? raw : []) {
    push(item)
    for (const sub of item.group || []) push(sub)
  }

  return {
    total: Number((body && body.data && body.data.total) || songs.length),
    songs,
    raw: body,
  }
}

/**
 * 走兜底 songsearch 搜索歌曲
 * @param {string} keywords 关键词
 * @param {number} page 页码
 * @param {number} limit 每页数量
 * @returns {Promise<{ total: number, songs: any[], raw: any }>} 歌曲、总数与上游原始响应
 */
const searchSongsLegacy = async (keywords, page, limit) => {
  const url =
    `${KG_SEARCH_URL}?keyword=${encodeURIComponent(keywords)}` +
    `&page=${page}&pagesize=${limit}` +
    `&userid=0&clientver=&platform=WebFilter&filter=2&iscorrection=1&privilege_filter=0&area_code=1`

  const body = await kgRequest(url)
  const raw = (body && body.data && body.data.lists) || []

  const songs = []
  const seen = new Set()
  const push = (item) => {
    const key = `${item.Audioid}_${item.FileHash}`
    if (seen.has(key)) return
    seen.add(key)
    songs.push(normalizeFromLegacy(item))
  }
  for (const item of Array.isArray(raw) ? raw : []) {
    push(item)
    for (const sub of item.Grp || []) push(sub)
  }

  return {
    total: Number((body && body.data && body.data.total) || songs.length),
    songs,
    raw: body,
  }
}

/**
 * 搜索歌曲，mobilecdn 失败时回落到 songsearch
 * @param {string} keywords 关键词
 * @param {number} page 页码
 * @param {number} limit 每页数量
 * @returns {Promise<{ total: number, songs: any[], raw: any }>} 歌曲、总数与上游原始响应
 */
const searchSongs = async (keywords, page, limit) => {
  try {
    const result = await searchSongsMobile(keywords, page, limit)
    if (result.songs.length > 0) return result
  } catch {
    // 落到兜底通道
  }
  return searchSongsLegacy(keywords, page, limit)
}

/**
 * 发出搜索网关请求
 * @param {string} path 网关相对路径
 * @param {Record<string, any>} params 查询参数
 * @param {{ token: string, userid: string, dfid: string } | null} session 可选凭据
 * @returns {Promise<any>} 网关响应体
 */
const searchGateway = async (path, params, session) =>
  kgGatewayRequest(
    path,
    {},
    {
      method: 'GET',
      params,
      headers: { 'x-router': SEARCH_ROUTER },
      session: session || undefined,
    },
  )

/**
 * 从网关搜索响应里取出条目列表
 * @param {any} res 网关响应体
 * @returns {any[]} 条目列表
 */
const pickList = (res) => {
  const data = (res && res.data) || {}
  if (Array.isArray(data.lists)) return data.lists
  if (Array.isArray(data.info)) return data.info
  return []
}

/**
 * 搜索专辑
 * @param {string} keywords 关键词
 * @param {number} page 页码
 * @param {number} limit 每页数量
 * @param {{ token: string, userid: string, dfid: string } | null} session 可选凭据
 * @returns {Promise<{ total: number, albums: any[], raw: any }>} 专辑与总数
 */
const searchAlbums = async (keywords, page, limit, session) => {
  const res = await searchGateway(
    '/v1/search/album',
    {
      keyword: keywords,
      page,
      pagesize: limit,
      platform: 'AndroidFilter',
      iscorrection: 1,
      albumhide: 0,
      nocollect: 0,
    },
    session,
  )

  const albums = pickList(res).map((raw) => {
    const singerStr =
      raw.singer ||
      (raw.singers
        ? raw.singers
            .map((s) => s.name)
            .filter(Boolean)
            .join(' / ')
        : '')
    const artistId = raw.singerid || (raw.singerids && raw.singerids[0])
    return {
      id: String(raw.albumid ?? ''),
      name: decodeName(raw.albumname),
      cover: fillCover(raw.img, 300),
      artist: decodeName(singerStr),
      artistId: artistId !== undefined ? String(artistId) : undefined,
      trackCount: raw.songcount ?? 0,
      publishTime: raw.publish_time || undefined,
      intro: raw.intro || undefined,
    }
  })

  const data = (res && res.data) || {}
  return {
    total: Number(data.total ?? albums.length),
    albums,
    raw: res,
  }
}

/**
 * 搜索歌手
 * @param {string} keywords 关键词
 * @param {number} page 页码
 * @param {number} limit 每页数量
 * @param {{ token: string, userid: string, dfid: string } | null} session 可选凭据
 * @returns {Promise<{ total: number, artists: any[], raw: any }>} 歌手与总数
 */
const searchArtists = async (keywords, page, limit, session) => {
  const res = await searchGateway(
    '/v1/search/author',
    {
      keyword: keywords,
      page,
      pagesize: limit,
      platform: 'AndroidFilter',
      iscorrection: 1,
    },
    session,
  )

  const artists = pickList(res).map((raw) => ({
    id: String(raw.AuthorId ?? ''),
    name: decodeName(raw.AuthorName),
    cover: fillCover(raw.Avatar || raw.FirstFrameImage, 300),
    albumCount: raw.AlbumCount ?? 0,
    songCount: raw.AudioCount ?? 0,
    fansCount: raw.FansNum ?? 0,
  }))

  const data = (res && res.data) || {}
  return {
    total: Number(data.total ?? artists.length),
    artists,
    raw: res,
  }
}

/**
 * 搜索歌单
 * @param {string} keywords 关键词
 * @param {number} page 页码
 * @param {number} limit 每页数量
 * @param {{ token: string, userid: string, dfid: string } | null} session 可选凭据
 * @returns {Promise<{ total: number, playlists: any[], raw: any }>} 歌单与总数
 */
const searchPlaylists = async (keywords, page, limit, session) => {
  const res = await searchGateway(
    '/v1/search/special',
    {
      keyword: keywords,
      page,
      pagesize: limit,
      platform: 'AndroidFilter',
      iscorrection: 1,
    },
    session,
  )

  const playlists = pickList(res).map((raw) => ({
    id: String(raw.specialid || raw.gid || ''),
    name: decodeName(raw.specialname),
    cover: fillCover(raw.img, 300),
    creator: decodeName(raw.nickname),
    trackCount: raw.song_count ?? 0,
    playCount: Number(raw.play_count || raw.total_play_count || 0),
  }))

  const data = (res && res.data) || {}
  return {
    total: Number(data.total ?? playlists.length),
    playlists,
    raw: res,
  }
}

/**
 * 搜索酷狗
 * @param {Record<string, any>} [query] 调用参数
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const keywords = String(query.keywords || query.keyword || '').trim()
  if (!keywords) return badRequest('keywords 不能为空')

  const type = resolveType(query.type)
  if (!type) {
    return badRequest(`不支持的酷狗搜索分类：${query.type}`)
  }

  const page = Math.max(1, Number(query.page || 1) || 1)
  const limit = Math.max(1, Number(query.limit || 30) || 30)
  const session = optionalCredentials(query)

  try {
    if (type === 'song') {
      const result = await searchSongs(keywords, page, limit)
      return success({
        code: 200,
        type,
        page,
        limit,
        total: result.total,
        songs: result.songs,
        items: result.songs,
        raw: result.raw,
      })
    }

    if (type === 'album') {
      const result = await searchAlbums(keywords, page, limit, session)
      if (kgErrorCode(result.raw) !== 0) {
        return upstreamError(
          `酷狗专辑搜索失败：error_code=${kgErrorCode(result.raw)}`,
          { raw: result.raw },
        )
      }
      return success({
        code: 200,
        type,
        page,
        limit,
        total: result.total,
        albums: result.albums,
        items: result.albums,
        raw: result.raw,
      })
    }

    if (type === 'artist') {
      const result = await searchArtists(keywords, page, limit, session)
      if (kgErrorCode(result.raw) !== 0) {
        return upstreamError(
          `酷狗歌手搜索失败：error_code=${kgErrorCode(result.raw)}`,
          { raw: result.raw },
        )
      }
      return success({
        code: 200,
        type,
        page,
        limit,
        total: result.total,
        artists: result.artists,
        items: result.artists,
        raw: result.raw,
      })
    }

    const result = await searchPlaylists(keywords, page, limit, session)
    if (kgErrorCode(result.raw) !== 0) {
      return upstreamError(
        `酷狗歌单搜索失败：error_code=${kgErrorCode(result.raw)}`,
        { raw: result.raw },
      )
    }
    return success({
      code: 200,
      type,
      page,
      limit,
      total: result.total,
      playlists: result.playlists,
      items: result.playlists,
      raw: result.raw,
    })
  } catch (err) {
    logger.warn('酷狗搜索失败：', err.message || err)
    return upstreamError(`酷狗搜索失败：${err.message || err}`)
  }
}
