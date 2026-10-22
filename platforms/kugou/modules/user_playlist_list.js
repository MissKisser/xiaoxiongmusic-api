/**
 * 酷狗音乐「我的歌单」列表
 *
 * 走 cloudlist 网关路由（客户端标识跟随当前登录模式），读取当前账号下的自建歌单与收藏歌单。
 * 目录语义：type=0 自建，type=1 收藏；is_def=1 默认收藏，is_def=2「我喜欢」。
 *
 * 除对外处理函数外，本模块还导出同目录写操作模块复用的内部工具，
 * 避免各写操作模块重复实现同一套协议细节：
 * - readMyLists：读取歌单列表快照（含列表版本号）
 * - businessError：解析酷狗业务响应中的错误描述
 */

const { kgGatewayRequest, kgErrorCode } = require('../core/request')
const { readSession } = require('../core/session')
const { KG_CLOUDLIST_ROUTER } = require('../core/config')
const {
  success,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/**
 * 解析酷狗业务响应中的错误描述
 *
 * 酷狗网关的 status 字段在业务体中为 1 表示成功，个别通道透传 HTTP 状态码，
 * 两种取值都视为成功。
 * @param {any} body 业务响应体
 * @returns {string} 错误描述，响应正常时返回空串
 */
const businessError = (body) => {
  if (!body || typeof body !== 'object') return '响应格式异常'

  const code = kgErrorCode(body)
  if (code !== 0) return `error_code=${code}`

  const rawStatus = body.status
  const status =
    rawStatus === undefined || rawStatus === null ? 1 : Number(rawStatus)
  if (status !== 1 && status !== 200) return `status=${status}`

  return ''
}

/**
 * 读取账号的云端歌单列表快照
 * @param {{ token: string, userid: string | number }} session 酷狗会话凭据
 * @returns {Promise<{ items: any[], totalVer: number, listCount: number, collectCount: number, albumCount: number }>} 歌单快照
 * @throws {Error} 酷狗返回业务错误时抛出
 */
const readMyLists = async (session) => {
  const body = await kgGatewayRequest(
    '/v7/get_all_list',
    {
      userid: Number(session.userid),
      token: session.token,
      total_ver: 0,
      type: 2,
      page: 1,
      pagesize: 100,
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
    totalVer: Number(data.total_ver || 0),
    listCount: Number(data.list_count || 0),
    collectCount: Number(data.collect_count || 0),
    albumCount: Number(data.album_count || 0),
  }
}

/**
 * 把歌单条目映射为对外结构
 *
 * 收藏歌单（type=1）在「我的歌单」里只是一条**收藏记录**：
 * `listid` 是本地收藏号，云歌单接口按这个号查不到曲目，曲目在源歌单里。
 * 源歌单有两个标识：`list_create_listid` 是源歌单在源账号下的云歌单号，
 * `musiclib_id` 是源歌单的精选号；公开歌单通道按精选号取曲目。
 * @param {any} item 酷狗歌单条目
 * @param {boolean} subscribed 是否为收藏歌单
 * @returns {any} 对外歌单对象
 */
const mapPlaylist = (item, subscribed) => {
  const isDef = Number(item.is_def || 0)
  return {
    listid: String(item.listid || ''),
    name: item.name || '',
    type: Number(item.type || (subscribed ? 1 : 0)),
    count: Number(item.count || 0),
    creator: item.list_create_username || '',
    cover: item.pic || '',
    intro: item.intro || '',
    createTime: Number(item.create_time || 0),
    updateTime: Number(item.update_time || 0),
    isDef,
    isDefault: isDef > 0,
    /** 是否为收藏（订阅）歌单 */
    subscribed,
    /** 源歌单号（收藏歌单才有） */
    originListid: String(item.list_create_listid || ''),
    /** 源歌单作者 userid（收藏歌单才有） */
    originUserid: String(item.list_create_userid || ''),
    /** 源歌单的 gid（收藏歌单才有） */
    originGid: String(item.list_create_gid || ''),
    /** 收藏记录的全局标识（收藏歌单才有） */
    globalCollectionId: String(item.global_collection_id || ''),
    /** 源歌单的精选号（收藏歌单才有，读源歌单曲目的键） */
    originSpecialid: String(item.musiclib_id || ''),
  }
}

/**
 * 读取当前账号的云端歌单列表
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  let snapshot
  try {
    snapshot = await readMyLists(session)
  } catch (err) {
    logger.warn('读取「我的歌单」失败：', err.message || err)
    return upstreamError(`读取「我的歌单」失败：${err.message || err}`)
  }

  const owned = snapshot.items.filter((item) => Number(item.type || 0) !== 1)
  const favorites = snapshot.items.filter(
    (item) => Number(item.type || 0) === 1,
  )

  return success({
    code: 200,
    total: snapshot.items.length,
    totalVer: snapshot.totalVer,
    listCount: snapshot.listCount || owned.length,
    collectCount: snapshot.collectCount || favorites.length,
    albumCount: snapshot.albumCount,
    owned: owned.map((item) => mapPlaylist(item, false)),
    favorites: favorites.map((item) => mapPlaylist(item, true)),
  })
}

module.exports.readMyLists = readMyLists
module.exports.businessError = businessError
