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
 * 取第一个非空字符串
 * @param {...any} values 待检查的值
 * @returns {string} 第一个非空字符串，全为空时返回空串
 */
const firstText = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
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

/**
 * 读取歌单概要信息
 *
 * 该接口负责给出歌单封面与概要字段，任何失败都不应让整个歌单详情请求失败。
 * @param {string} tid 歌单号
 * @param {{ uin: string, cookies: Record<string, string> } | null} authSession 请求凭据
 * @returns {Promise<Record<string, any> | null>} dirinfo 数据段，失败时返回 null
 */
const fetchDirInfo = async (tid, authSession) => {
  try {
    const data = await qmRequest(
      'music.srfDissInfo.aiDissInfo',
      'uniform_get_Dissinfo',
      { disstid: Number(tid) },
      { session: authSession, referer: 'https://y.qq.com/' },
    )
    return (data && data.dirinfo) || null
  } catch (err) {
    logger.warn('读取歌单概要失败，封面降级为空:', err && err.message)
    return null
  }
}

/**
 * 在自建歌单列表里查找指定歌单
 *
 * @param {string} tid 歌单号
 * @param {{ uin: string, cookies: Record<string, string> } | null} authSession 请求凭据
 * @returns {Promise<Record<string, any> | null>} 命中的歌单条目，未命中或失败时返回 null
 */
const fetchOwnPlaylist = async (tid, authSession) => {
  if (!authSession || !authSession.uin) return null
  try {
    const data = await qmRequest(
      'music.musicasset.PlaylistBaseRead',
      'GetPlaylistByUin',
      { uin: authSession.uin, offset: 0, size: 100, order: 1 },
      { session: authSession, referer: 'https://y.qq.com/' },
    )
    const list = (data && data.v_playlist) || []
    return list.find((item) => String((item && item.tid) ?? '') === tid) || null
  } catch (err) {
    logger.warn('读取自建歌单列表失败，封面降级为空:', err && err.message)
    return null
  }
}

/**
 * 按优先级挑选歌单封面
 *
 * 优先级：概要接口的 picurl → 详情接口的 logo/pic → 自建歌单列表的 picUrl。
 * @param {Record<string, any> | null} dirinfo 概要信息
 * @param {Record<string, any> | null} cd 详情接口的 cdlist 首项
 * @param {Record<string, any> | null} ownPlaylist 自建歌单列表里的同号歌单
 * @returns {string} 封面地址，取不到时为空串
 */
const pickPlaylistCover = (dirinfo, cd, ownPlaylist) =>
  firstText(
    dirinfo && dirinfo.picurl,
    dirinfo && dirinfo.picurl2,
    cd && cd.logo,
    cd && cd.pic,
    cd && cd.picurl,
    ownPlaylist && ownPlaylist.picUrl,
    ownPlaylist && ownPlaylist.bigpicUrl,
  )

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
    const dirinfo = await fetchDirInfo(id, authSession)

    let cover = pickPlaylistCover(dirinfo, cd, null)
    if (!cover) {
      const ownPlaylist = await fetchOwnPlaylist(id, authSession)
      cover = pickPlaylistCover(dirinfo, cd, ownPlaylist)
    }

    return success({
      id,
      name: firstText(cd.dissname, dirinfo && dirinfo.title),
      creator: firstText(
        cd.nickname,
        dirinfo && dirinfo.creator && dirinfo.creator.nick,
      ),
      cover,
      description: firstText(cd.desc, dirinfo && dirinfo.desc),
      total:
        (data && data.total_song_num) ??
        (dirinfo && dirinfo.songnum) ??
        ((data && data.songlist) || []).length,
      hasmore: (data && data.hasmore) ?? 0,
      songs: ((data && data.songlist) || []).map(normalizeSong),
    })
  } catch (err) {
    logger.error('读取歌单详情异常:', err && err.message)
    return upstreamError(`读取歌单详情失败: ${err && err.message}`)
  }
}
