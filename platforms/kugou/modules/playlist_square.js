/**
 * 酷狗歌单广场
 *
 * 酷狗侧没有可直接取用的「歌单广场列表」端点，本模块的取材口径据此确定：
 * - `mobilecdn /api/v3/special/list` 恒返回 `Access Deny`（已实测多组 UA 与参数组合）
 * - `specialsearch /special_search` 与网关 `/v1/search/special` 都强制要求关键词
 *   （空关键词回 `error_code=151 Empty Keyword`）
 * - `specialrec /special_recommend` 走独立签名，实测恒回 `200101 / 200102`
 *
 * 因此广场按「分类关键词 + 上游真实分页」轮换取材：
 * 每个分类连续占用若干页，页内取上游 `/v1/search/special` 的一页。
 * 相邻两页来自同一分类的不同上游页，上游分页窗口本身互不重合，
 * 因此翻页真实推进且不会重复。
 */

const { kgGatewayRequest, kgErrorCode } = require('../core/request')
const { success, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 搜索网关的路由头 */
const SEARCH_ROUTER = 'complexsearch.kugou.com'

/** 广场取材的分类关键词，按顺序轮换 */
const SQUARE_KEYWORDS = ['热歌', '轻音乐', '民谣', 'DJ', '钢琴', '经典']

/** 每个分类连续占用的页数 */
const PAGES_PER_KEYWORD = 3

/** 广场可翻页的总页数 */
const TOTAL_PAGES = SQUARE_KEYWORDS.length * PAGES_PER_KEYWORD

/** HTML 实体反转义映射 */
const ENTITY_MAP = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#039;': "'",
}

/**
 * HTML 实体反转义并清洗
 * @param {string | null | undefined} str 原始字符串
 * @returns {string} 清洗后的字符串
 */
const decodeName = (str) => {
  if (!str) return ''
  return String(str).replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#039;/g,
    (s) => ENTITY_MAP[s] ?? s,
  )
}

/**
 * 把 http 链接升级为 https
 * @param {string | undefined} url 原始链接
 * @returns {string} 安全链接
 */
const secureUrl = (url) =>
  url ? String(url).replace(/^http:\/\//, 'https://') : ''

/**
 * 填充并安全化酷狗图片模板中的尺寸占位符
 * @param {string | undefined} url 封面模板
 * @param {number} [size] 尺寸
 * @returns {string} 封面链接，无封面时返回空串
 */
const fillCover = (url, size = 300) => {
  if (!url) return ''
  return secureUrl(String(url).replace(/\{size\}/g, String(size)))
}

/**
 * 从网关搜索响应里取出条目列表
 * @param {any} res 网关响应体
 * @returns {any[]} 条目列表
 */
const pickList = (res) => {
  const data = (res && res.data) || {}
  if (Array.isArray(data.lists)) return data.lists
  if (Array.isArray(data.info)) return data.info
  return []
}

/**
 * 把上游歌单条目映射为对外结构
 * @param {any} raw 上游歌单条目
 * @returns {any} 对外歌单对象
 */
const normalizePlaylist = (raw) => ({
  id: String(raw.specialid || raw.gid || ''),
  name: decodeName(raw.specialname),
  cover: fillCover(raw.img, 300) || '',
  creator: decodeName(raw.nickname),
  trackCount: raw.song_count ?? 0,
  playCount: Number(raw.play_count || raw.total_play_count || 0),
})

/**
 * 由分片序号算出分类与上游页码
 * @param {number} shardIndex 分片序号，从 0 开始
 * @returns {{ keywordIndex: number, keyword: string, upstreamPage: number }} 分片定位
 */
const shardOf = (shardIndex) => {
  const keywordIndex = Math.floor(shardIndex / PAGES_PER_KEYWORD)
  return {
    keywordIndex,
    keyword: SQUARE_KEYWORDS[keywordIndex] || '',
    upstreamPage: (shardIndex % PAGES_PER_KEYWORD) + 1,
  }
}

/**
 * 取一个分片的上游数据
 * @param {{ keyword: string, upstreamPage: number }} shard 分片定位
 * @param {number} limit 每页条数
 * @returns {Promise<{ res: any, list: any[] }>} 网关响应体与条目列表
 */
const fetchShard = async (shard, limit) => {
  const res = await kgGatewayRequest(
    '/v1/search/special',
    {},
    {
      method: 'GET',
      params: {
        keyword: shard.keyword,
        page: shard.upstreamPage,
        pagesize: limit,
        platform: 'AndroidFilter',
        iscorrection: 1,
      },
      headers: { 'x-router': SEARCH_ROUTER },
    },
  )
  return { res, list: pickList(res) }
}

/**
 * 读取酷狗歌单广场
 *
 * @param {Record<string, any>} [query] 调用参数
 * @param {number} [query.page] 页码，从 1 开始
 * @param {number} [query.limit] 每页条数
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const page = Math.max(1, Number(query.page || 1) || 1)
  const limit = Math.max(1, Number(query.limit || 30) || 30)
  const total = TOTAL_PAGES * limit

  const empty = {
    code: 200,
    page,
    limit,
    keyword: '',
    keywordIndex: -1,
    total,
    hasMore: false,
    playlists: [],
    items: [],
    raw: null,
  }

  if (page > TOTAL_PAGES) return success(empty)

  try {
    let shardIndex = page - 1

    // 分类被取尽时分片会返回空列表，向后顺延到下一个有数据的分片
    for (let guard = 0; guard <= PAGES_PER_KEYWORD; guard += 1) {
      const shard = shardOf(shardIndex)
      const { res, list } = await fetchShard(shard, limit)

      const errCode = kgErrorCode(res)
      if (errCode !== 0) {
        return upstreamError(`酷狗歌单广场取材失败：error_code=${errCode}`, {
          page,
          limit,
          raw: res,
        })
      }

      if (list.length > 0) {
        const playlists = list.slice(0, limit).map(normalizePlaylist)
        return success({
          code: 200,
          page,
          limit,
          keyword: shard.keyword,
          keywordIndex: shard.keywordIndex,
          total,
          hasMore: shardIndex + 1 < TOTAL_PAGES,
          playlists,
          items: playlists,
          raw: res,
        })
      }

      shardIndex += 1
      if (shardIndex >= TOTAL_PAGES) break
    }

    return success(empty)
  } catch (err) {
    logger.warn('读取酷狗歌单广场失败：', err.message || err)
    return upstreamError(`读取酷狗歌单广场失败：${err.message || err}`)
  }
}
