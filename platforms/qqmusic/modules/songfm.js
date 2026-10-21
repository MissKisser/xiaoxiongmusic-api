/**
 * QQ 音乐推荐流（对应网易云「私人 FM」的刷歌能力）
 *
 * 走 `music.recommend.RecommendFeed` / `get_recommend_feed`：
 * 上游按「货架」下发个性化推荐，返回结构是
 * `v_shelf[].v_niche[].v_card[]`，其中 `type === 200` 的卡片是单曲条目
 * （`id` 为歌曲数字 id、`title` 为歌名、`subtitle` 为歌手、`cover` 为封面）。
 *
 * 两个关键口径：
 * - 卡片里的 `subid` **不是歌曲 mid**（上游的推荐条目 id），不能用于播放与歌词；
 *   真实 mid / 时长 / 专辑 / 付费标记要按歌曲数字 id 回查
 *   `music.pf_song_detail_svr` / `get_song_detail_yqq`（单次只能查一首）。
 * - 推荐流是**实时**接口，每次调用返回的曲目基本不同，
 *   因此接口层不做任何跨请求缓存。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { success, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 单次推荐流默认取回的曲目数
 * @type {number}
 */
const DEFAULT_LIMIT = 20

/**
 * 单次推荐流最多回查详情的曲目数（每首一次请求，控制在可接受范围内）
 * @type {number}
 */
const MAX_DETAIL_FETCH = 20

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
 * 归一化推荐流中的单曲卡片
 * @param {any} card 上游卡片
 * @returns {Record<string, any> | null} 归一化后的推荐条目
 */
const normalizeCard = (card) => {
  const source = card || {}
  const songId = Number(source.id ?? 0)
  if (!songId) return null
  return {
    id: String(songId),
    name: stripHighlight(source.title ?? ''),
    artist: stripHighlight(source.subtitle ?? ''),
    cover: source.cover ?? '',
  }
}

/**
 * 按歌曲数字 id 回查歌曲详情（mid / 时长 / 专辑 / 付费标记）
 * @param {number} songId 歌曲数字 id
 * @param {any} session 登录凭据
 * @returns {Promise<any>} 歌曲详情；查不到时返回 null
 */
const fetchSongDetail = async (songId, session) => {
  const data = await qmRequest(
    'music.pf_song_detail_svr',
    'get_song_detail_yqq',
    { song_num: 1, song_id: songId },
    { session },
  )
  const track = (data && (data.track_info || data.song_info)) || null
  return track && (track.mid || track.id) ? track : null
}

/**
 * 归一化歌曲详情为推荐流曲目
 * @param {any} track 歌曲详情
 * @param {Record<string, any>} fallback 卡片兜底信息
 * @returns {Record<string, any>} 归一化后的曲目
 */
const normalizeTrack = (track, fallback) => {
  const album = (track && track.album) || {}
  const pictureMid = album.mid || album.pmid || ''
  return {
    id: String((track && track.id) ?? fallback.id ?? ''),
    mid: (track && track.mid) ?? '',
    name: stripHighlight(
      (track && (track.title || track.name)) || fallback.name || '',
    ),
    artist: formatSingerName(track && track.singer) || fallback.artist || '',
    artists: (Array.isArray(track && track.singer) ? track.singer : []).map(
      (item) => ({
        id: String((item && item.id) ?? ''),
        mid: (item && item.mid) ?? '',
        name: stripHighlight((item && item.name) ?? ''),
      }),
    ),
    album: stripHighlight(album.name ?? ''),
    albumMid: pictureMid,
    duration: ((track && track.interval) ?? 0) * 1000,
    cover:
      fallback.cover ||
      (pictureMid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pictureMid}.jpg`
        : ''),
    file: (track && track.file) ?? {},
    pay: (track && track.pay) ?? {},
  }
}

module.exports = async (query = {}) => {
  const limit = Math.min(
    MAX_DETAIL_FETCH,
    Math.max(1, Number(query.limit) || DEFAULT_LIMIT),
  )
  const session = readSession(query)

  try {
    const data = await qmRequest(
      'music.recommend.RecommendFeed',
      'get_recommend_feed',
      { direction: 1, page: 1 },
      { session },
    )

    const shelves = Array.isArray(data && data.v_shelf) ? data.v_shelf : []
    const cards = []
    for (const shelf of shelves) {
      const niches = Array.isArray(shelf && shelf.v_niche) ? shelf.v_niche : []
      for (const niche of niches) {
        const list = Array.isArray(niche && niche.v_card) ? niche.v_card : []
        for (const card of list) {
          // type 200 = 单曲卡片；其余类型是歌单 / 榜单 / 直播等非单曲条目
          if (Number((card && card.type) ?? 0) !== 200) continue
          const normalized = normalizeCard(card)
          if (normalized) cards.push(normalized)
        }
      }
    }

    // 同一首歌曲的推荐条目按歌曲 id 去重
    const unique = []
    const seen = new Set()
    for (const card of cards) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      unique.push(card)
    }

    const picked = unique.slice(0, limit)
    const details = await Promise.all(
      picked.map((card) =>
        fetchSongDetail(Number(card.id), session).catch(() => null),
      ),
    )

    const songs = []
    picked.forEach((card, index) => {
      const track = details[index]
      if (track) songs.push(normalizeTrack(track, card))
    })

    return success({
      code: 200,
      total: songs.length,
      songs,
      shelves: shelves.map((shelf) => ({
        id: (shelf && shelf.id) ?? 0,
        title: stripHighlight((shelf && shelf.title_content) ?? ''),
        template: stripHighlight((shelf && shelf.title_template) ?? ''),
      })),
    })
  } catch (err) {
    logger.error('QQ 音乐推荐流获取异常:', err && err.message)
    return upstreamError(`QQ 音乐推荐流获取失败: ${err && err.message}`)
  }
}
