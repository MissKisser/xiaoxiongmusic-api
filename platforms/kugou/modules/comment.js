/**
 * 酷狗评论
 *
 * 端点：POST /mcomment/v1/cmtlist（评论池 code 决定评论对象类型）
 * - 歌曲池：fc4be23b4e972707f36b8a828a93ba8a
 * - 专辑池：94f1792ced1df89aa68a7939eaf2efca
 * - 歌单池：ca53b96fe5a1d9c22d71c8f522ef7c4f
 *
 * 关键口径（均为实网验证，详见小熊音乐工作区 docs/ops/KUGOU-COMMENT-RESEARCH.md）：
 * - **不要发送 `x-router` 头**。带 `x-router: mcomment.kugou.com` 会被网关转发到不
 *   接受该 path 前缀的服务，直接回 `Access Deny !!!`。社区实现（含 MakcRe/KuGouMusicApi、
 *   Linsxyx/KugouMusic.NET、Ion-nsx/Kugoumusic-web 等十余家）一律不发该头。
 * - `mixsongid` 必须是 **album_audio_id**（如《晴天》= 32100650），传 audio_id 会得到
 *   `err_code 10002 参数错误`，传 FileHash 直接 HTTP 400。
 * - 响应没有 `data` 包装：`list` / `count` / `current_page` / `hot_word_list` 都在顶层。
 * - 错误码字段是 `err_code`（不是 `error_code`）。
 * - 匿名即可访问，凭据非必需。
 */

const { kgGatewayRequest, kgErrorCode } = require('../core/request')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 歌曲评论池 */
const COMMENT_POOL_SONG = 'fc4be23b4e972707f36b8a828a93ba8a'

/** 专辑评论池 */
const COMMENT_POOL_ALBUM = '94f1792ced1df89aa68a7939eaf2efca'

/** 歌单评论池 */
const COMMENT_POOL_PLAYLIST = 'ca53b96fe5a1d9c22d71c8f522ef7c4f'

/** 评论池与对象类型的对应关系 */
const POOL_BY_TYPE = {
  song: COMMENT_POOL_SONG,
  album: COMMENT_POOL_ALBUM,
  playlist: COMMENT_POOL_PLAYLIST,
}

/**
 * 解析评论对象 id（album_audio_id 口径）
 *
 * 该 id 在不同来源里叫法不一：`mixsongid`（社区口径）、`album_audio_id`（网关返回）、
 * `albumAudioId`（本仓库 search 模块的归一化字段）、`extId`（桌面端歌曲对象的字段）。
 * @param {any} query 调用参数
 * @returns {string} 解析出的 id，取不到时返回空串
 */
const resolveMixSongId = (query) => {
  const candidates = [
    query?.mixsongid,
    query?.mixSongId,
    query?.albumAudioId,
    query?.album_audio_id,
    query?.extId,
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue
    const text = String(candidate).trim()
    if (text) return text
  }
  return ''
}

/**
 * 归一化单条评论
 * @param {any} raw 原始评论条目
 * @returns {any} 对外评论对象
 */
const normalizeComment = (raw) => {
  const source = raw || {}
  const like = source.like || {}
  const user = {
    id: String(source.user_id ?? ''),
    name: source.user_name ?? '',
    avatar: source.user_pic ?? '',
  }

  return {
    id: String(source.id ?? ''),
    content: source.content ?? '',
    /** 发表评论时间，格式 `YYYY-MM-DD HH:mm:ss` */
    time: source.addtime ?? '',
    likedCount: Number(like.count ?? like.likenum ?? 0),
    replyCount: Number(source.reply_num ?? 0),
    /** 父评论 id（顶层评论为 0） */
    parentId: String(source.delPid ?? 0),
    /** 父评论者 id */
    parentUserId: String(source.puser_id ?? 0),
    /** 是否为该歌曲的「音乐达人」点评（接口用 author_name 非空表示） */
    isAuthor: Boolean(source.author_name),
    user,
    /** 附图 */
    images: Array.isArray(source.images)
      ? source.images.map((image) => ({
          url: image?.url ?? '',
          width: image?.width ?? 0,
          height: image?.height ?? 0,
        }))
      : [],
    /** 楼中楼回复 */
    replies: Array.isArray(source.replys)
      ? source.replys.map(normalizeComment)
      : [],
    /** 归属地 */
    location: source.location ?? '',
  }
}

