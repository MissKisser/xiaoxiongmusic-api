/**
 * 酷狗听书搜索
 *
 * 走酷狗通用专辑检索端点 `GET /api/v3/search/album`，
 * 传 `category=2` 时只返回听书专辑。
 *
 * 听书官网本身没有搜索入口，因此搜索能力由通用专辑检索提供；
 * 检索结果按上游真实分页给出，相邻两页不重合。
 */

const {
  KG_AUDIOBOOK_CATEGORY,
  searchAudiobookAlbums,
  normalizeAlbum,
} = require('../core/audiobook')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 每页最大条数 */
const MAX_LIMIT = 60

/**
 * 搜索酷狗听书专辑
 *
 * @param {Record<string, any>} [query] 调用参数
 * @param {string} [query.keywords] 搜索关键词
 * @param {number} [query.page] 页码，从 1 开始
 * @param {number} [query.limit] 每页条数
 * @param {number} [query.category] 专辑分类，默认 2（听书）；传 1 查普通音乐专辑，传 0 查全部
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const keywords = String(query.keywords || query.keyword || '').trim()
  if (!keywords) return badRequest('keywords 不能为空')

  const page = Math.max(1, Number(query.page || 1) || 1)
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(query.limit || query.pagesize || 20) || 20),
  )

  const categoryRaw =
    query.category === undefined ? KG_AUDIOBOOK_CATEGORY : query.category
  const category = Number(categoryRaw) || 0

  try {
    const result = await searchAudiobookAlbums({
      keyword: keywords,
      category,
      page,
      pagesize: limit,
    })

    const albums = result.list.map(normalizeAlbum)

    return success({
      code: 200,
      keywords,
      category,
      page,
      limit,
      total: result.total,
      hasMore: page * limit < result.total,
      albums,
      items: albums,
    })
  } catch (err) {
    logger.warn('搜索酷狗听书失败：', err.message || err)
    return upstreamError(`搜索酷狗听书失败：${err.message || err}`)
  }
}
