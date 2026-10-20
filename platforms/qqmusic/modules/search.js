/**
 * QQ 音乐搜索
 *
 * 走移动端搜索接口 `music.search.SearchCgiService` / `DoSearchForQQMusicMobile`，
 * 一次调用按 `type` 切换搜索对象：
 * - 0 歌曲
 * - 8 专辑
 * - 9 歌手
 * - 2 歌单
 *
 * 搜索是公开只读能力，匿名即可调用；调用方带了凭据时也会带上，便于拿到更完整的结果。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 搜索对象 → 接口 search_type
 * @type {Record<string, number>}
 */
const SEARCH_TYPE_BY_TARGET = {
  song: 0,
  album: 2,
  artist: 1,
  playlist: 3,
}

/**
 * 对外类型码 → 搜索对象
 * @type {Record<string, string>}
 */
const TARGET_BY_TYPE = {
  0: 'song',
  8: 'album',
  9: 'artist',
  2: 'playlist',
}

/**
 * 把 http 链接换成 https
 * @param {any} url 原始链接
 * @returns {string} 处理后的链接
 */
const secureUrl = (url) =>
  typeof url === 'string' ? url.replace(/^http:/, 'https:') : ''

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
 * 生成移动端搜索所需的会话 ID
 *
 * 该值参与服务端分页，必须每次请求都不同。
 * @returns {string} 十进制字符串形式的会话 ID
 */
const createSearchId = () => {
  const group = BigInt(Math.floor(Math.random() * 20) + 1)
  const random = BigInt(Math.floor(Math.random() * 4194305))
  const todayMs = BigInt(Date.now() % 86400000)
  return (
    group * 18014398509481984n +
    random * 4294967296n +
    todayMs
  ).toString()
}

/**
 * 归一化歌手条目
 * @param {any} singer 接口返回的歌手
 * @returns {Record<string, any>} 归一化后的歌手
 */
const normalizeArtist = (singer) => ({
  id: String((singer && singer.id) ?? ''),
  mid: (singer && singer.mid) ?? '',
  name: stripHighlight((singer && singer.name) ?? ''),
})

/**
 * 归一化搜索到的歌曲
 * @param {any} song 接口返回的歌曲
 * @returns {Record<string, any>} 归一化后的歌曲
 */
const normalizeSong = (song) => {
  const source = song || {}
  const album = source.album || {}
  const file = source.file || {}
  const pay = source.pay || {}
  const pictureMid = album.mid || album.pmid || ''

  return {
    id: String(source.id ?? ''),
    mid: source.mid ?? '',
    name: stripHighlight(source.title ?? source.name ?? ''),
    artist: formatSingerName(source.singer),
    artists: (Array.isArray(source.singer) ? source.singer : []).map(
      normalizeArtist,
    ),
    album: stripHighlight(album.name || album.title || ''),
    albumMid: album.mid ?? '',
    albumId: String(album.id ?? ''),
    duration: (source.interval ?? 0) * 1000,
    mediaMid: file.media_mid ?? '',
    cover: pictureMid
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pictureMid}.jpg`
      : '',
    coverOriginal: pictureMid
      ? `https://y.gtimg.cn/music/photo_new/T002R800x800M000${pictureMid}.jpg`
      : '',
    pay: {
      payalbum: pay.pay_month === 0 && (pay.price_album ?? 0) > 0 ? 1 : 0,
      payplay: pay.pay_play ?? 0,
    },
    size128: file.size_128mp3 ?? 0,
    size320: file.size_320mp3 ?? 0,
    sizeApe: file.size_ape ?? 0,
    sizeFlac: file.size_flac ?? 0,
    sizeOgg: file.size_192ogg ?? 0,
    sizeHiRes: Array.isArray(file.size_new) ? (file.size_new[0] ?? 0) : 0,
    hiResSampleRate: file.hires_sample ?? 0,
    hiResBitDepth: file.hires_bitdepth ?? 0,
  }
}

/**
 * 归一化搜索到的专辑
 * @param {any} album 接口返回的专辑
 * @returns {Record<string, any>} 归一化后的专辑
 */
