/**
 * QQ 音乐：创建歌单
 *
 * 写入后读回自建歌单列表，确认新歌单存在、目录号与名称一致才返回成功。
 * 读回不符时返回失败且不自动重试，避免界面显示成功而平台没改。
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

/** 歌单名长度上限 */
const MAX_NAME_LENGTH = 20

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

module.exports = async (query = {}) => {
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

  const name = String(query.name ?? '').trim()
  if (!name) return badRequest('name required')
  if ([...name].length > MAX_NAME_LENGTH) return badRequest('歌单名最多 20 字')

  try {
    const data = await qmRequest(
      'music.musicasset.PlaylistBaseWrite',
      'AddPlaylist',
      { dirName: name },
      { session: authSession, referer: WRITE_REFERER },
    )

    if (!data || data.retCode !== 0 || !data.result) {
      logger.warn('创建歌单失败:', data && data.retCode)
      return upstreamError('创建歌单失败', { retCode: data && data.retCode })
    }

    const tid = positiveInt(data.result.tid)
    const dirId = positiveInt(data.result.dirId)
    if (!tid || !dirId) {
      return upstreamError('创建歌单返回缺少 tid/dirId')
    }

    // 读回确认：新歌单应出现在自建列表中，且目录号与名称一致
    const listData = await qmRequest(
      'music.musicasset.PlaylistBaseRead',
      'GetPlaylistByUin',
      { uin },
      { session: authSession, referer: WRITE_REFERER },
    )
    const list = (listData && listData.v_playlist) || []
    const read = list.find((item) => item && positiveInt(item.tid) === tid)
    if (!read) {
      return failure(502, {
        code: 502,
        message: '创建后读回校验失败：自建列表中未找到新歌单',
        tid,
        dirId,
      })
    }
    const readDirId = positiveInt(read.dirId)
    if (readDirId !== dirId) {
      return failure(502, {
        code: 502,
        message: '创建后读回校验失败：目录号不一致',
        tid,
        dirId,
        actualDirId: readDirId ?? 0,
      })
    }
    const readName = String(read.dirName ?? '')
    if (readName !== name) {
      return failure(502, {
        code: 502,
        message: `创建后读回校验失败：歌单名为 ${readName}`,
        tid,
        dirId,
      })
    }

    return success({ tid, dirId, name: readName, verified: true })
  } catch (err) {
    logger.error('创建歌单异常:', err && err.message)
    return upstreamError(`创建歌单失败: ${err && err.message}`)
  }
}
