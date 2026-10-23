/**
 * QQ 音乐：歌手详情、热门歌曲与专辑
 *
 * 歌手以 mid 定位。歌曲与专辑分两个接口取，并行发出；
 * 歌手名优先取专辑列表里的歌手名，取不到时回落到歌曲的歌手名。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/** 上游「资源不存在」判据：请求层以 inner=404 表达模块内的资源缺失 */
const UPSTREAM_NOT_FOUND_PATTERN = /inner=404/

/** 歌手不存在时的失败文案 */
const SINGER_NOT_FOUND_MESSAGE = '读取歌手失败: 歌手不存在或 mid 无效'

/**
 * 发起一次上游调用并保留失败信息
 *
 * 歌曲与专辑两个接口要分别判定成败，
 * 才能把「歌手不存在」与「上游整体故障」区分开。
 * @param {Promise<any>} promise 待发起的请求
 * @returns {Promise<{ ok: boolean, data: any, error: Error | null }>} 调用结果
 */
const attempt = async (promise) => {
  try {
    return { ok: true, data: await promise, error: null }
  } catch (err) {
    return { ok: false, data: null, error: err }
  }
}

/**
 * 判定上游错误是否为「歌手不存在」
 *
 * 专辑接口对不存在的歌手返回 404，歌曲接口则返回空列表，
 * 因此只有专辑接口报错时才拿得到这个信号。
 * @param {Error | null} error 上游错误
 * @returns {boolean} 是否为歌手不存在
 */
const isSingerNotFound = (error) =>
  Boolean(error && UPSTREAM_NOT_FOUND_PATTERN.test(error.message))

/**
 * 解析「是否同时读取专辑」开关
 *
 * 路由层的查询参数值恒为字符串，
 * 所以 "false" / "0" / "no" 都要判为关闭。
 * @param {any} value 原始参数值
 * @returns {boolean} 是否同时读取专辑
 */
const parseIncludeAlbums = (value) => {
  if (value === undefined || value === null) return true
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  return !(text === 'false' || text === '0' || text === 'no')
}

/**
 * 拼接歌手名
 * @param {Array<{ name?: string }>} singers 歌手数组
 * @returns {string} 拼接后的歌手名
 */
const formatSingerName = (singers) => {
  if (!Array.isArray(singers) || singers.length === 0) return ''
  return singers
    .map((item) => (item && item.name) || '')
    .filter(Boolean)
    .join(' / ')
}

/**
 * 归一化歌手条目
 * @param {Record<string, any>} singer 接口返回的歌手
 * @returns {Record<string, any>} 归一化后的歌手
 */
const normalizeSinger = (singer) => ({
  id: String((singer && singer.id) ?? ''),
  mid: (singer && singer.mid) ?? '',
  name: (singer && singer.name) ?? '',
})

/**
 * 归一化歌曲条目
 *
 * 歌曲 ID 在部分账号下超出安全整数范围，一律以字符串透传。
 * @param {Record<string, any>} song 接口返回的歌曲
 * @returns {Record<string, any>} 归一化后的歌曲
 */
const normalizeSong = (song) => {
  const file = song.file || {}
  const pay = song.pay || {}

  return {
    id: String(song.id ?? ''),
    mid: song.mid ?? '',
    name: song.title ?? song.name ?? '',
    artist: formatSingerName(song.singer),
    artists: (song.singer || []).map(normalizeSinger),
    album: (song.album && song.album.name) || '',
    albumMid: (song.album && song.album.mid) || '',
    duration: (song.interval ?? 0) * 1000,
    mediaMid: file.media_mid ?? '',
    pay: {
      payalbum: pay.pay_month === 0 && (pay.price_album ?? 0) > 0 ? 1 : 0,
      payplay: pay.pay_play ?? 0,
    },
    size128: file.size_128mp3 ?? 0,
    size320: file.size_320mp3 ?? 0,
    sizeApe: file.size_ape ?? 0,
    sizeFlac: file.size_flac ?? 0,
    sizeOgg: file.size_192ogg ?? 0,
    sizeHiRes: (file.size_new && file.size_new[0]) ?? 0,
    hiResSampleRate: file.hires_sample ?? 0,
    hiResBitDepth: file.hires_bitdepth ?? 0,
  }
}

