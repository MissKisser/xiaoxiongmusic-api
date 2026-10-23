/**
 * QQ 音乐每日推荐歌单（官方客户端叫「今日推荐歌曲」，也叫「每日30首」）
 *
 * 走 `music.ai_track_daily_svr` / `get_daily_track`，参数 `{ id: 99, cmd: 0, page: 1 }`：
 * - `id` 取 99 是上游约定的「每日推荐」档位，实测 0 / 1 / 99 三种取值返回完全一致
 * - 响应形状是 `{ title, picurl, isnew, page, tracks[], date, subcode }`
 * - `title` 恒为「今日推荐歌曲」，`picurl` 是每日推荐的固定封面，
 *   `date` 是当天的日期串（如 `20261023`），`tracks[]` 固定 30 首
 *
 * ## 与网易云「每日推荐歌单」的差异（桌面端须知）
 *
 * 网易云的每日推荐是**真实歌单**，有歌单号，能走 `/playlist/detail` 取曲目。
 * QQ 音乐这边**不存在对应的歌单号**：
 * - 客户端二进制里与每日推荐相关的协议只有 `ai_track_daily_svr` / `get_daily_track`
 *   （另有一个 `DeleteDailySong` 写协议），没有任何「每日推荐歌单」查询协议
 * - `music.srfDissInfo.aiDissInfo` / `music.recommend.DailySong` /
 *   `music.playlist.PlayListDetailRead` 等可能承载歌单号的接口，
 *   实测分别返回 inner=40000 / 500003，无法定位到每日推荐歌单
 * - `music.musicasset.PlaylistBaseRead.GetPlaylistByUin`（我的歌单）与
 *   `music.musicasset.PlaylistFavRead.GetPlaylistFavInfo`（收藏歌单）实测都不含每日推荐条目
 *
 * 因此本模块对外给出的是**按日期生成的稳定定位键**（`id` = `daily-<date>`）
 * 加上上游下发的名称与封面；曲目随定位信息一并给出，
 * 因为平台侧不存在可供「既有歌单接口」消费的每日推荐歌单号。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/session')
const {
  success,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/** 每日推荐协议档位（上游约定值，0 / 1 / 99 实测等价） */
const DAILY_TRACK_ID = 99

/** 每日推荐封面尺寸模板 */
const COVER_TEMPLATE = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000'

/**
 * 去掉搜索结果的命中高亮标签
 * @param {any} text 原始文本
 * @returns {string} 处理后的文本
 */
const stripHighlight = (text) =>
  typeof text === 'string' ? text.replace(/<\/?em>/g, '') : ''

/**
 * 拼接歌手名
 * @param {any} singers 歌手数组
 * @returns {string} 形如 `A / B` 的歌手名
 */
const formatSingerName = (singers) => {
  if (!Array.isArray(singers)) return ''
  return singers
    .map((item) => stripHighlight(item && item.name))
    .filter(Boolean)
    .join(' / ')
}

/**
 * 归一化每日推荐曲目
 *
 * 字段口径与本平台刷歌模块（`songfm.js`）保持一致：
 * `duration` 是毫秒、`artists[]` 是歌手条目数组、`cover` 取专辑封面。
 * @param {any} track 上游曲目
 * @returns {Record<string, any> | null} 归一化后的曲目，缺少可播放标识时为 null
 */
const normalizeTrack = (track) => {
  const source = track || {}
  const songId = Number(source.id ?? 0)
  const mid = source.mid ?? ''
  if (!songId && !mid) return null

  const album = source.album || {}
  const albumMid = album.mid || album.pmid || ''

  return {
    id: String(songId),
    mid: String(mid),
    name: stripHighlight(source.title || source.name || ''),
    artist: formatSingerName(source.singer),
    artists: (Array.isArray(source.singer) ? source.singer : []).map(
      (item) => ({
        id: String((item && item.id) ?? ''),
        mid: String((item && item.mid) ?? ''),
        name: stripHighlight((item && item.name) ?? ''),
      }),
    ),
    album: stripHighlight(album.name || album.title || ''),
    albumMid: String(albumMid),
    duration: (Number(source.interval) || 0) * 1000,
    cover: albumMid ? `${COVER_TEMPLATE}${albumMid}.jpg` : '',
    file: source.file ?? {},
    pay: source.pay ?? {},
  }
}

/**
 * 把上游日期串整理成 `YYYYMMDD`
 * @param {any} date 上游日期字段
 * @returns {string} 日期串，取不到时返回空串
 */
const normalizeDate = (date) => {
  const text = String(date ?? '').trim()
  return /^\d{8}$/.test(text) ? text : ''
}

module.exports = async (query = {}) => {
  const session = readSession(query)
  if (!session) return unauthorized('未登录 QQ 音乐账号')

  try {
    const data = await qmRequest(
      'music.ai_track_daily_svr',
      'get_daily_track',
      { id: DAILY_TRACK_ID, cmd: 0, page: 1 },
      { session },
    )

    const source = data || {}
    const tracks = Array.isArray(source.tracks) ? source.tracks : []
    const songs = tracks.map(normalizeTrack).filter(Boolean)
    const date = normalizeDate(source.date)

    if (!songs.length) {
      return upstreamError('QQ 音乐每日推荐返回空曲目')
    }

    return success({
      code: 200,
      /** 平台无每日推荐歌单号，这里给按日期生成的稳定定位键 */
      id: date ? `daily-${date}` : 'daily',
      name: stripHighlight(source.title || '今日推荐歌曲'),
      cover: stripHighlight(source.picurl || ''),
      count: songs.length,
      date,
      isNew: Number(source.isnew) === 1,
      source: 'ai_track_daily_svr',
      songs,
    })
  } catch (err) {
    logger.error('QQ 音乐每日推荐获取异常:', err && err.message)
    return upstreamError(`QQ 音乐每日推荐获取失败: ${err && err.message}`)
  }
}
