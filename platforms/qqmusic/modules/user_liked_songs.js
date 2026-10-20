/**
 * QQ 音乐：我喜欢的音乐
 *
 * 「我喜欢」是系统目录 `dirId=201`，读歌单要按它在自建列表里的 `tid` 取，
 * 目录号本身不能当 `disstid` 用。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  failure,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/** 「我喜欢」目录的系统 dirId（红心写入也走这个目录） */
const LIKED_DIR_ID = 201

/**
 * 把接口返回的标识字段解析为正整数
 * @param {unknown} value 原始值
 * @returns {number | undefined} 合法正整数，非法时返回 undefined
 */
const positiveInt = (value) => {
  const num =
    typeof value === 'string' && /^\d{1,15}$/.test(value)
      ? Number(value)
      : value
  return typeof num === 'number' && Number.isSafeInteger(num) && num > 0
    ? num
    : undefined
}

/**
 * 归一化歌曲条目
 * @param {Record<string, any>} song 接口返回的歌曲
 * @returns {Record<string, any>} 归一化后的歌曲
 */
const normalizeSong = (song) => ({
  id: song.id ?? 0,
  mid: song.mid ?? '',
  name: song.name ?? '',
  artist: (song.singer ?? [])
    .map((item) => item.name ?? '')
    .filter(Boolean)
    .join(' / '),
  album: song.album ?? '',
  duration: (song.interval ?? 0) * 1000,
})

module.exports = async (query = {}) => {
  const session = readSession(query)
  if (!session) return unauthorized('未登录 QQ 音乐账号')

  const cookies =
    typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : session.cookies || {}
  const uin = String(
    session.uin || cookies.qm_str_musicid || cookies.uin || cookies.wxuin || '',
  ).replace(/^o/, '')
  if (!uin || uin === '0') return unauthorized('未登录 QQ 音乐账号')

  const authSession = { ...session, uin, cookies }

  try {
    // 先从自建列表定位「我喜欢」（系统目录 dirId=201）
    const listData = await qmRequest(
      'music.musicasset.PlaylistBaseRead',
      'GetPlaylistByUin',
      { uin },
      { session: authSession },
    )
    const likedEntry = ((listData && listData.v_playlist) || []).find(
      (item) => item && positiveInt(item.dirId) === LIKED_DIR_ID,
    )
    const explicitTid = positiveInt(query.tid ?? query.disstid)
    const likedTid = explicitTid ?? positiveInt(likedEntry && likedEntry.tid)
    if (!likedTid) {
      return failure(404, { code: 404, message: '未找到「我喜欢」歌单' })
    }

    const data = await qmRequest(
      'music.srfDissInfo.DissInfo',
      'CgiGetDiss',
      {
        uin,
        disstid: likedTid,
        dirid: LIKED_DIR_ID,
        tag: true,
        song_begin: Number(query.song_begin ?? 0),
        song_num: Number(query.song_num ?? 100),
        userinfo: true,
        orderlist: true,
        enc_host_uin: cookies.euin ?? '',
      },
      { session: authSession, referer: 'https://y.qq.com/' },
    )

    return success({
      tid: likedTid,
      dirId: LIKED_DIR_ID,
      total:
        (data && data.total_song_num) ?? ((data && data.songlist) || []).length,
      hasmore: (data && data.hasmore) ?? 0,
      songs: ((data && data.songlist) || []).map(normalizeSong),
    })
  } catch (err) {
    logger.error('读取「我喜欢的音乐」异常:', err && err.message)
    return upstreamError(`读取「我喜欢的音乐」失败: ${err && err.message}`)
  }
}
