/**
 * 酷狗音乐删除歌单
 *
 * 走 cloudlist 的 delete_list 通道删除自建歌单（客户端标识跟随当前登录模式）。
 *
 * 语义：写入 → 读回确认 → 才返回成功。删除后重新读一次「我的歌单」，
 * 读回结果与预期不符时返回失败且不自动重试。
 *
 * 只允许删除自建歌单：收藏条目（type=1）与系统歌单（is_def 有值）一律拒绝。
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { KG_CLOUDLIST_ROUTER } = require('../core/config')
const {
  success,
  failure,
  badRequest,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { readMyLists, businessError } = require('./user_playlist_list')

const logger = createLogger('kugou')

/**
 * 删除自建歌单
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const id = String(query.id || query.listid || '').trim()
  if (!id) return badRequest('id 不能为空')

  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  let snapshot
  try {
    snapshot = await readMyLists(session)
  } catch (err) {
    logger.warn('删除歌单前读取歌单列表失败：', err.message || err)
    return upstreamError(`删除歌单失败：${err.message || err}`)
  }

  const target = snapshot.items.find((item) => String(item.listid || '') === id)
  if (!target) return failure(404, { code: 404, message: '歌单不存在' })
  if (Number(target.type || 0) !== 0) {
    return badRequest('仅支持删除自建歌单')
  }
  if (Number(target.is_def || 0) > 0) {
    return badRequest('系统歌单不允许删除')
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
        type: 0,
        listid: Number(id),
        name: target.name || '',
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
    logger.warn('删除歌单失败：', err.message || err)
    return upstreamError(`删除歌单失败：${err.message || err}`)
  }

  const error = businessError(body)
  if (error) {
    logger.warn('删除歌单失败：', error)
    return upstreamError(`删除歌单失败：${error}`)
  }

  let after
  try {
    after = await readMyLists(session)
  } catch (err) {
    logger.warn('删除歌单后读回失败：', err.message || err)
    return upstreamError(
      `删除后读回校验失败：无法读取歌单列表（${err.message || err}）`,
    )
  }

  if (after.items.some((item) => String(item.listid || '') === id)) {
    return upstreamError('删除后读回校验失败：歌单仍存在')
  }

  return success({
    code: 200,
    id,
    deleted: true,
    verified: true,
  })
}
