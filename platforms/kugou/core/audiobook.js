/**
 * 酷狗听书数据层
 *
 * 听书专辑与普通音乐专辑共用同一套 ID 体系：
 * - 专辑 ID 即 `album_id`
 * - 章节即该专辑下的曲目，章节音频沿用普通歌曲的 `hash` 播放链路
 *
 * 区分两类专辑的字段是 `category`：普通音乐专辑为 `1`，听书专辑为 `2`。
 * 听书专属的数据面都在 mobilecdn 的 `/api/v3/` 家族里：
 * - 专辑详情：`GET /api/v3/album/info`
 * - 专辑章节：`GET /api/v3/album/song`
 * - 专辑检索：`GET /api/v3/search/album?category=2`
 *
 * 听书官网为了页面路径好看，把专辑 ID 编码成 base36 别名（`e_album_id`），
 * 该别名可由 `album_id` 反解，见 `decodeAlbumId`。
 *
 * mobilecdn 的 https 证书不受信，端点只能走 `http://`。
 */

const { kgRequest } = require('./request')

/** 听书专辑检索端点 */
const KG_TS_SEARCH_URL = 'http://mobilecdn.kugou.com/api/v3/search/album'

/** 听书专辑详情端点 */
const KG_TS_ALBUM_INFO_URL = 'http://mobilecdn.kugou.com/api/v3/album/info'

/** 听书专辑章节端点 */
const KG_TS_ALBUM_SONG_URL = 'http://mobilecdn.kugou.com/api/v3/album/song'

/** 听书专辑在专辑接口里的分类值（普通音乐专辑为 1） */
const KG_AUDIOBOOK_CATEGORY = 2

/**
 * 听书频道定义
 *
 * 酷狗没有下发听书分类的 JSON 接口，分类表按听书官网
 * `https://www.kugou.com/ts/` 的频道导航整理：
 * - `slug`：官网频道路径片段，同时也是本平台对外的分类标识
 * - `name`：频道中文名
 * - `keyword`：该频道的取材关键字，检索时配合 `category=2` 使用
 *
 * `keyword` 是取材用的代表词，不是频道的官方名称。
 * @type {Array<{ slug: string, name: string, keyword: string }>}
 */
const KG_AUDIOBOOK_CATEGORIES = [
  { slug: 'xiaoshuo', name: '有声小说', keyword: '小说' },
  { slug: 'ertong', name: '儿童天地', keyword: '儿童' },
  { slug: 'xiangsheng', name: '相声曲艺', keyword: '相声' },
  { slug: 'qinggan', name: '情感生活', keyword: '情感' },
  { slug: 'yueyu', name: '粤语', keyword: '粤语' },
  { slug: 'zhumian', name: '助眠解压', keyword: '助眠' },
  { slug: 'yule', name: '娱乐段子', keyword: '段子' },
  { slug: 'guangboju', name: '广播剧', keyword: '广播剧' },
  { slug: 'lishi', name: '国学', keyword: '国学' },
  { slug: 'chongdian', name: '自我充电', keyword: '成长' },
  { slug: 'erciyuan', name: '二次元', keyword: '二次元' },
  { slug: 'zhongxiaoxue', name: '中小学必备', keyword: '中小学' },
  { slug: 'waiyu', name: '外语', keyword: '英语' },
]

/**
 * 把听书官网的 base36 专辑别名反解为数字专辑 ID
 *
 * 别名是 `album_id × 1296 + 余数` 的 base36 表示，别名长度随 ID 增长，
 * 因此按整除反解，余数部分直接舍去。
 * @param {string | number} encoded 官网专辑别名
 * @returns {number} 数字专辑 ID，无法解析时返回 0
 */
const decodeAlbumId = (encoded) => {
  const text = String(encoded || '').trim()
  if (!text || !/^[0-9a-z]+$/i.test(text)) return 0

  const value = parseInt(text, 36)
  if (!Number.isFinite(value)) return 0
  return Math.floor(value / 1296)
}

/**
 * 把外部传入的专辑标识归一成数字专辑 ID
 *
 * 兼容三种写法：纯数字专辑 ID、官网 base36 别名、带前缀的别名。
 * @param {string | number} id 专辑标识
 * @returns {number} 数字专辑 ID，无法解析时返回 0
 */
const normalizeAlbumId = (id) => {
  const text = String(id === undefined || id === null ? '' : id).trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return Number(text)

  const alias = text.split('/').filter(Boolean).pop() || text
  return decodeAlbumId(alias)
}

/**
 * 按标识查听书频道
 * @param {string | number} category 频道标识（slug、中文名或关键字）
 * @returns {{ slug: string, name: string, keyword: string } | null} 频道定义，未命中时返回 null
 */
const findCategory = (category) => {
  const text = String(
    category === undefined || category === null ? '' : category,
  )
    .trim()
    .toLowerCase()
  if (!text) return null

  return (
    KG_AUDIOBOOK_CATEGORIES.find(
      (item) =>
        item.slug.toLowerCase() === text ||
        item.name.toLowerCase() === text ||
        item.keyword.toLowerCase() === text,
    ) || null
  )
}

/**
 * 反转义 HTML 实体并清洗
 * @param {string | null | undefined} text 原始文本
 * @returns {string} 清洗后的文本
 */
const decodeText = (text) => {
  if (!text) return ''
  return String(text)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
}

/**
 * 填充并安全化酷狗图片模板中的尺寸占位符
 * @param {string | undefined} url 封面模板
 * @param {number} [size] 尺寸
 * @returns {string} 封面地址，无封面时返回空串
 */
