/**
 * 酷狗音乐收藏 / 取消收藏歌单
 *
 * 收藏走概念版 cloudlist 的 add_list 通道（type=1），取消收藏走 delete_list
 * 通道（type=1）。收藏公开歌单需要原歌单的创建者 userid 与原始歌单号，
 * 由公开歌单信息接口取得，取不到时直接失败，不做猜测。
 *
 * 语义：写入 → 读回确认 → 才返回成功。服务端收藏成功后会重新分配本地 listid，
 * 因此读回校验只能按原始歌单号（list_create_listid）比对，不能按本地 listid
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

const logger = createLogger('kugou')

/** 公开歌单信息接口 */
const KG_SPECIAL_INFO_URL = 'http://mobilecdn.kugou.com/api/v3/special/info'

/**
 * 读取公开歌单信息
 * @param {string} specialid 公开歌单号
 * @returns {Promise<{ suid: string, specialid: string, name: string } | null>} 歌单信息，取不到时返回 null
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

  return { suid, specialid: id, name: String(data.specialname || '') }
}

/**
 * 在歌单列表中定位收藏条目
 * @param {any[]} items 歌单条目
 * @param {string} specialid 原始歌单号
 * @returns {any} 命中的收藏条目，未命中时返回 undefined
 */
const findCollected = (items, specialid) =>
  items.find(
    (item) =>
      Number(item.type || 0) === 1 &&
      String(item.list_create_listid || '') === String(specialid),
  )

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
          list_create_userid: Number(origin.suid),
          list_create_listid: Number(origin.specialid),
          list_create_gid: `collection_3_${origin.suid}_${origin.specialid}_0`,
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

    let after
    try {
      after = await readMyLists(session)
    } catch (err) {
      logger.warn('收藏后读回失败：', err.message || err)
      return upstreamError(
        `收藏后读回校验失败：无法读取歌单列表（${err.message || err}）`,
      )
    }

    if (!findCollected(after.items, origin.specialid)) {
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

  let after
  try {
    after = await readMyLists(session)
  } catch (err) {
    logger.warn('取消收藏后读回失败：', err.message || err)
    return upstreamError(
      `取消收藏后读回校验失败：无法读取歌单列表（${err.message || err}）`,
    )
  }

  if (
    after.items.some(
      (item) => String(item.listid || '') === String(collected.listid),
    )
  ) {
    return upstreamError('取消收藏后读回校验失败：收藏仍在列表中')
  }

  return success({
    code: 200,
    id,
    subscribed: false,
    verified: true,
  })
}
