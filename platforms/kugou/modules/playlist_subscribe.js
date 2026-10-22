/**
 * 酷狗音乐收藏 / 取消收藏歌单
 *
 * 收藏走 cloudlist 的 add_list 通道（type=1），取消收藏走 delete_list
 * 通道（type=1）。收藏公开歌单需要源歌单的真实身份，取自公开歌单信息接口的
 * `global_specialid`（`collection_3_<源用户id>_<源云歌单号>_0`）：精选号本身
 * 不是云歌单号，直接当 `list_create_listid` 提交会被上游以 30203 拒收。
 * 取不到时直接失败，不做猜测。
 *
 * 语义：写入 → 读回确认 → 才返回成功。服务端收藏成功后会重新分配本地 listid，
 * 因此读回校验只能按源歌单全局标识（list_create_gid）比对，不能按本地 listid
 * 比对；取消收藏则按本地收藏条目的 listid 校验其已消失。
 */

const { kgGatewayRequest, kgRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { KG_CLOUDLIST_ROUTER, KG_ANDROID_UA } = require('../core/config')
const {
  success,
  badRequest,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { readMyLists, businessError } = require('./user_playlist_list')
const { parseGlobalSpecialid } = require('./playlist')

const logger = createLogger('kugou')

/** 公开歌单信息接口 */
const KG_SPECIAL_INFO_URL = 'http://mobilecdn.kugou.com/api/v3/special/info'

/**
 * 读取公开歌单信息
 * @param {string} specialid 公开歌单号
 * @returns {Promise<{ suid: string, specialid: string, name: string, globalSpecialid: string, sourceListid: string, sourceUserid: string } | null>} 歌单信息，取不到时返回 null
 */
const readPublicPlaylist = async (specialid) => {
  const url = `${KG_SPECIAL_INFO_URL}?specialid=${encodeURIComponent(specialid)}&format=json`
  const body = await kgRequest(url, {
    headers: { 'User-Agent': KG_ANDROID_UA },
  })

  const data = (body && body.data) || {}
  const suid = String(data.suid || '')
  const id = String(data.specialid || '')
  if (!suid || !id) return null

  const globalSpecialid = String(data.global_specialid || '')
  const source = parseGlobalSpecialid(globalSpecialid)
  return {
    suid,
    specialid: id,
    name: String(data.specialname || ''),
    globalSpecialid,
    sourceListid: source.listid,
    sourceUserid: source.userid,
  }
}

/**
 * 在歌单列表中定位收藏条目
 *
 * 收藏记录的 `musiclib_id` 是源歌单的精选号，与传入的精选号一致；
 * 早期记录没有该字段时退回按源云歌单号比对。
 * @param {any[]} items 歌单条目
 * @param {string} specialid 精选号
 * @returns {any} 命中的收藏条目，未命中时返回 undefined
 */
const findCollected = (items, specialid) =>
  items.find(
    (item) =>
      Number(item.type || 0) === 1 &&
      (String(item.musiclib_id || '') === String(specialid) ||
        String(item.list_create_listid || '') === String(specialid)),
  )

/**
 * 等待歌单列表满足条件
 *
 * 上游的列表读取偶发返回写操作之前的旧快照，写完立刻读回可能拿到旧值，
 * 读回校验会误判。这里在有限次数内重试，直到满足条件或用尽次数。
 * @param {any} session 酷狗会话凭据
 * @param {(items: any[]) => boolean} predicate 判定条件
 * @returns {Promise<boolean>} 是否在重试次数内满足条件
 */
const waitMyLists = async (session, predicate) => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const snapshot = await readMyLists(session)
    if (predicate(snapshot.items)) return true
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  return false
}

/**
 * 收藏 / 取消收藏歌单
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const id = String(query.id || query.specialid || '').trim()
  if (!id) return badRequest('id 不能为空')
  if (typeof query.subscribed !== 'boolean') {
    return badRequest('subscribed 必须是布尔值')
  }

  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  let snapshot
  try {
    snapshot = await readMyLists(session)
  } catch (err) {
    logger.warn('收藏操作前读取歌单列表失败：', err.message || err)
    return upstreamError(`操作歌单收藏失败：${err.message || err}`)
  }

  const collected = findCollected(snapshot.items, id)

  if (query.subscribed) {
    if (collected) {
      return success({
        code: 200,
        id,
        subscribed: true,
        already: true,
        verified: true,
      })
    }

    let origin
    try {
      origin = await readPublicPlaylist(id)
    } catch (err) {
      logger.warn('读取公开歌单信息失败：', err.message || err)
      return upstreamError(
        `无法获取该公开歌单的创建者信息（suid / specialid），未执行收藏：${
          err.message || err
        }`,
      )
    }
    if (!origin) {
      return upstreamError(
        '无法获取该公开歌单的创建者信息（suid / specialid），未执行收藏',
      )
    }
    if (
      !origin.globalSpecialid ||
      !origin.sourceUserid ||
      !origin.sourceListid
    ) {
      return upstreamError(
        '无法获取该公开歌单的源歌单标识（global_specialid），未执行收藏',
      )
    }

    let body
    try {
      body = await kgGatewayRequest(
        '/cloudlist.service/v5/add_list',
        {
          userid: Number(session.userid),
          token: session.token,
          total_ver: 0,
          name: origin.name,
          type: 1,
          source: 1,
          is_pri: 0,
          // 源歌单身份取自 global_specialid：精选号不是云歌单号，
          // 直接用精选号提交会被上游以 error_code=30203 拒收
          list_create_userid: Number(origin.sourceUserid),
          list_create_listid: Number(origin.sourceListid),
          list_create_gid: origin.globalSpecialid,
          from_shupinmv: 0,
        },
        { session },
      )
    } catch (err) {
      logger.warn('收藏歌单失败：', err.message || err)
      return upstreamError(`收藏歌单失败：${err.message || err}`)
    }

    const error = businessError(body)
    if (error) {
      logger.warn('收藏歌单失败：', error)
      return upstreamError(`收藏歌单失败：${error}`)
    }

    let found
    try {
      found = await waitMyLists(session, (items) =>
        items.some(
          (item) =>
            Number(item.type || 0) === 1 &&
            String(item.list_create_gid || '') === origin.globalSpecialid,
        ),
      )
    } catch (err) {
      logger.warn('收藏后读回失败：', err.message || err)
      return upstreamError(
        `收藏后读回校验失败：无法读取歌单列表（${err.message || err}）`,
      )
    }

    if (!found) {
      return upstreamError('收藏后读回校验失败：收藏列表中未找到该歌单')
    }

    return success({
      code: 200,
      id: String(origin.specialid),
      subscribed: true,
      verified: true,
    })
  }

  if (!collected) {
    return badRequest('未收藏该歌单')
  }

  const clienttime = Math.floor(Date.now() / 1000)

  let body
  try {
    body = await kgGatewayRequest(
      '/v3/delete_list',
      {
        userid: Number(session.userid),
        token: session.token,
        total_ver: snapshot.totalVer,
        type: 1,
        listid: Number(collected.listid),
        name: collected.name || '',
      },
      {
        params: {
          last_time: clienttime,
          last_area: 'gztx',
          userid: session.userid,
          token: session.token,
          plat: 1,
        },
        headers: { 'x-router': KG_CLOUDLIST_ROUTER },
        session,
      },
    )
  } catch (err) {
    logger.warn('取消收藏失败：', err.message || err)
    return upstreamError(`取消收藏失败：${err.message || err}`)
  }

  const error = businessError(body)
  if (error) {
    logger.warn('取消收藏失败：', error)
    return upstreamError(`取消收藏失败：${error}`)
  }

  let removed
  try {
    removed = await waitMyLists(
      session,
      (items) =>
        !items.some(
          (item) => String(item.listid || '') === String(collected.listid),
        ),
    )
  } catch (err) {
    logger.warn('取消收藏后读回失败：', err.message || err)
    return upstreamError(
      `取消收藏后读回校验失败：无法读取歌单列表（${err.message || err}）`,
    )
  }

  if (!removed) {
    return upstreamError('取消收藏后读回校验失败：收藏仍在列表中')
  }

  return success({
    code: 200,
    id,
    subscribed: false,
    verified: true,
  })
}
