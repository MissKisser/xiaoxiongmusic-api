/**
 * 酷狗听书频道下的专辑列表
 *
 * 取材口径与酷狗歌单广场一致：酷狗没有「按听书频道取专辑」的端点，
 * 因此按「频道取材关键字 + `category=2` 专辑检索」取数——
 * 检索端点传 `category=2` 时只返回听书专辑，
 * 分页窗口由上游真实分页给出，相邻两页不重合。
 *
 * 每个条目带封面、专辑名、播音者与章节数（`songcount`）。
 */

const {
  KG_AUDIOBOOK_CATEGORY,
  findCategory,
  searchAudiobookAlbums,
  normalizeAlbum,
} = require('../core/audiobook')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 每页最大条数 */
const MAX_LIMIT = 60

/**
 * 读取酷狗听书频道下的专辑列表
 *
 * @param {Record<string, any>} [query] 调用参数
 * @param {string} [query.category] 频道标识（slug、中文名或取材关键字），默认「有声小说」
 * @param {number} [query.page] 页码，从 1 开始
 * @param {number} [query.limit] 每页条数
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const rawCategory = query.category ?? query.tag ?? query.slug ?? 'xiaoshuo'
  const category = findCategory(rawCategory)
  if (!category) {
    return badRequest(`不支持的酷狗听书频道：${rawCategory}`)
  }

  const page = Math.max(1, Number(query.page || 1) || 1)
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(query.limit || query.pagesize || 20) || 20),
  )

  try {
    const result = await searchAudiobookAlbums({
      keyword: category.keyword,
      category: KG_AUDIOBOOK_CATEGORY,
      page,
      pagesize: limit,
    })

    const albums = result.list.map(normalizeAlbum)

    return success({
      code: 200,
      category: {
        slug: category.slug,
        name: category.name,
        keyword: category.keyword,
      },
      page,
      limit,
      total: result.total,
      hasMore: page * limit < result.total,
      albums,
      items: albums,
    })
  } catch (err) {
    logger.warn('读取酷狗听书专辑列表失败：', err.message || err)
    return upstreamError(`读取酷狗听书专辑列表失败：${err.message || err}`)
  }
}
