/**
 * QQ 音乐：歌单详情与歌曲
 *
 * 读取任意歌单（自建或他人收藏）的详情与歌曲列表。
 * 歌单号是 `tid`，自己的歌单可额外传 `dirId` 以命中收藏目录。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

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
  const id = String(query.id ?? query.tid ?? '').trim()
  if (!id) return badRequest('id required')

  const session = readSession(query)
  const cookies =
    session && typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : (session && session.cookies) || {}
  const uin = String(
    (session && session.uin) ||
      cookies.qm_str_musicid ||
      cookies.uin ||
      cookies.wxuin ||
      '',
  ).replace(/^o/, '')
  const authSession = session ? { ...session, uin, cookies } : null

  try {
    const data = await qmRequest(
      'music.srfDissInfo.DissInfo',
      'CgiGetDiss',
      {
        uin: uin || '0',
        disstid: Number(id),
        dirid: Number(query.dirId ?? 0),
        tag: true,
        song_begin: Number(query.song_begin ?? 0),
        song_num: Number(query.song_num ?? 100),
        userinfo: true,
        orderlist: true,
        enc_host_uin: cookies.euin ?? '',
      },
      { session: authSession, referer: 'https://y.qq.com/' },
    )

    const cd = (data && data.cdlist && data.cdlist[0]) || {}
    return success({
      id,
      name: cd.dissname ?? '',
      creator: cd.nickname ?? '',
      cover: cd.logo ?? '',
      description: cd.desc ?? '',
      total:
        (data && data.total_song_num) ?? ((data && data.songlist) || []).length,
      hasmore: (data && data.hasmore) ?? 0,
      songs: ((data && data.songlist) || []).map(normalizeSong),
    })
  } catch (err) {
    logger.error('读取歌单详情异常:', err && err.message)
    return upstreamError(`读取歌单详情失败: ${err && err.message}`)
  }
}
