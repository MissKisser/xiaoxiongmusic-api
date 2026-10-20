/**
 * 酷狗歌曲评论
 *
 * 端点：POST /mcomment/v1/cmtlist（评论池 code 决定评论对象类型）
 * - 歌曲池：fc4be23b4e972707f36b8a828a93ba8a
 * - 专辑池：94f1792c2b1c1e4b3d5f4a6a7b8c9d0e
 * - 歌单池：ca53b96f4b7d9a1e5c2f3d4b5a6e7c8d
 *
 * 酷狗边缘节点对未授权的评论路径统一返回 `Access Deny !!!` 文本，
 * 这类响应会被识别成上游异常并原样报出，不会伪造成功。
 */

const { kgGatewayRequest, kgErrorCode } = require('../core/request')
const { readSession } = require('../core/session')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 歌曲评论池 */
const COMMENT_POOL_SONG = 'fc4be23b4e972707f36b8a828a93ba8a'

/** 专辑评论池 */
const COMMENT_POOL_ALBUM = '94f1792c2b1c1e4b3d5f4a6a7b8c9d0e'

/** 歌单评论池 */
const COMMENT_POOL_PLAYLIST = 'ca53b96f4b7d9a1e5c2f3d4b5a6e7c8d'

/** 评论池与对象类型的对应关系 */
const POOL_BY_TYPE = {
  song: COMMENT_POOL_SONG,
  album: COMMENT_POOL_ALBUM,
  playlist: COMMENT_POOL_PLAYLIST,
}

/**
 * 归一化单条评论
 * @param {any} raw 原始评论条目
 * @returns {any} 对外评论对象
 */
const normalizeComment = (raw) => {
  const user = raw.user_info || raw.userInfo || {}
  const status = raw.status || {}

  return {
    id: String(raw.cid || raw.id || ''),
    content: raw.content || '',
    time: Number(raw.time || status.time || 0),
    likedCount: Number(raw.liked_count || raw.likedCount || 0),
    replyCount: Number(raw.reply_count || raw.replyCount || 0),
    parentId: String(raw.parent_id || raw.parentId || '0'),
    isAuthor: Number(raw.is_author || 0) === 1,
    isHot: Number(raw.is_hot || 0) === 1,
    user: {
      id: String(user.userid || user.user_id || ''),
      name: user.nickname || user.user_name || '',
      avatar: user.user_photo || user.avatar || '',
    },
  }
}

/**
 * 读取酷狗歌曲评论
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const id = String(
    query.id || query.hash || query.mixsongid || query.childrenid || '',
  ).trim()
  if (!id) return badRequest('id 不能为空')

  const page = Math.max(1, Number(query.page || 1) || 1)
  const pageSize = Math.max(
    1,
    Number(query.limit || query.pagesize || 20) || 20,
  )

  const type = String(query.type || 'song').toLowerCase()
  const code = String(query.code || POOL_BY_TYPE[type] || COMMENT_POOL_SONG)

  const session = readSession(query)

  let response
  try {
    response = await kgGatewayRequest(
      '/mcomment/v1/cmtlist',
      {},
      {
        method: 'POST',
        params: {
          mixsongid: id,
          need_show_image: 1,
          p: page,
          pagesize: pageSize,
          show_classify: 0,
          show_hotword_list: 0,
          extdata: '0',
          code,
        },
        headers: { 'x-router': 'mcomment.kugou.com' },
        session,
      },
    )
  } catch (err) {
    logger.warn('读取评论失败：', err.message || err)
    return upstreamError(`读取评论失败：${err.message || err}`)
  }

  if (typeof response === 'string') {
    logger.warn('酷狗评论接口返回非 JSON 文本：', response)
    const denied = /access\s*deny/i.test(response)
    return upstreamError(
      denied
        ? '酷狗评论服务未对当前客户端开放（返回 Access Deny）'
        : '酷狗评论接口返回非预期内容',
      { raw: response },
    )
  }

  const code2 = kgErrorCode(response)
  if (code2 !== 0) {
    const message = response.errmsg || response.msg || response.error || ''
    return upstreamError(
      `酷狗评论接口返回错误：error_code=${code2} ${message}`.trim(),
      {
        raw: response,
      },
    )
  }

  const data = response.data || {}
  const list = Array.isArray(data.list)
    ? data.list
    : Array.isArray(data.info)
      ? data.info
      : []
  const hotword = Array.isArray(data.hotword_list) ? data.hotword_list : []

  return success({
    code: 200,
    id,
    type,
    page,
    pageSize,
    total: Number(data.total || data.count || list.length),
    count: list.length,
    comments: list.map(normalizeComment),
    hotwords: hotword.map((word) => ({
      id: String(word.id || ''),
      word: word.word || word.hot_word || '',
      count: Number(word.count || 0),
    })),
    raw: response,
  })
}
