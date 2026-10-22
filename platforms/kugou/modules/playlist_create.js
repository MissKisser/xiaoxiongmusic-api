/**
 * 酷狗音乐创建歌单
 *
 * 走 cloudlist 的 add_list 通道创建自建歌单（客户端标识跟随当前登录模式）。
 *
 * 语义：写入 → 读回确认 → 才返回成功。创建成功后重新读一次「我的歌单」，
 * 读回结果与预期不符时返回失败且不自动重试，避免界面显示成功而平台没建。
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const {
  success,
  badRequest,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { readMyLists, businessError } = require('./user_playlist_list')

const logger = createLogger('kugou')

/**
 * 创建歌单
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const name = String(query.name || '').trim()
  if (!name) return badRequest('name 不能为空')

  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  const clienttime = Math.floor(Date.now() / 1000)

  let body
  try {
    body = await kgGatewayRequest(
      '/cloudlist.service/v5/add_list',
      {
        userid: Number(session.userid),
        token: session.token,
        total_ver: 0,
        name,
        type: 0,
        source: 1,
        is_pri: 0,
        list_create_userid: Number(session.userid),
        list_create_listid: 0,
        list_create_gid: '',
        from_shupinmv: 0,
      },
      {
        params: {
          last_time: clienttime,
          last_area: 'gztx',
          userid: session.userid,
          token: session.token,
        },
        session,
      },
    )
  } catch (err) {
    logger.warn('创建歌单失败：', err.message || err)
    return upstreamError(`创建歌单失败：${err.message || err}`)
  }

  const error = businessError(body)
  if (error) {
    logger.warn('创建歌单失败：', error)
    return upstreamError(`创建歌单失败：${error}`)
  }

  const listid = String(
    (body &&
      body.data &&
      body.data.info &&
      body.data.info.list_create_listid) ||
      '',
  )
  if (!listid || listid === '0') {
    return upstreamError('创建歌单失败：响应中缺少新歌单 listid')
  }

  let snapshot
  try {
    snapshot = await readMyLists(session)
  } catch (err) {
    logger.warn('创建歌单后读回失败：', err.message || err)
    return upstreamError(
      `创建后读回校验失败：无法读取歌单列表（${err.message || err}）`,
    )
  }

  const created = snapshot.items.find(
    (item) => String(item.listid || '') === listid,
  )
  if (!created) {
    return upstreamError('创建后读回校验失败：歌单列表中未找到新歌单')
  }
  if (created.name && created.name !== name) {
    return upstreamError(`创建后读回校验失败：歌单名称为 ${created.name}`)
  }

  return success({
    code: 200,
    id: listid,
    name: created.name || name,
    verified: true,
  })
}
