/**
 * QQ 音乐：我的歌单列表
 *
 * 读取当前账号的自建歌单与收藏歌单，两侧来自不同的接口，字段名也不一致：
 * - 自建歌单：`PlaylistBaseRead.GetPlaylistByUin` 的 `v_playlist[]`，
 *   歌单名是 `dirName`、歌曲数是 `songNum`、封面是 `picUrl` / `bigpicUrl`，
 *   条目**不带 `dirType` 字段**，按「缺省即自建」处理。
 * - 收藏歌单：`PlaylistFavRead.GetPlaylistFavInfo` 的 `v_list[]`，
 *   歌单名是 `name`、歌曲数是 `songnum`、封面是 `logo`，
 *   条目的 `dirType` 实测为 0，不具备区分意义，对外统一标记为 3。
 *
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

/** 收藏歌单在对外语义里的目录类型 */
const FAVORITE_DIR_TYPE = 3

/** 自建歌单在对外语义里的目录类型 */
const OWNED_DIR_TYPE = 0

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
 * 把封面地址升级为 https
 * @param {unknown} value 原始封面地址
 * @returns {string} 可直接使用的封面地址
 */
const secureUrl = (value) =>
  typeof value === 'string' ? value.replace(/^http:/, 'https:') : ''

/**
 * 按给定顺序挑第一个非空的封面字段
 * @param {Record<string, any>} item 接口返回的歌单条目
 * @param {string[]} fields 候选字段名，按优先级排列
 * @returns {string} 封面地址，没有可用字段时返回空串
 */
const pickCover = (item, fields) => {
  for (const field of fields) {
    const url = secureUrl(item && item[field])
    if (url) return url
  }
  return ''
}

/**
 * 归一化自建歌单条目
 * @param {Record<string, any>} item 接口返回的自建歌单条目
 * @returns {Record<string, any>} 归一化后的歌单条目
 */
const normalizeOwned = (item) => ({
  tid: positiveInt(item.tid) ?? 0,
  dirId: positiveInt(item.dirId) ?? 0,
  dirName: item.dirName ?? '',
  dirType: OWNED_DIR_TYPE,
  songNum: item.songNum ?? item.songnum ?? 0,
  listenNum: item.listenNum ?? item.play_cnt ?? 0,
  cover: pickCover(item, ['picUrl', 'bigpicUrl', 'logo', 'logoUrl']),
  createTime: item.createTime ?? item.createtime ?? 0,
})

/**
 * 归一化收藏歌单条目
 * @param {Record<string, any>} item 接口返回的收藏歌单条目
 * @returns {Record<string, any>} 归一化后的歌单条目
 */
const normalizeFavorite = (item) => ({
  tid: positiveInt(item.tid) ?? 0,
  dirId: positiveInt(item.dirId) ?? 0,
  dirName: item.name ?? item.dirName ?? '',
  dirType: FAVORITE_DIR_TYPE,
  songNum: item.songnum ?? item.songNum ?? 0,
  listenNum: item.listenNum ?? item.play_cnt ?? 0,
  cover: pickCover(item, ['logo', 'logoUrl', 'picUrl', 'bigpicUrl']),
  createTime: item.createtime ?? item.createTime ?? 0,
})

/**
 * 读取自建歌单列表
 * @param {{ uin: string, cookies: Record<string, string> }} authSession 登录会话
 * @returns {Promise<{ items: Record<string, any>[], total: number, bFinish: boolean }>} 自建歌单与分页状态
 */
const readOwnedPlaylists = async (authSession) => {
  const data = await qmRequest(
    'music.musicasset.PlaylistBaseRead',
    'GetPlaylistByUin',
    { uin: authSession.uin },
    { session: authSession },
  )
  const list = (data && data.v_playlist) || []
  const items = list
    .filter((item) => item.dirType === 0 || item.dirType === undefined)
    .map(normalizeOwned)

  return {
    items,
    total: (data && data.total) ?? list.length,
    bFinish: (data && data.bFinish) ?? true,
  }
}

/**
 * 读取收藏歌单列表
 *
 * 收藏列表读失败时不抛出，由调用方降级为空列表，避免牵连自建歌单。
 * @param {{ uin: string, cookies: Record<string, string> }} authSession 登录会话
 * @returns {Promise<{ items: Record<string, any>[], total: number, hasMore: boolean }>} 收藏歌单与分页状态
 */
const readFavoritePlaylists = async (authSession) => {
  const data = await qmRequest(
    'music.musicasset.PlaylistFavRead',
    'GetPlaylistFavInfo',
    { uin: authSession.uin },
    { session: authSession },
  )
  const list = (data && data.v_list) || []

  return {
    items: list.map(normalizeFavorite),
    total: (data && data.total) ?? list.length,
    hasMore: Boolean((data && data.hasmore) || 0),
  }
}

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

  let owned = []
  let ownedTotal = 0
  let ownedFinished = true

  try {
    const result = await readOwnedPlaylists(authSession)
    owned = result.items
    ownedTotal = result.total
    ownedFinished = result.bFinish
  } catch (err) {
    logger.error('读取自建歌单列表异常:', err && err.message)
    return upstreamError(`读取歌单列表失败: ${err && err.message}`)
  }

  let favorites = []
  let favoriteTotal = 0
  let favoriteFinished = true

  try {
    const result = await readFavoritePlaylists(authSession)
    favorites = result.items
    favoriteTotal = result.total
    favoriteFinished = !result.hasMore
  } catch (err) {
    logger.error('读取收藏歌单列表异常，降级为空列表:', err && err.message)
  }

  return success({
    total: owned.length + favorites.length,
    ownedTotal,
    favoriteTotal,
    bFinish: ownedFinished && favoriteFinished,
    owned,
    favorites,
  })
}
