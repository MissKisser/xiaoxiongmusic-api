/**
 * 酷狗音乐修改歌单信息
 *
 * 走概念版云歌单新协议（协议 B）修改歌单名、简介与标签。
 *
 * 语义：写入 → 读回确认 → 才返回成功。修改后重新读一次「我的歌单」，
 * 读回结果与预期不符时返回失败且不自动重试。
 */

const { kgCloudRequest } = require('../core/request')
const { readSession } = require('../core/session')
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
 * 修改歌单名、简介与标签
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const id = String(query.id || query.listid || '').trim()
  const name = String(query.name || '').trim()
  if (!id) return badRequest('id 不能为空')
  if (!name) return badRequest('name 不能为空')

  const intro = query.intro === undefined ? undefined : String(query.intro)
  const tags = query.tags === undefined ? undefined : String(query.tags)

  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  let snapshot
  try {
    snapshot = await readMyLists(session)
  } catch (err) {
    logger.warn('修改歌单信息前读取歌单列表失败：', err.message || err)
    return upstreamError(`修改歌单信息失败：${err.message || err}`)
  }

  const target = snapshot.items.find((item) => String(item.listid || '') === id)
  if (!target) return failure(404, { code: 404, message: '歌单不存在' })
  if (Number(target.type || 0) === 1) {
    return badRequest('收藏的歌单不支持改名')
  }
  if (Number(target.is_def || 0) > 0) {
    return badRequest('系统歌单不支持改名')
  }

  const payload = {
    total_ver: snapshot.totalVer,
    listid: Number(id),
    type: Number(target.type || 0),
    sort: 0,
    name,
  }
  if (intro !== undefined) payload.intro = intro
  if (tags !== undefined) payload.tags = tags

  let body
  try {
    body = await kgCloudRequest('/v1/modify_list', payload, { session })
  } catch (err) {
    logger.warn('修改歌单信息失败：', err.message || err)
    return upstreamError(`修改歌单信息失败：${err.message || err}`)
  }

  const error = businessError(body)
  if (error) {
    logger.warn('修改歌单信息失败：', error)
    return upstreamError(`修改歌单信息失败：${error}`)
  }

  let after
  try {
    after = await readMyLists(session)
  } catch (err) {
    logger.warn('修改歌单信息后读回失败：', err.message || err)
    return upstreamError(
      `修改后读回校验失败：无法读取歌单列表（${err.message || err}）`,
    )
  }

  const updated = after.items.find((item) => String(item.listid || '') === id)
  if (!updated) {
    return upstreamError('修改后读回校验失败：歌单不存在')
  }
  if (updated.name !== name) {
    return upstreamError(`修改后读回校验失败：当前名称为 ${updated.name}`)
  }
  if (
    intro !== undefined &&
    updated.intro !== undefined &&
    updated.intro !== intro
  ) {
    return upstreamError(`修改后读回校验失败：当前简介为 ${updated.intro}`)
  }

  return success({
    code: 200,
    id,
    name: updated.name,
    verified: true,
  })
}
