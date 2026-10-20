/**
 * 酷狗音乐歌单歌曲列表
 *
 * 走概念版 cloudlist 网关路由，读取指定云歌单中的歌曲。
 *
 * 除对外处理函数外，本模块还导出同目录写操作模块复用的内部工具 readListSongs，
 * 供加歌、删歌后的读回校验复用同一套协议细节。
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { KG_CLOUDLIST_ROUTER } = require('../core/config')
const {
  success,
  badRequest,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { businessError } = require('./user_playlist_list')

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

/**
 * 把歌曲条目映射为对外结构
 * @param {any} song 酷狗歌曲条目
 * @returns {any} 对外歌曲对象
 */
const mapSong = (song) => {
  const singerinfo = Array.isArray(song.singerinfo) ? song.singerinfo : []
  return {
    id: String(song.hash || ''),
    hash: song.hash || '',
    fileid: String(song.fileid || ''),
    audioId: song.audio_id || 0,
    name: song.songname || song.filename || '',
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
    album: song.album_name || '',
    albumId: String(song.album_id || ''),
    duration: song.duration || 0,
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
    result = await readListSongs(session, listid, page, pageSize)
  } catch (err) {
    logger.warn('读取歌单歌曲失败：', err.message || err)
    return upstreamError(`读取歌单歌曲失败：${err.message || err}`)
  }

  return success({
    code: 200,
    id: listid,
    page,
    pageSize,
    total: result.count || result.items.length,
    songs: result.items.map(mapSong),
  })
}

module.exports.readListSongs = readListSongs
