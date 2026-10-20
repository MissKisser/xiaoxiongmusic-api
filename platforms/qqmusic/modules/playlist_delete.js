/**
 * QQ 音乐：删除歌单
 *
 * 只允许删除自建的普通目录：系统目录（`dirId >= 200`）与收藏目录一律拒绝。
 * 写完读回自建列表，确认歌单已不在列表中才返回成功。
 */

const { qmRequest } = require('../core/request')
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
 * 写入类接口要求的 Referer
 *
 * QQ 音乐对写接口校验来源：`https://y.qq.com`（无尾斜杠）会被判为非法来源，
 * 写接口统一返回 inner=1000 / authorize fail；带尾斜杠的 `https://y.qq.com/` 才能写入。
 */
const WRITE_REFERER = 'https://y.qq.com/'

/** 系统目录的目录号下限，`dirId >= 200` 为系统目录，不可删除 */
const SYSTEM_DIR_ID_MIN = 200

/**
 * 把接口返回的标识字段解析为正整数
 * @param {unknown} value 原始值
 * @returns {number | undefined} 合法正整数，非法时返回 undefined
 */
const positiveInt = (value) => {
  const num =
    typeof value === 'string' && /^\d{1,15}$/.test(value)
      ? Number(value)
      : value
  return typeof num === 'number' && Number.isSafeInteger(num) && num > 0
    ? num
    : undefined
}

/**
 * 从自建歌单列表中定位某个 tid 对应的普通目录
 * @param {Record<string, any>[]} list 自建 + 收藏歌单列表
 * @param {number} tid 歌单 tid
 * @returns {{ dirId: number } | { error: string }} 目录号或拒绝原因
 */
const findOwnedDirId = (list, tid) => {
  const matches = (list || []).filter(
    (item) => item && positiveInt(item.tid) === tid,
  )
  if (matches.length !== 1) {
    return { error: `歌单 ${tid} 在自建列表中不唯一` }
  }
  const entry = matches[0]
  const dirId = positiveInt(entry.dirId)
  if (!dirId) return { error: `歌单 ${tid} 缺少 dirId` }
  if (entry.dirType !== undefined && entry.dirType !== 0) {
    return { error: `歌单 ${tid} 不是自建目录，拒绝写入` }
  }
  if (dirId >= SYSTEM_DIR_ID_MIN) {
    return { error: `歌单 ${tid} 是系统目录，拒绝删除` }
  }
  return { dirId }
}

module.exports = async (query = {}) => {
  const rawTid = positiveInt(query.tid)

  // 系统目录不可删除，调用方直接给出 dirId 时先就地拒绝
  const explicitDirId = positiveInt(query.dirId)
  if (explicitDirId && explicitDirId >= SYSTEM_DIR_ID_MIN) {
    return badRequest(`目录 ${explicitDirId} 是系统目录，拒绝删除`)
  }

  const session = readSession(query)
  if (!session) return unauthorized('未登录 QQ 音乐账号')

  const cookies =
    typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : session.cookies || {}
  const uin = String(
    session.uin || cookies.qm_str_musicid || cookies.uin || cookies.wxuin || '',
  ).replace(/^o/, '')
  const hasKey = !!(
    cookies.qm_keyst ||
    cookies.qqmusic_key ||
    cookies.pskey ||
    cookies.p_skey ||
    cookies.skey
  )
  if (!uin || uin === '0' || !hasKey) {
    return unauthorized('未登录 QQ 音乐账号')
  }

  const authSession = { ...session, uin, cookies }

  const tid = rawTid
  if (!tid) return badRequest('tid required')

  try {
    // 定位歌单的目录号：调用方给了 dirId 就直接用，否则从自建列表里找
    let dirId = explicitDirId
    if (!dirId) {
      const listData = await qmRequest(
        'music.musicasset.PlaylistBaseRead',
        'GetPlaylistByUin',
        { uin },
        { session: authSession, referer: WRITE_REFERER },
      )
      const located = findOwnedDirId(
        (listData && listData.v_playlist) || [],
        tid,
      )
      if (located.error) return badRequest(located.error)
      dirId = located.dirId
    }

    const data = await qmRequest(
      'music.musicasset.PlaylistBaseWrite',
      'DelPlaylist',
      { dirId },
      { session: authSession, referer: WRITE_REFERER },
    )

    if (!data || data.retCode !== 0 || !data.result) {
      logger.warn('删除歌单失败:', data && data.retCode)
      return upstreamError('删除歌单失败', { retCode: data && data.retCode })
    }
    if (
      positiveInt(data.result.dirId) !== dirId ||
      positiveInt(data.result.tid) !== tid
    ) {
      return upstreamError('删除返回的 tid/dirId 不匹配')
    }

    // 读回确认：歌单应已不在列表中
    const listData = await qmRequest(
      'music.musicasset.PlaylistBaseRead',
      'GetPlaylistByUin',
      { uin },
      { session: authSession, referer: WRITE_REFERER },
    )
    const still = ((listData && listData.v_playlist) || []).find(
      (item) => item && positiveInt(item.tid) === tid,
    )
    if (still) {
      return failure(502, {
        code: 502,
        message: '删除后读回校验失败：歌单仍存在',
        tid,
        dirId,
      })
    }

    return success({ tid, dirId, deleted: true, verified: true })
  } catch (err) {
    logger.error('删除歌单异常:', err && err.message)
    return upstreamError(`删除歌单失败: ${err && err.message}`)
  }
}
