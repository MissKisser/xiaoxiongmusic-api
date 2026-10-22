/**
 * 酷狗音乐歌单歌曲列表
 *
 * 走 cloudlist 网关路由，读取指定云歌单中的歌曲。
 *
 * 客户端标识跟随当前登录模式：登录 token 与客户端标识绑定，用另一套标识
 * 签名会被网关以 error_code=20017 拒收。
 *
 * 除对外处理函数外，本模块还导出同目录写操作模块复用的内部工具 readListSongs，
 * 供加歌、删歌后的读回校验复用同一套协议细节。
 *
 * 顺序口径：上游 `/v4/get_list_all_file` 的默认序是「添加时间升序」（先加的在前），
 * 官方客户端显示的却是歌单内的位置序——每个条目自带 `sort` 位置下标，
 * 新加入的曲目位置最靠前。同批导入的曲目添加时间完全相同，
 * 只按添加时间排还原不出官方顺序，因此这里按位置下标还原。
 *
 * 歌名口径：歌名剥离规则由 `../core/song_title` 统一提供，与公开歌单、加歌
 * 写入三处共用同一实现，同一首歌在任何页面显示的都是同一个名字。
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { KG_CLOUDLIST_ROUTER } = require('../core/config')
const { extractEntryTitle } = require('../core/song_title')
const {
  success,
  badRequest,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { businessError } = require('./user_playlist_list')
const { readMyLists } = require('./user_playlist_list')
const publicPlaylist = require('./playlist')

const logger = createLogger('kugou')

/** 单页最大歌曲数 */
const MAX_PAGE_SIZE = 300

/**
 * 读取一个云歌单中的歌曲
 * @param {{ token: string, userid: string | number }} session 酷狗会话凭据
 * @param {string} listid 歌单 listid
 * @param {number} [page] 页码，从 1 开始
 * @param {number} [pageSize] 每页数量
 * @returns {Promise<{ items: any[], count: number }>} 歌曲条目与歌曲总数
 * @throws {Error} 酷狗返回业务错误时抛出
 */
const readListSongs = async (
  session,
  listid,
  page = 1,
  pageSize = MAX_PAGE_SIZE,
) => {
  const body = await kgGatewayRequest(
    '/v4/get_list_all_file',
    {
      listid,
      userid: Number(session.userid),
      area_code: 1,
      show_relate_goods: 1,
      pagesize: pageSize,
      allplatform: 1,
      show_cover: 1,
      type: 0,
      token: session.token,
      page,
    },
    {
      params: { plat: 1 },
      headers: { 'x-router': KG_CLOUDLIST_ROUTER },
      session,
    },
  )

  const error = businessError(body)
  if (error) throw new Error(error)

  const data = (body && body.data) || {}
  return {
    items: Array.isArray(data.info) ? data.info : [],
    count: Number(data.count || 0),
  }
}

/** 封面链接里尺寸占位符 `{size}` 的替换值 */
const COVER_SIZE = 300

/**
 * 按官方客户端的显示顺序排列曲目
 *
 * 官方客户端按歌单内的位置下标（条目自带的 `sort`）显示曲目，
 * 位置 0 是最靠前的一首，新加入的曲目落在最前面。
 * 上游没有给位置下标时保持上游原序，不擅自改变语义。
 * @param {any[]} items 上游返回的曲目条目
 * @returns {any[]} 按官方位置序排列的曲目条目
 */
const sortByOfficialOrder = (items) => {
  const positions = items.map((item) => {
    const value = item ? item.sort : undefined
    if (value === undefined || value === null || value === '') return NaN
    return Number(value)
  })
  if (positions.some((value) => !Number.isFinite(value))) return items
  const order = items.map((_, index) => index)
  order.sort((a, b) => positions[a] - positions[b] || a - b)
  return order.map((index) => items[index])
}

