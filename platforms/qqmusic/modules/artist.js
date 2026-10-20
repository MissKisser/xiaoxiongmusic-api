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
  const includeAlbums = query.includeAlbums !== false
  const session = readSession(query)

  try {
    const songsPromise = qmRequest(
      'musichall.song_list_server',
      'GetSingerSongList',
      { singerMid: mid, order: 1, begin: offset, num: limit },
      { session: session || null },
    )
    const albumsPromise = includeAlbums
      ? qmRequest(
          'music.web_singer_info_svr',
          'get_singer_album',
          { singermid: mid, order: 'time', begin: 0, num: 200, exstatus: 1 },
          { session: session || null },
        )
      : Promise.resolve(null)

    const [songsData, albumsData] = await Promise.all([
      songsPromise,
      albumsPromise,
    ])

    const songs = ((songsData && songsData.songList) || [])
      .map((entry) => (entry && entry.songInfo) || null)
      .filter((song) => song && song.mid)
      .map(normalizeSong)
    const albums = ((albumsData && albumsData.list) || []).map(normalizeAlbum)

    return success({
      artist: {
        mid: (songsData && songsData.singerMid) || mid,
        name:
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
