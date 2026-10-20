/**
 * QQ 音乐：单曲播放地址
 *
 * 走 vkey 协议解析直链，一次请求带上所有候选音质档位的文件名，
 * 按「首选档位 → 更低档位」的顺序取第一个命中的即为最高可用音质。
 *
 * 两个必须注意的点：
 * - vkey 的文件名形如 `{档位前缀}{base}{扩展名}`，base 取自候选列表：
 *   首选**媒体 mid 单个**（`file.media_mid`），兜底**歌曲 mid×2**。
 *   不能只用歌曲 mid 单个 —— 上游会回非空直链但实际下载 404。
 * - 付费 / VIP 歌曲对无权限账号返回空直链，此时按失败原因分级返回
 *   403 或 502，而不是笼统的「无法获取播放链接」。
 *
 * 返回体用 `available` 表达「有没有可播地址」，
 * `level` / `label` 表达音质档位，`isFallback` 表达是否降级。
 */

const { qmRequest } = require('../core/request')
const { requestSongUrl } = require('../core/song_url')
const { readSession } = require('../core/credential')
const {
  success,
  failure,
  unauthorized,
  badRequest,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 失败原因到 HTTP 状态与文案的映射
 *
 * `need_pay` 与 `no_authorization` 都是「账号没权限」，区别在于歌曲本身是否付费，
 * 前者要提示用户换歌或开通会员，后者提示账号状态异常。
 * @type {Record<string, { status: number, message: string }>}
 */
const REASON_RESPONSES = {
  need_pay: {
    status: 403,
    message: '该歌曲为付费歌曲，当前账号无播放权限',
  },
  no_authorization: {
    status: 403,
    message: '当前账号没有该歌曲的播放权限',
  },
  filename_rejected: {
    status: 502,
    message: '上游未接受播放文件名',
  },
  vkey_error: {
    status: 502,
    message: '上游播放凭证接口返回异常',
  },
}

/**
 * 未识别原因的兜底响应
 * @type {{ status: number, message: string }}
 */
const DEFAULT_FAILURE = {
  status: 502,
  message: '上游播放凭证接口返回异常',
}

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
 * 解析歌曲的 mid、媒体 mid 与付费标记
 *
 * 付费标记来自同一次详情响应，不额外增加网络请求；它决定了失败原因
 * 能否区分「歌曲需付费」与「免费歌却无授权」。
 * @param {string} value 歌曲 mid 或数字歌曲 ID
 * @param {{ uin: string, cookies: Record<string, string> } | null} session 登录凭据
 * @returns {Promise<{ mid: string, mediaMid: string, payPlay: number | undefined }>} 歌曲标识与付费标记
 */
const resolveSong = async (value, session) => {
  const text = String(value).trim()
  const isNumeric = /^\d+$/.test(text) && text.length <= 15

  const detail = await qmRequest(
    'music.pf_song_detail_svr',
    'get_song_detail_yqq',
    isNumeric
      ? { song_num: 1, song_id: Number(text) }
      : { song_type: 0, song_mid: text },
    { session: session || null },
  )

  const track = pickTrack(detail)
  if (!track) return { mid: text, mediaMid: '', payPlay: undefined }

  const pay = track.pay || {}
  const payPlay =
    pay.pay_play !== undefined
      ? Number(pay.pay_play)
      : pay.payplay !== undefined
        ? Number(pay.payplay)
        : undefined

  return {
    mid: track.mid || text,
    mediaMid: (track.file && track.file.media_mid) || '',
    payPlay,
  }
}

module.exports = async (query = {}) => {
  const raw = String(query.mid ?? query.song_mid ?? query.id ?? '').trim()
  if (!raw) return badRequest('mid required')

  const session = readSession(query)
  if (!session) return unauthorized('需要登录')

  const cookies =
    typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : session.cookies || {}
  const uin = String(
    session.uin || cookies.qm_str_musicid || cookies.uin || cookies.wxuin || '',
  ).replace(/^o/, '')
  if (!uin || uin === '0') return unauthorized('需要登录')

  const level = String(query.level ?? query.quality ?? 'hq')
  const givenMediaMid = String(query.mediaMid ?? query.media_mid ?? '').trim()

  try {
    // 详情请求同时提供 mid、媒体 mid 与付费标记，失败原因分级依赖付费标记
    const resolved = await resolveSong(raw, session)
    const songMid = resolved.mid || raw
    const mediaMid = givenMediaMid || resolved.mediaMid

    const result = await requestSongUrl({
      mid: songMid,
      mediaMid,
      level,
      uin,
      cookies,
      payPlay: resolved.payPlay,
    })

    if (!result.ok) {
      const mapped = REASON_RESPONSES[result.reason] || DEFAULT_FAILURE
      return failure(mapped.status, {
        code: mapped.status,
        message: mapped.message,
        mid: songMid,
        available: false,
        reason: result.reason,
        triedLevels: result.triedLevels || [],
        vkeyResults: result.vkeyResults || [],
        raw: result.raw,
      })
    }

    return success({
      mid: songMid,
      available: true,
      url: result.url,
      level: result.level,
      label: result.label,
      format: result.format,
      isFallback: result.isFallback,
      triedLevels: result.triedLevels || [],
      raw: result.raw,
    })
  } catch (err) {
    logger.error('解析播放地址异常:', err && err.message)
    return upstreamError(`解析播放地址失败: ${err && err.message}`)
  }
}