/**
 * 读取一个云歌单的全部曲目，并按官方客户端的显示顺序排列
 *
 * 上游分页按「添加时间」切分，与官方显示序不是一回事，
 * 还原官方顺序必须把整个歌单取回来再排，之后按位置序切页。
 * 上游在分页边界可能重复同一条目，这里按内容哈希去重。
 * @param {any} session 酷狗会话凭据
 * @param {string} listid 歌单 listid
 * @returns {Promise<{ items: any[], count: number }>} 曲目条目与歌曲总数
 */
const readListSongsInOfficialOrder = async (session, listid) => {
  const collected = []
  const seen = new Set()
  let count = 0
  let totalPages = 1

  for (let page = 1; page <= totalPages; page += 1) {
    const result = await readListSongs(session, listid, page, MAX_PAGE_SIZE)
    count = result.count || count
    totalPages = Math.max(1, Math.ceil(count / MAX_PAGE_SIZE))
    for (const item of result.items) {
      const key = String((item && item.hash) || '')
      if (key) {
        if (seen.has(key)) continue
        seen.add(key)
      }
      collected.push(item)
    }
    if (!result.items.length) break
  }

  return {
    items: sortByOfficialOrder(collected),
    count: count || collected.length,
  }
}

/**
 * 从歌曲条目里取出纯歌名
 *
 * 云歌单端点返回的条目没有 `songname` / `filename`，歌名混在 `name` 里，
 * 形态为 `歌手A、歌手B - 歌名.mp3`。剥离规则由 `../core/song_title` 统一提供，
 * 与公开歌单、加歌写入共用同一实现。
 * @param {any} song 酷狗歌曲条目
 * @returns {string} 歌名，取不到时返回空串
 */
const extractSongName = (song) =>
  extractEntryTitle(song, { nameFields: ['name'] })

/**
 * 从歌曲条目里取专辑名
 *
 * 云歌单端点把专辑信息放在 `albuminfo` 对象里，兼容旧形态的 `album_name`。
 * @param {any} song 酷狗歌曲条目
 * @returns {string} 专辑名，取不到时返回空串
 */
const extractAlbumName = (song) => {
  const info = song.albuminfo
  if (info && typeof info === 'object' && info.name) return String(info.name)
  return String(song.album_name || '')
}

/**
 * 把歌曲条目映射为对外结构
 *
 * 字段口径说明：
 * - `id` 是**内容哈希**（hash），不是酷狗的歌曲主键；歌曲主键是 `mixSongId`。
 * - `albumId` 是**专辑 ID**；`albumAudioId` 是 album_audio_id 口径（与 `mixSongId`
 *   同值），签播放地址要的是后者。
 * @param {any} song 酷狗歌曲条目
 * @returns {any} 对外歌曲对象
 */
const mapSong = (song) => {
  const singerinfo = Array.isArray(song.singerinfo) ? song.singerinfo : []
  const coverOriginal = String(song.cover || '')
  return {
    /** 内容哈希（不是歌曲主键，歌曲主键见 `mixSongId`） */
    id: String(song.hash || ''),
    hash: song.hash || '',
    fileid: String(song.fileid || ''),
    audioId: song.audio_id || 0,
    /** 歌曲主键（album_audio_id 口径），查评论、签播放地址都用它 */
    mixSongId: String(song.mixsongid || ''),
    /** 歌曲主键的数字形态，语义与 `mixSongId` 相同 */
    albumAudioId: Number(song.mixsongid || 0),
    name: extractSongName(song),
    artist:
      song.singername ||
      singerinfo
        .map((singer) => singer.name || '')
        .filter(Boolean)
        .join(' / '),
    artists: singerinfo.map((singer) => ({
      id: String(singer.id || ''),
      name: singer.name || '',
    })),
    album: extractAlbumName(song),
    /** 专辑 ID（不是 album_audio_id） */
    albumId: String(song.album_id || ''),
    /** 封面链接，尺寸占位符已替换为 300 */
    cover: coverOriginal.replace(/\{size\}/g, String(COVER_SIZE)),
    /** 未替换尺寸占位符的原始封面链接 */
    coverOriginal,
    /** 时长（毫秒） */
    duration: Number(song.timelen || song.duration || 0),
    payType: song.media_pay_type || 0,
    language: song.language || '',
    publishDate: song.publish_date || '',
    qualities: (Array.isArray(song.relate_goods) ? song.relate_goods : []).map(
      (good) => ({
        bitrate: good.bitrate || 0,
        size: good.size || 0,
        hash: good.hash || '',
        privilege: good.privilege || 0,
        level: good.level || 0,
      }),
    ),
  }
}

