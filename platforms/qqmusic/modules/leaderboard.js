/**
 * QQ 音乐排行榜
 *
 * 走 `musicToplist.ToplistInfoServer` / `GetDetail`：
 * - `data.data` 是榜单元信息（标题、期数、封面、榜单简介）
 * - `data.songInfoList` 是榜单歌曲明细
 * - `data.data.song` 是带排名的精简列表
 *
 * 常用榜单号：26 热歌榜 / 62 飙升榜 / 27 新歌榜 / 4 原创榜。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { success, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 默认榜单号
 * @type {number}
 */
const DEFAULT_TOPID = 26

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
 * 归一化榜单歌曲
 * @param {any} song 接口返回的歌曲
 * @returns {Record<string, any>} 归一化后的歌曲
 */
const normalizeSong = (song) => {
  const source = song || {}
  const album = source.album || {}
  return {
    id: String(source.id ?? ''),
    mid: source.mid ?? '',
    name: stripHighlight(source.title || source.name || ''),
    artist: formatSingerName(source.singer),
    artists: (Array.isArray(source.singer) ? source.singer : []).map(
      (item) => ({
        id: String((item && item.id) ?? ''),
        mid: (item && item.mid) ?? '',
        name: stripHighlight((item && item.name) ?? ''),
      }),
    ),
    album: stripHighlight(album.name ?? ''),
    albumMid: album.mid ?? '',
    duration: (source.interval ?? 0) * 1000,
    file: source.file ?? {},
    pay: source.pay ?? {},
  }
}

/**
 * 归一化榜单排名条目
 * @param {any} item 接口返回的排名条目
 * @returns {Record<string, any>} 归一化后的排名条目
 */
const normalizeRank = (item) => {
  const source = item || {}
  return {
    rank: source.rank ?? 0,
    songId: String(source.songId ?? ''),
    title: stripHighlight(source.title ?? ''),
    singer: stripHighlight(source.singerName ?? ''),
    singerMid: source.singerMid ?? '',
    albumMid: source.albumMid ?? '',
    cover: source.cover ?? '',
  }
}

module.exports = async (query = {}) => {
  const topid =
    Number(query.topid ?? query.id ?? DEFAULT_TOPID) || DEFAULT_TOPID
  const period = String(query.period ?? '')
  const limit = Math.max(1, Number(query.limit) || 50)
  const offset = Math.max(0, Number(query.offset) || 0)
  const session = readSession(query)

  try {
    const data =
      (await qmRequest(
        'musicToplist.ToplistInfoServer',
        'GetDetail',
        { topid, num: limit, offset, period },
        { session },
      )) || {}

    const meta = data.data || {}
    const songs = (data.songInfoList || [])
      .map((item) => item && (item.songInfo || item))
      .filter(Boolean)
      .map(normalizeSong)
    const ranks = (meta.song || []).map(normalizeRank)

    return success({
      topid,
      title: meta.title ?? data.title ?? '',
      subTitle: meta.titleDetail ?? data.titleDetail ?? '',
      updateTime: meta.updateTime ?? data.updateTime ?? '',
      period: meta.period ?? '',
      intro: meta.intro ?? '',
      cover: meta.headPicUrl ?? data.headPicUrl ?? '',
      listenCount: meta.listenNum ?? 0,
      total: meta.totalNum ?? songs.length,
      songs,
      ranks,
      raw: data,
    })
  } catch (err) {
    logger.error('QQ 音乐排行榜获取异常:', err && err.message)
    return upstreamError(`QQ 音乐排行榜获取失败: ${err && err.message}`)
  }
}