/**
 * 归一化专辑条目
 * @param {Record<string, any>} album 接口返回的专辑
 * @returns {Record<string, any>} 归一化后的专辑
 */
const normalizeAlbum = (album) => ({
  mid: album.album_mid ?? '',
  name: album.album_name ?? '',
  artist: album.singer_name ?? '',
  trackCount: (album.latest_song && album.latest_song.song_count) ?? 0,
  publishTime: album.pub_time ?? '',
})

module.exports = async (query = {}) => {
  const mid = String(query.mid ?? query.singerMid ?? '').trim()
  if (!mid) return badRequest('mid required')

  const offset = Math.max(0, Number(query.offset ?? 0) || 0)
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50))
  const includeAlbums = parseIncludeAlbums(query.includeAlbums)
  const session = readSession(query)

  try {
    const songsPromise = attempt(
      qmRequest(
        'musichall.song_list_server',
        'GetSingerSongList',
        { singerMid: mid, order: 1, begin: offset, num: limit },
        { session: session || null },
      ),
    )
    let albumsPromise = Promise.resolve({ ok: true, data: null, error: null })
    if (includeAlbums) {
      albumsPromise = attempt(
        qmRequest(
          'music.web_singer_info_svr',
          'get_singer_album',
          { singermid: mid, order: 'time', begin: 0, num: 200, exstatus: 1 },
          { session: session || null },
        ),
      )
    }

    const [songsOutcome, albumsOutcome] = await Promise.all([
      songsPromise,
      albumsPromise,
    ])

    // 歌手不存在：专辑接口对不存在的歌手返回 404，歌曲接口则返回空列表
    if (!albumsOutcome.ok && isSingerNotFound(albumsOutcome.error)) {
      logger.warn('歌手不存在:', mid)
      return upstreamError(SINGER_NOT_FOUND_MESSAGE)
    }
    if (!songsOutcome.ok) {
      logger.error(
        '读取歌手歌曲异常:',
        songsOutcome.error && songsOutcome.error.message,
      )
      return upstreamError(
        `读取歌手失败: ${(songsOutcome.error && songsOutcome.error.message) || '未知错误'}`,
      )
    }
    if (!albumsOutcome.ok) {
      logger.error(
        '读取歌手专辑异常:',
        albumsOutcome.error && albumsOutcome.error.message,
      )
      return upstreamError(
        `读取歌手失败: ${(albumsOutcome.error && albumsOutcome.error.message) || '未知错误'}`,
      )
    }

    const songsData = songsOutcome.data
    const albumsData = albumsOutcome.data

    const songs = ((songsData && songsData.songList) || [])
      .map((entry) => (entry && entry.songInfo) || null)
      .filter((song) => song && song.mid)
      .map(normalizeSong)
    const albums = ((albumsData && albumsData.list) || []).map(normalizeAlbum)

    // 歌手名取歌曲条目里与当前 mid 对应的那个歌手名：
    // 合作歌曲的歌手串是「A / B」的组合，直接用会把歌手页显示成不存在的组合歌手
    const matchedSinger = songs
      .map((song) => (song.artists || []).find((singer) => singer.mid === mid))
      .find(Boolean)

    return success({
      artist: {
        mid: (songsData && songsData.singerMid) || mid,
        name:
          (matchedSinger && matchedSinger.name) ||
          (songs.length > 0 ? songs[0].artist : '') ||
          (albums.length > 0 ? albums[0].artist : ''),
        songCount: (songsData && songsData.totalNum) ?? songs.length,
        albumCount: (albumsData && albumsData.total) ?? albums.length,
      },
      songs,
      albums,
      raw: { songs: songsData, albums: albumsData },
    })
  } catch (err) {
    logger.error('读取歌手异常:', err && err.message)
    return upstreamError(`读取歌手失败: ${err && err.message}`)
  }
}