/**
 * 读取一个歌单中的歌曲
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const listid = String(query.id || query.listid || '').trim()
  if (!listid) return badRequest('id 不能为空')

  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  const page = Math.max(1, Number(query.page || 1) || 1)
  const pageSize = Math.max(
    1,
    Number(query.pageSize || MAX_PAGE_SIZE) || MAX_PAGE_SIZE,
  )

  let result
  try {
    result = await readListSongsInOfficialOrder(session, listid)
  } catch (err) {
    logger.warn('读取歌单歌曲失败：', err.message || err)
    return upstreamError(`读取歌单歌曲失败：${err.message || err}`)
  }

  // 官方显示序是整张歌单的位置序，分页要按排好序的全量切页，
  // 否则翻页会与上游的添加时间序错位
  const offset = (page - 1) * pageSize
  const songs = result.items.slice(offset, offset + pageSize)

  // 收藏歌单的曲目在源歌单里：本地收藏号在云歌单命名空间下查不到曲目，
  // 此时按源歌单标识解析；源歌单是公开歌单时走公开歌单通道读取。
  if (!result.items.length) {
    let collected = null
    try {
      const snapshot = await readMyLists(session)
      collected =
        snapshot.items.find(
          (item) =>
            Number(item.type || 0) === 1 &&
            String(item.listid || '') === listid,
        ) || null
    } catch (err) {
      logger.warn('定位收藏记录失败：', err.message || err)
    }

    if (collected) {
      // 收藏记录在云歌单命名空间下没有曲目，曲目在源歌单里；
      // 源歌单的精选号在 musiclib_id 上，公开歌单通道按精选号取曲目
      const sourceId = String(collected.musiclib_id || '')
      const sourceUserId = String(collected.list_create_userid || '')
      const sourceListid = String(collected.list_create_listid || '')
      if (sourceId) {
        try {
          const source = await publicPlaylist.readPublicPlaylist(
            sourceId,
            page,
            pageSize,
            session,
          )
          if (source.songs && source.songs.length) {
            return success({
              code: 200,
              id: listid,
              page,
              pageSize,
              total: source.total,
              songs: source.songs,
              subscribed: true,
              sourceId,
              sourceUserId,
              sourceListid,
              sourceName: source.name,
              sourceCreator: source.creator,
              sourceCount: Number(collected.count || 0),
              sourceReadable: true,
            })
          }
        } catch (err) {
          logger.warn('读取收藏歌单源歌单失败：', err.message || err)
        }
      }
      // 源歌单不可读：如实回报，不把「读不到」当成「没有歌」
      return success({
        code: 200,
        id: listid,
        page,
        pageSize,
        total: 0,
        songs: [],
        subscribed: true,
        sourceId,
        sourceUserId,
        sourceListid,
        sourceName: collected.name || '',
        sourceCreator: collected.list_create_username || '',
        sourceCount: Number(collected.count || 0),
        sourceReadable: false,
        message: '源歌单当前不可读',
      })
    }
  }

  return success({
    code: 200,
    id: listid,
    page,
    pageSize,
    total: result.count || result.items.length,
    songs: songs.map(mapSong),
  })
}

module.exports.readListSongs = readListSongs
module.exports.readListSongsInOfficialOrder = readListSongsInOfficialOrder
module.exports.sortByOfficialOrder = sortByOfficialOrder