const normalizeAlbum = (album) => {
  const source = album || {}
  const singerList = Array.isArray(source.singer_list) ? source.singer_list : []
  const artist =
    typeof source.singer === 'string'
      ? stripHighlight(source.singer)
      : formatSingerName(singerList)

  return {
    id: source.albummid ?? String(source.id ?? ''),
    albumId: String(source.id ?? ''),
    name: stripHighlight(source.name ?? ''),
    cover: secureUrl(source.pic),
    artist,
    artistMid: singerList[0]?.mid ?? '',
    trackCount: source.song_num ?? 0,
  }
}

/**
 * 归一化搜索到的歌手
 * @param {any} artist 接口返回的歌手
 * @returns {Record<string, any>} 归一化后的歌手
 */
const normalizeSinger = (artist) => {
  const source = artist || {}
  return {
    id: source.singerMID ?? String(source.singerID ?? ''),
    name: stripHighlight(source.singerName ?? ''),
    cover: secureUrl(source.singerPic || source.iconurl),
    albumCount: source.albumNum ?? 0,
    songCount: source.songNum ?? 0,
  }
}

/**
 * 归一化搜索到的歌单
 * @param {any} playlist 接口返回的歌单
 * @returns {Record<string, any>} 归一化后的歌单
 */
const normalizePlaylist = (playlist) => {
  const source = playlist || {}
  return {
    id: source.dissid ?? '',
    name: stripHighlight(source.dissname),
    cover: secureUrl(source.logo || source.layer_url),
    creator: stripHighlight(source.nickname ?? ''),
    trackCount: source.songnum ?? 0,
    playCount: source.listennum ?? 0,
  }
}

/**
 * 执行一次搜索
 * @param {string} keywords 搜索关键词
 * @param {number} page 页码，从 1 开始
 * @param {number} limit 每页条数
 * @param {string} target 搜索对象：song / album / artist / playlist
 * @param {any} session 调用方凭据，缺省时匿名访问
 * @returns {Promise<any>} 接口返回的业务数据段
 */
const searchTarget = async (keywords, page, limit, target, session) =>
  qmRequest(
    'music.search.SearchCgiService',
    'DoSearchForQQMusicMobile',
    {
      searchid: createSearchId(),
      query: keywords,
      page_num: page,
      num_per_page: limit,
      search_type: SEARCH_TYPE_BY_TARGET[target],
      highlight: true,
      grp: 1,
      selectors: {},
      vec_selectors: [],
    },
    { session },
  )

module.exports = async (query = {}) => {
  const keywords = String(query.keywords ?? query.s ?? '').trim()
  if (!keywords) return badRequest('keywords required')

  const rawType = query.type ?? 0
  let target = TARGET_BY_TYPE[String(rawType)]
  if (!target && typeof rawType === 'string') {
    target = SEARCH_TYPE_BY_TARGET[rawType] === undefined ? undefined : rawType
  }
  if (!target) {
    return badRequest(
      `unsupported search type: ${rawType}（可用：0 歌曲 / 8 专辑 / 9 歌手 / 2 歌单）`,
    )
  }

  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.max(1, Number(query.limit) || 30)
  const session = readSession(query)

  try {
    const data = await searchTarget(keywords, page, limit, target, session)
    const body = (data && data.body) || {}
    const total = (data && data.meta && data.meta.sum) ?? 0

    const songs = []
    const albums = []
    const artists = []
    const playlists = []

    if (target === 'song') {
      for (const item of body.item_song || []) songs.push(normalizeSong(item))
    } else if (target === 'album') {
      for (const item of body.item_album || [])
        albums.push(normalizeAlbum(item))
    } else if (target === 'artist') {
      for (const item of body.singer || []) artists.push(normalizeSinger(item))
    } else {
      for (const item of body.item_songlist || [])
        playlists.push(normalizePlaylist(item))
    }

    const count =
      songs.length || albums.length || artists.length || playlists.length || 0

    return success({
      keywords,
      type: target,
      page,
      limit,
      total: total || count,
      songs,
      albums,
      artists,
      playlists,
      raw: data,
    })
  } catch (err) {
    logger.error('QQ 音乐搜索异常:', err && err.message)
    return upstreamError(`QQ 音乐搜索失败: ${err && err.message}`)
  }
}
