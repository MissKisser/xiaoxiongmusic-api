/**
 * QQ 音乐：歌曲评论
 *
 * 按歌曲取评论。`type` 为 `hot` 时取热门评论，为 `new` 时按时间取最新评论。
 * 游标翻页用 `cursor` 传入上一次的 `nextCursor`。
 *
 * 评论接口的业务主键是**数字歌曲 ID**，不是歌曲 mid：
 * 直接把 mid 填进 `BizId` 会被接口判为无效（返回空列表）。
 * 因此传入 mid 时先经歌曲详情接口换算出数字 ID 再查评论；
 * 调用方直接传数字 ID 时则跳过换算，少一次请求。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 从歌曲详情响应中取出歌曲主体
 * @param {Record<string, any>} data 接口返回的数据段
 * @returns {Record<string, any> | null} 歌曲主体
 */
const pickTrack = (data) => {
  if (!data) return null
  if (data.track_info) return data.track_info
  if (data.song_info) return data.song_info
  if (Array.isArray(data.songs) && data.songs[0]) return data.songs[0]
  if (data.songid || data.mid) return data
  return null
}

/**
 * 归一化评论条目
 *
 * 上游字段是大驼峰，这里统一转成小驼峰。
 * @param {Record<string, any>} item 接口返回的评论
 * @returns {Record<string, any>} 归一化后的评论
 */
const normalizeComment = (item) => {
  const source = item || {}

  return {
    id: source.CmId ?? '',
    content: source.Content ?? '',
    nick: source.Nick ?? '',
    avatar: source.Avatar ?? '',
    location: source.Location ?? '',
    pic: source.Pic ?? '',
    encryptedUin: source.EncryptUin ?? '',
    praiseNum: source.PraiseNum ?? 0,
    replyCount: source.ReplyCnt ?? 0,
    publishTime: source.PubTime ?? 0,
    seqNo: source.SeqNo ?? '',
    songId: source.SongId ?? '',
    replies: (source.RepliedComments || []).map(normalizeComment),
    subComments: (source.SubComments || []).map(normalizeComment),
  }
}

/**
 * 解析歌曲的数字 ID
 *
 * 传入的已是数字 ID 时直接返回；传入 mid 时用歌曲详情接口换算。
 * @param {string} value 歌曲 mid 或数字 ID
 * @param {{ uin: string, cookies: Record<string, string> } | null} session 登录凭据
 * @returns {Promise<string>} 数字歌曲 ID，解析不出来时返回空串
 */
const resolveSongId = async (value, session) => {
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return text

  const detail = await qmRequest(
    'music.pf_song_detail_svr',
    'get_song_detail_yqq',
    { song_type: 0, song_mid: text },
    { session: session || null },
  )
  const track = pickTrack(detail)
  return track ? String(track.id ?? '') : ''
}

module.exports = async (query = {}) => {
  const raw = String(query.mid ?? query.song_mid ?? query.id ?? '').trim()
  if (!raw) return badRequest('id required')

  const type = query.type === 'new' ? 'new' : 'hot'
  const page = Math.max(1, Number(query.page ?? 1) || 1)
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20) || 20))
  const cursor = String(query.cursor ?? '')
  const session = readSession(query)

  try {
    const songId = await resolveSongId(raw, session)
    if (!songId) {
      return upstreamError(`解析歌曲 ID 失败: ${raw}`)
    }

    const param = {
      BizType: 1,
      BizId: songId,
      LastCommentSeqNo: cursor,
      PageSize: limit,
      PageNum: page - 1,
      PicEnable: 1,
      ...(type === 'hot'
        ? { HotType: 1, WithAirborne: 0 }
        : { HashTagID: '', SelfSeeEnable: 1, AudioEnable: 1 }),
    }

    const data = await qmRequest(
      'music.globalComment.CommentRead',
      type === 'hot' ? 'GetHotCommentList' : 'GetNewCommentList',
      param,
      { session: session || null },
    )

    const list = (data && data.CommentList) || {}
    const comments = (list.Comments || []).map(normalizeComment)
    const hasMore = list.HasMore === 1

    return success({
      id: songId,
      mid: /^\d+$/.test(raw) ? '' : raw,
      type,
      page,
      total: list.Total ?? comments.length,
      hasMore,
      nextCursor: hasMore
        ? comments.length > 0
          ? comments[comments.length - 1].seqNo
          : ''
        : '',
      comments,
      raw: data,
    })
  } catch (err) {
    logger.error('读取歌曲评论异常:', err && err.message)
    return upstreamError(`读取歌曲评论失败: ${err && err.message}`)
  }
}