/**
 * 读取酷狗评论
 * @param {Record<string, any>} [query] 调用参数
 * @param {string} [query.mixsongid] 评论对象 id（album_audio_id 口径）
 * @param {string} [query.type] 评论对象类型：song / album / playlist
 * @param {number} [query.page] 页码，从 1 开始
 * @param {number} [query.limit] 每页条数
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const id = resolveMixSongId(query)
  if (!id) {
    return badRequest(
      'id required：酷狗评论需要 album_audio_id 口径的 id（字段名可用 mixsongid / mixSongId / albumAudioId / album_audio_id / extId）',
    )
  }

  const page = Math.max(1, Number(query.page || 1) || 1)
  const pageSize = Math.max(
    1,
    Number(query.limit || query.pagesize || 30) || 30,
  )
  const type = String(query.type || 'song').toLowerCase()
  const code = String(query.code || POOL_BY_TYPE[type] || COMMENT_POOL_SONG)

  let response
  try {
    response = await kgGatewayRequest(
      '/mcomment/v1/cmtlist',
      {},
      {
        method: 'POST',
        params: {
          ver: 6,
          mixsongid: id,
          need_show_image: 1,
          p: page,
          pagesize: pageSize,
          show_classify: 1,
          show_hotword_list: 1,
          extdata: '0',
          code,
        },
        // 注意：此处**不能**加 x-router，加了会被网关判为路径未授权并回 Access Deny
      },
    )
  } catch (err) {
    logger.warn('读取酷狗评论失败：', err.message || err)
    return upstreamError(`读取酷狗评论失败：${err.message || err}`)
  }

  if (typeof response === 'string') {
    logger.warn('酷狗评论接口返回非 JSON 文本：', response)
    return upstreamError('酷狗评论接口返回非预期内容', { raw: response })
  }

  const errCode = kgErrorCode(response)
  if (errCode !== 0) {
    const message = response.errmsg || response.msg || response.message || ''
    // 10002 是「参数错误」：绝大多数情况是 id 口径不对（传了 audio_id 而不是 album_audio_id）
    const hint =
      errCode === 10002
        ? '；id 口径可能不对，需要 album_audio_id 而不是 audio_id'
        : ''
    return upstreamError(
      `酷狗评论接口返回错误：error_code=${errCode} ${message}${hint}`.trim(),
      {
        raw: response,
      },
    )
  }

  const list = Array.isArray(response.list) ? response.list : []
  const hotwords = Array.isArray(response.hot_word_list)
    ? response.hot_word_list
    : []
  const classify = Array.isArray(response.classify_list)
    ? response.classify_list
    : []

  return success({
    id,
    type,
    page,
    pageSize,
    /** 该评论对象的评论总数 */
    total: Number(response.count ?? list.length),
    /** 当前页条数 */
    count: list.length,
    /** 总页数 */
    maxPage: Number(response.maxPage ?? 0),
    comments: list.map(normalizeComment),
    /** 热词榜 */
    hotwords: hotwords.map((word) => ({
      id: String(word.id ?? ''),
      word: word.word ?? '',
      count: Number(word.count ?? 0),
    })),
    /** 评论分类 */
    categories: classify.map((item) => ({
      id: String(item.id ?? item.class_id ?? ''),
      name: item.name ?? item.class_name ?? '',
      count: Number(item.count ?? 0),
    })),
    raw: response,
  })
}
