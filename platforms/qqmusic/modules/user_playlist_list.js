/**
 * QQ 音乐：我的歌单列表
 *
 * 读取当前账号的自建歌单与收藏歌单。
 * 自建目录 `dirType` 为 0，收藏目录 `dirType` 为 3；
 * 写操作的定位键是 `dirId`，歌单号是 `tid`。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

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
 * 归一化歌单条目
 * @param {Record<string, any>} item 接口返回的歌单条目
 * @param {number} defaultDirType 默认的目录类型
 * @returns {Record<string, any>} 归一化后的歌单条目
 */
const normalizePlaylist = (item, defaultDirType) => ({
  tid: positiveInt(item.tid) ?? 0,
  dirId: positiveInt(item.dirId) ?? 0,
  dirName: item.dirName ?? '',
  dirType: item.dirType ?? defaultDirType,
  songNum: item.songnum ?? item.songNum ?? 0,
  listenNum: item.listenNum ?? 0,
  cover: item.logo ?? item.logoUrl ?? '',
  createTime: item.createTime ?? 0,
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
    const data = await qmRequest(
      'music.musicasset.PlaylistBaseRead',
      'GetPlaylistByUin',
      { uin },
      { session: authSession },
    )
    const list = (data && data.v_playlist) || []
    const owned = list.filter(
      (item) => item.dirType === 0 || item.dirType === undefined,
    )
    const favorites = list.filter((item) => item.dirType === 3)

    return success({
      total: (data && data.total) ?? list.length,
      bFinish: (data && data.bFinish) ?? true,
      owned: owned.map((item) => normalizePlaylist(item, 0)),
      favorites: favorites.map((item) => normalizePlaylist(item, 3)),
    })
  } catch (err) {
    logger.error('读取歌单列表异常:', err && err.message)
    return upstreamError(`读取歌单列表失败: ${err && err.message}`)
  }
}
