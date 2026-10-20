/**
 * QQ 音乐：收藏状态
 *
 * 查询歌单 / 专辑 / 歌曲是否被当前账号收藏。
 * 默认查询歌单，`type` 可取 `playlist`、`album`、`song`。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  badRequest,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 解析待查询的 id 列表
 * @param {unknown} raw 逗号分隔字符串或数组
 * @returns {string[]} id 列表
 */
const parseIds = (raw) => {
  const items = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  return items.map((item) => String(item).trim()).filter(Boolean)
}

module.exports = async (query = {}) => {
  const type = String(query.type ?? 'playlist').toLowerCase()
  const ids = parseIds(query.ids)
  if (ids.length === 0) return badRequest('ids required')
  if (!['playlist', 'album', 'song'].includes(type)) {
    return badRequest(`unsupported type: ${type}`)
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
  if (!uin || uin === '0') return unauthorized('未登录 QQ 音乐账号')

  const authSession = { ...session, uin, cookies }

  try {
    let module = ''
    let method = ''
    let param = {}

    if (type === 'playlist') {
      module = 'music.musicasset.PlaylistFavRead'
      method = 'IsPlaylistFan'
      param = { uin, v_tid: ids.map(Number) }
    } else if (type === 'album') {
      module = 'music.musicasset.AlbumFavRead'
      method = 'IsAlbumFan'
      param = { uin, v_albumMid: ids }
    } else {
      module = 'music.musicasset.SongFavRead'
      method = 'IsSongFanByMid'
      param = { v_songMid: ids }
    }

    const data = await qmRequest(module, method, param, {
      session: authSession,
    })
    const mFan = (data && data.m_fan) || {}

    return success({
      type,
      items: ids.map((id) => ({
        id,
        status: mFan[id] ? 'subscribed' : 'not-subscribed',
      })),
    })
  } catch (err) {
    logger.error('查询收藏状态异常:', err && err.message)
    return upstreamError(`查询收藏状态失败: ${err && err.message}`)
  }
}
