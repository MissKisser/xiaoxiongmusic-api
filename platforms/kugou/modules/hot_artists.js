/**
 * 酷狗音乐热门歌手列表
 *
 * 走 `GET http://mobilecdn.kugou.com/api/v3/singer/list`：
 * 上游一次下发分类清单（`data.enu_list.types`）与歌手条目（`data.info`），
 * 条目带歌手号 `singerid`、歌手名 `singername`、粉丝数 `fanscount`、
 * 热度 `heat` 与头像模板（`imgurl`，尺寸写成 `{size}` 占位符）。
 *
 * 端点只能走 `http://`：`mobilecdn.kugou.com` 的 https 证书不受信，握手会失败。
 *
 * 分类口径以上游 `enu_list.types` 为唯一真源（实测 9 项）：
 * - 全部 key=0 / 华语 key=1 / 欧美 key=2 / 其他 key=4 / 日本 key=5 /
 *   韩国 key=6 / 粤语 key=7 / 闽南语 key=8；
 * - 音乐人 key=0，与「全部」同键，靠 `musician=3` 区分
 *   （`musician=1` / `2` 是另两个音乐人维度，上游分类清单未暴露）。
 *
 * 故对外分类标识取两种形态：`<key>` 与 `<key>:<musician>`，
 * 借后者唯一表达「音乐人」，其余分类直接用 key。
 *
 * 歌手号 `singerid` 即酷狗歌手主键，可直接喂既有 `artist` 模块查详情；
 * 上游 `albumcount` / `songcount` 恒为 0，不作对外字段，
 * 曲目数与专辑数由歌手详情模块给出。
 */

const { kgRequest } = require('../core/request')
const { success, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 歌手列表端点（https 证书不受信，只能走 http） */
const KG_SINGER_LIST_URL = 'http://mobilecdn.kugou.com/api/v3/singer/list'

/** 默认分类（上游「全部」，key=0） */
const DEFAULT_TYPE_KEY = 0

/** 默认页码 */
const DEFAULT_PAGE = 1

/** 默认每页条数 */
const DEFAULT_LIMIT = 30

/** 每页条数上限 */
const MAX_LIMIT = 100

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
 * 反转义 HTML 实体
 * @param {any} str 原始字符串
 * @returns {string} 清洗后的字符串
 */
const decodeName = (str) => {
  if (!str) return ''
  return String(str).replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#039;/g,
    (entity) => ENTITY_MAP[entity] ?? entity,
  )
}

/**
 * 填充并安全化头像模板中的尺寸占位符
 *
 * 口径：模块层就把 `{size}` 换成实际尺寸（`cover` 用 300、`coverOriginal` 用 480），
 * 与本平台其他模块（搜索 / 专辑 / 歌单 / 榜单）保持一致，渲染端拿到即可直接用。
 * @param {any} url 头像模板
 * @param {number} [size] 尺寸
 * @returns {string} 头像地址，无头像时返回空串
 */
const fillCover = (url, size = 300) => {
  if (!url) return ''
  return String(url)
    .replace(/\{size\}/g, String(size))
    .replace(/^http:\/\//, 'https://')
}

/**
 * 拼分类标识
 *
 * 音乐人维度非 0 时取 `<key>:<musician>`，其余分类取 `<key>`。
 * @param {number} key 上游分类键
 * @param {number} musician 音乐人维度
 * @returns {string} 分类标识
 */
const formatTypeId = (key, musician) =>
  musician ? `${key}:${musician}` : String(key)

/**
 * 解析分类标识
 *
 * 兼容纯数字形态（`<key>`）与带音乐人维度的形态（`<key>:<musician>`）。
 * @param {any} raw 分类标识
 * @returns {{ key: number, musician: number }} 上游分类键与音乐人维度
 */
const parseTypeId = (raw) => {
  const text = String(raw ?? '').trim()
  if (!text) return { key: DEFAULT_TYPE_KEY, musician: 0 }

  const [keyPart, musicianPart] = text.split(':')
  const key = Number(keyPart)
  const musician =
    musicianPart === undefined ? Number.NaN : Number(musicianPart)
  return {
    key: Number.isFinite(key) ? key : DEFAULT_TYPE_KEY,
    musician: Number.isFinite(musician) ? musician : 0,
  }
}

/**
 * 归一化分类项
 * @param {any} item 上游分类项
 * @returns {{ id: string, name: string }} 归一化后的分类项
 */
const normalizeType = (item) => {
  const source = item || {}
  const key = Number(source.key ?? DEFAULT_TYPE_KEY)
  const musician = Number(source.musician ?? 0)
  return {
    id: formatTypeId(Number.isFinite(key) ? key : DEFAULT_TYPE_KEY, musician),
    name: decodeName(source.value ?? ''),
  }
}

/**
 * 归一化歌手条目
 * @param {any} item 上游歌手条目
 * @returns {Record<string, any>} 归一化后的歌手条目
 */
const normalizeArtist = (item) => {
  const source = item || {}
  const singerId = String(source.singerid ?? '')
  return {
    id: Number(source.singerid ?? 0),
    platformId: singerId,
    name: decodeName(source.singername ?? ''),
    cover: fillCover(source.imgurl, 300),
    coverOriginal: fillCover(source.imgurl, 480),
    fansCount: Number(source.fanscount ?? 0),
    heat: Number(source.heat ?? 0),
  }
}

/**
 * 拼上游请求地址
 * @param {number} key 上游分类键
 * @param {number} musician 音乐人维度（0 表示不传）
 * @param {number} page 页码
 * @param {number} limit 每页条数
 * @returns {string} 请求地址
 */
const buildSingerListUrl = (key, musician, page, limit) => {
  const params = [
    `type=${encodeURIComponent(key)}`,
    `page=${encodeURIComponent(page)}`,
    `pagesize=${encodeURIComponent(limit)}`,
  ]
  if (musician) params.push(`musician=${encodeURIComponent(musician)}`)
  return `${KG_SINGER_LIST_URL}?${params.join('&')}`
}

/**
 * 读取酷狗音乐热门歌手列表
 * @param {Record<string, any>} [query] 调用参数，`type` 为分类标识（`<key>` 或 `<key>:<musician>`）
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const page = Math.max(1, Number(query.page ?? DEFAULT_PAGE) || DEFAULT_PAGE)
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(
      1,
      Number(query.limit ?? query.pagesize ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
    ),
  )
  const { key, musician } = parseTypeId(query.type)

  try {
    const body = await kgRequest(buildSingerListUrl(key, musician, page, limit))
    const data = (body && body.data) || {}
    const info = Array.isArray(data.info) ? data.info : []
    const enuList =
      data.enu_list && typeof data.enu_list === 'object' ? data.enu_list : {}

    return success({
      code: 200,
      total: Number(data.total ?? info.length),
      page,
      limit,
      types: (Array.isArray(enuList.types) ? enuList.types : []).map(
        normalizeType,
      ),
      artists: info.map(normalizeArtist),
    })
  } catch (err) {
    logger.error('酷狗热门歌手列表获取异常:', err && err.message)
    return upstreamError(`酷狗热门歌手列表获取失败: ${err && err.message}`)
  }
}