const fillCover = (url, size = 300) => {
  if (!url) return ''
  return String(url)
    .replace(/\{size\}/g, String(size))
    .replace(/^http:\/\//, 'https://')
}

/**
 * 读取听书专辑检索结果
 *
 * 检索端点是酷狗通用的专辑检索，`category=2` 时只返回听书专辑，
 * 分页窗口由上游真实分页给出，相邻两页不重合。
 * @param {{ keyword: string, category?: number, page?: number, pagesize?: number }} options 检索参数
 * @returns {Promise<{ total: number, list: any[], raw: any }>} 专辑条目、总数与上游原始响应
 */
const searchAudiobookAlbums = async (options) => {
  const {
    keyword,
    category = KG_AUDIOBOOK_CATEGORY,
    page = 1,
    pagesize = 20,
  } = options

  const query = new URLSearchParams({
    keyword,
    category: String(category),
    page: String(page),
    pagesize: String(pagesize),
    format: 'json',
  })

  const raw = await kgRequest(`${KG_TS_SEARCH_URL}?${query.toString()}`)
  const data = raw && raw.data ? raw.data : {}
  const list = Array.isArray(data.lists)
    ? data.lists
    : Array.isArray(data.info)
      ? data.info
      : []

  return {
    total: Number(data.total || list.length),
    list,
    raw,
  }
}

/**
 * 读取听书专辑元信息
 * @param {number} albumId 数字专辑 ID
 * @returns {Promise<{ detail: any, raw: any }>} 专辑元信息与上游原始响应
 */
const fetchAudiobookDetail = async (albumId) => {
  const raw = await kgRequest(
    `${KG_TS_ALBUM_INFO_URL}?albumid=${encodeURIComponent(albumId)}&format=json`,
  )
  return { detail: (raw && raw.data) || {}, raw }
}

/**
 * 读取听书专辑的章节列表
 * @param {number} albumId 数字专辑 ID
 * @param {number} [page] 页码，从 1 开始
 * @param {number} [pagesize] 每页条数
 * @returns {Promise<{ total: number, list: any[], raw: any }>} 章节条目、章节总数与上游原始响应
 */
const fetchAudiobookTracks = async (albumId, page = 1, pagesize = 30) => {
  const query = new URLSearchParams({
    albumid: String(albumId),
    page: String(page),
    pagesize: String(pagesize),
    format: 'json',
  })

  const raw = await kgRequest(`${KG_TS_ALBUM_SONG_URL}?${query.toString()}`)
  const data = raw && raw.data ? raw.data : {}
  const list = Array.isArray(data.info) ? data.info : []

  return {
    total: Number(data.total || list.length),
    list,
    raw,
  }
}

/**
 * 把播音者串拆成播音者列表
 *
 * 酷狗用 `、`（也有 `,` `;`）连接多个播音者。
 * @param {string} speaker 播音者串
 * @returns {Array<{ id: string, name: string }>} 播音者列表
 */
const splitSpeakers = (speaker) => {
  if (!speaker) return []
  return speaker
    .split(/、|,|;/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ id: '', name }))
}

/**
 * 把上游专辑条目映射为对外的听书专辑卡片
 * @param {any} raw 上游专辑条目
 * @returns {any} 对外专辑对象
 */
const normalizeAlbum = (raw) => {
  const source = raw || {}
  const coverTemplate = source.imgurl || ''
  const speaker = decodeText(source.singername || '')

  return {
    id: String(source.albumid ?? ''),
    albumId: Number(source.albumid ?? 0),
    name: decodeText(source.albumname || ''),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    speaker,
    speakers: splitSpeakers(speaker),
    episodeCount: Number(source.songcount ?? 0),
    publishTime: source.publishtime || '',
    intro: decodeText(source.intro || ''),
    category: Number(source.category ?? KG_AUDIOBOOK_CATEGORY),
    privilege: Number(source.privilege ?? 0),
    buyCount: Number(source.buycount ?? 0),
  }
}

/**
 * 把上游章节条目映射为对外的听书章节
 *
 * 上游章节标题形如「播音者 - 章节名」，这里拆成播音者与章节名两段。
 * @param {any} raw 上游章节条目
 * @param {number} index 章节序号，从 1 开始
 * @returns {any} 对外章节对象
 */
const normalizeTrack = (raw, index) => {
  const source = raw || {}
  const filename = decodeText(source.filename || '')
  const splitAt = filename.indexOf(' - ')
  const speaker = splitAt > 0 ? filename.slice(0, splitAt).trim() : ''
  const title = splitAt > 0 ? filename.slice(splitAt + 3).trim() : filename
  const duration = Number(source.duration ?? 0)

  return {
    index,
    id: String(source.album_audio_id ?? ''),
    albumAudioId: Number(source.album_audio_id ?? 0),
    audioId: Number(source.audio_id ?? 0),
    hash: source.hash || '',
    title,
    speaker,
    duration,
    durationMs: duration * 1000,
    size: Number(source.filesize ?? 0),
    privilege: Number(source.privilege ?? 0),
    payType: Number(source.pay_type ?? 0),
    extName: String(source.extname ?? ''),
  }
}

module.exports = {
  KG_TS_SEARCH_URL,
  KG_TS_ALBUM_INFO_URL,
  KG_TS_ALBUM_SONG_URL,
  KG_AUDIOBOOK_CATEGORY,
  KG_AUDIOBOOK_CATEGORIES,
  decodeAlbumId,
  normalizeAlbumId,
  findCategory,
  decodeText,
  fillCover,
  splitSpeakers,
  searchAudiobookAlbums,
  fetchAudiobookDetail,
  fetchAudiobookTracks,
  normalizeAlbum,
  normalizeTrack,
}
