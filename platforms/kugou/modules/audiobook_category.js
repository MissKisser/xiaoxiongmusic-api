/**
 * 酷狗听书频道列表
 *
 * 听书官网 `https://www.kugou.com/ts/` 的频道导航是酷狗唯一公开下发
 * 听书分类的地方，酷狗没有对应的 JSON 接口，因此频道表在本地维护
 * （见 `core/audiobook.js` 的 `KG_AUDIOBOOK_CATEGORIES`）。
 *
 * 每个频道带一个取材关键字，用于「频道下的内容列表」按
 * `category=2` 检索听书专辑。
 */

const {
  KG_AUDIOBOOK_CATEGORIES,
  KG_TS_SEARCH_URL,
  KG_TS_ALBUM_INFO_URL,
  KG_TS_ALBUM_SONG_URL,
} = require('../core/audiobook')
const { success } = require('../../shared/response')

/**
 * 读取酷狗听书频道列表
 *
 * @param {Record<string, any>} [query] 调用参数
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async () => {
  const categories = KG_AUDIOBOOK_CATEGORIES.map((item) => ({
    slug: item.slug,
    name: item.name,
    keyword: item.keyword,
    path: `/ts/${item.slug}/`,
  }))

  return success({
    code: 200,
    total: categories.length,
    categories,
    items: categories,
    endpoints: {
      search: KG_TS_SEARCH_URL,
      albumInfo: KG_TS_ALBUM_INFO_URL,
      albumSong: KG_TS_ALBUM_SONG_URL,
    },
  })
}
