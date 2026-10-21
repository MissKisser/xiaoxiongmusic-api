/**
 * 酷狗音乐刷歌（推荐流）
 *
 * 一次批次 = 「主选流」全部条目排前 + 「补池」补足到 limit 排后，
 * 对外形状与 QQ 音乐刷歌一致：`{ code, total, songs, source }`，
 * 曲目字段与酷狗榜单模块（`leaderboard_detail`）同口径，渲染端零翻译。
 *
 * ## 主选流
 *
 * `GET http://gateway.kugou.com/genesisapi/v1/newepoch_song_rec/feed`
 *
 * - 协议 A 签名的 GET：**不带 body、不带 Content-Type**（带了网关会返回 error_code=20006）
 * - 匿名可用，带登录态多 1 条；实测连续两批前 5 首重合 0/5
 * - `data.list[]` 是社区动态，曲目信息在 `song_extra`：
 *   - `base_info.songname` / `base_info.author_name` / `base_info.album_name` / `base_info.album_id`
 *   - `base_info.album_audio_id` 是播放主键（对外 `mixSongId`）
 *   - `audio_info.hash` 是播放地址用的字符串主键
 *   - `audio_info.timelength` **单位是毫秒**（与补池的 `time_length` 秒口径不同）
 *   - `copyright.audio_pay_type` 是付费形态，`copyright.audition.end_ms` 是试听时长（毫秒）
 *   - `copyright.qualities['128'].privilege` 是基档授权位（`0` / `8` 可免费播）
 * - `data.paging` 是翻页游标（`last_id` 等），本模块按「每次重新取流」组批，不做翻页续取
 *
 * ## 补池（固定曲池，只作尾部补充）
 *
 * - `POST http://gateway.kugou.com/everydayrec.service/v1/mul_theme_category_recommend`
 *   body `{"show_theme_category_ids":""}` → `data.theme_list[]`（每个主题带 30 首曲目）、
 *   `data.all_theme_detail_list[]`（主题目录，实测 6 个主题）、`data.all_theme_id`
 * - `POST http://gateway.kugou.com/everydayrec.service/v1/theme_category_recommend`
 *   body `{"theme_category_id":<id>}` → `data.song_list[]`（补取目录里没带曲目的主题）
 * - `POST http://everydayrec.service.kugou.com/everyday/api/v1/more`
 *   body `{"platform":"Android","alldays":1}` → `data.song_list[]`（每日固定，主题链路不可用时的兜底）
 *   独立域 `everydayrec.service.kugou.com` 的 https 证书不受信，**只能走 http**
 *
 * 补池曲目是扁平口径（`hash` / `songname` / `author_name` / `time_length`（秒）/
 * `privilege` / `pay_type` / `album_audio_id` / `sizable_cover` / `filesize*`），
 * 与主选流在模块内归一化成同一形状。
 *
 * ## 组批口径
 *
 * 主选条目排前、补池补足到 limit 排后；补池从主题目录里随机取 2 个主题，
 * 合并后洗牌再截取 —— 跨批次多样性靠「随机主题 + 洗牌」，不靠上游轮换。
 *
 * ## 节流
 *
 * 主选 1 次 + 补池 1~2 次请求即成一批，整批上游请求不超过 3 次。
 *
 * ## 付费
 *
 * 不按付费过滤曲目：付费标记原样透出（`pay` / `trial`），
 * 由播放决策树决定「官方试听 → 换源 → 试听/toast」，与 QQ 音乐刷歌一致。
 *
 * ## 字段对照
 *
 * 主选流（`data.list[]` → 对外曲目）：
 *
 * | 对外字段        | 上游字段                                   | 说明                         |
 * | --------------- | ------------------------------------------ | ---------------------------- |
 * | `id`            | `song_extra.base_info.album_audio_id`      | 播放主键                     |
 * | `mixSongId`     | `song_extra.base_info.album_audio_id`      | 播放主键（字符串口径）       |
 * | `hash`          | `song_extra.audio_info.hash`               | 播放地址用字符串主键         |
 * | `name`          | `song_extra.base_info.songname`            | 歌名                         |
 * | `artist`        | `song_extra.base_info.author_name`          | 歌手串（` / ` 连接）         |
 * | `artists[]`     | `song_extra.base_info.author_name`          | 歌手条目（无平台歌手号）     |
 * | `album`         | `song_extra.base_info.album_name`           | 专辑名                       |
 * | `albumId`       | `song_extra.base_info.album_id`             | 专辑号                       |
 * | `duration`      | `song_extra.audio_info.timelength`          | **毫秒**                     |
 * | `interval`      | `song_extra.audio_info.timelength`          | **秒**                       |
 * | `cover`         | `song_extra.copyright.trans_param.union_cover` | `{size}` → 300           |
 * | `qualities[]`   | `audio_info.hash*` / `filesize*`            | 存在的音质档位名             |
 * | `hashes`/`sizes`| 同上                                        | 音质档位 → hash / 文件大小   |
 * | `pay`           | `copyright.audio_pay_type` / `copyright.qualities['128'].privilege` | 付费形态 / 基档授权位 |
 * | `trial`         | `copyright.audition.end_ms`                 | 试听片段（毫秒）             |
 *
 * 补池（`data.song_list[]` → 对外曲目）：
 *
 * | 对外字段        | 上游字段                | 说明                     |
 * | --------------- | ----------------------- | ------------------------ |
 * | `id`            | `album_audio_id`        | 播放主键                 |
 * | `mixSongId`     | `album_audio_id`        | 播放主键（字符串口径）   |
 * | `hash`          | `hash`（或 `hash_128`） | 播放地址用字符串主键     |
 * | `name`          | `songname`              | 歌名                     |
 * | `artist`        | `author_name`           | 歌手串（` / ` 连接）     |
 * | `artists[]`     | `singerinfo[]`          | 歌手条目（有平台歌手号） |
 * | `album`         | `album_name`            | 专辑名                   |
 * | `albumId`       | `album_id`              | 专辑号                   |
 * | `duration`      | `time_length`           | **秒 → 毫秒**            |
 * | `interval`      | `time_length`           | **秒**                   |
 * | `cover`         | `sizable_cover`         | `{size}` → 300           |
 * | `pay`           | `pay_type` / `privilege`| 付费形态 / 基档授权位    |
 * | `trial`         | `trans_param.hash_offset.end_ms` | 试听片段（毫秒）  |
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 主选流端点（网关相对路径） */
const KG_FEED_PATH = '/genesisapi/v1/newepoch_song_rec/feed'

/** 主选流与主题推荐端点的网关地址 */
const KG_GATEWAY_BASE_URL = 'http://gateway.kugou.com'

/** 多主题推荐端点 */
const KG_MUL_THEME_PATH = '/everydayrec.service/v1/mul_theme_category_recommend'

/** 单主题推荐端点 */
const KG_THEME_PATH = '/everydayrec.service/v1/theme_category_recommend'

/** 每日推荐端点（兜底补池，独立域只能走 http） */
const KG_DAILY_PATH = '/everyday/api/v1/more'

/** 每日推荐端点所属域名 */
const KG_DAILY_BASE_URL = 'http://everydayrec.service.kugou.com'

/** 单批默认曲目数 */
const DEFAULT_LIMIT = 20

/** 单批曲目数上限 */
const MAX_LIMIT = 50

/** 每批补池随机取用的主题数 */
const POOL_THEME_COUNT = 2

/**
 * HTML 实体反转义映射
 *
 * 键是去掉 `&` 前缀的实体名，查表前再补前缀：
 * 源码里不写完整实体字面量，避免实体名在写入时被二次解码。
 */
const ENTITY_MAP = {
  'nbsp;': ' ',
  'amp;': '&',
  'lt;': '<',
  'gt;': '>',
  'quot;': '"',
  'apos;': "'",
  '#039;': "'",
}

/**
 * HTML 实体反转义并清洗
 * @param {string | null | undefined} str 原始字符串
 * @returns {string} 清洗后的字符串
 */
const decodeName = (str) => {
  if (!str) return ''
  return String(str).replace(
    /&(nbsp|amp|lt|gt|quot|apos|#039);/g,
    (s) => ENTITY_MAP[s.slice(1)] ?? s,
  )
}

/**
 * 填充并安全化酷狗图片模板中的尺寸占位符
 *
 * 口径：模块层就把 `{size}` 换成实际尺寸（`cover` 用 300、`coverOriginal` 用 480），
 * 与本平台其他模块（搜索 / 专辑 / 歌单 / 榜单）保持一致，渲染端拿到即可直接用。
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
 * 拆分歌手串
 *
 * 酷狗歌手串用 `、`（也有 `,` / `;` / `/`）分隔，拆分后条目不带平台歌手号。
 * @param {string | undefined} name 歌手串
 * @returns {string[]} 歌手名数组
 */
const splitArtistNames = (name) =>
  decodeName(name)
    .split(/、|,|;|\s*\/\s*/)
    .map((item) => item.trim())
    .filter(Boolean)

/**
 * 洗牌（Fisher-Yates）
 * @template T
 * @param {T[]} list 原数组
 * @returns {T[]} 洗牌后的新数组
 */
const shuffle = (list) => {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * 收集音质档位的 hash 与文件大小
 * @param {Record<string, any>} target 收集目标
 * @param {string} quality 音质档位名
 * @param {any} hash 该档位 hash
 * @param {any} size 该档位文件大小
 */
const putQuality = (target, quality, hash, size) => {
  if (!hash || !size) return
  target.hashes[quality] = String(hash)
  target.sizes[quality] = Number(size)
}

/**
 * 归一化主选流曲目
 *
 * 时长口径：上游 `audio_info.timelength` 是**毫秒**，对外 `duration` 换算成毫秒、
 * `interval` 取整秒（与榜单模块同一口径：`duration === interval * 1000`）。
 * 付费判据取基档授权位（`copyright.qualities['128'].privilege`，
 * `0` / `8` 可免费播），试听判据取 `copyright.audition.end_ms`（毫秒）。
 * @param {any} raw 上游动态条目
 * @returns {Record<string, any> | null} 归一化后的曲目，无有效 hash 时返回 null
 */
const normalizeFeedSong = (raw) => {
  const entry = raw || {}
  const extra = entry.song_extra || {}
  const audio = extra.audio_info || {}
  const base = extra.base_info || {}
  const copyright = extra.copyright || {}
  const trans = copyright.trans_param || {}
  const song = entry.song || {}

  const hash = String(audio.hash || '')
  if (!hash) return null

  const artistNames = splitArtistNames(base.author_name || song.author_name)
  const artistName = artistNames.join(' / ')
  // 上游给的是毫秒且带亚秒精度，对外统一到「整秒」口径（与榜单模块一致）
  const interval = Math.round(Number(audio.timelength || 0) / 1000)

  const target = { hashes: {}, sizes: {} }
  putQuality(target, '128k', audio.hash, audio.filesize)
  putQuality(target, '320k', audio.hash_320, audio.filesize_320)
  putQuality(target, 'flac', audio.hash_flac, audio.filesize_flac)
  putQuality(target, 'flac24bit', audio.hash_high, audio.filesize_high)

  const audition = copyright.audition || {}
  const hashOffset = trans.hash_offset || {}
  const trialDuration = Number(audition.end_ms || hashOffset.end_ms || 0)
  const qualities = copyright.qualities || {}
  const baseQuality = qualities['128'] || {}

  const coverTemplate = trans.union_cover || song.album_cover || ''

  return {
    id: String(base.album_audio_id || ''),
    mid: '',
    audioId: Number(base.audio_id || 0),
    albumAudioId: Number(base.album_audio_id || 0),
    /** 歌曲主键（album_audio_id 口径），签播放地址用它 */
    mixSongId: String(base.album_audio_id || ''),
    hash,
    name: decodeName(base.songname || song.songname || ''),
    artist: artistName,
    artists: artistNames.map((name) => ({ id: '', name })),
    album: decodeName(base.album_name || ''),
    albumMid: '',
    albumId: String(base.album_id || song.album_id || ''),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    duration: interval * 1000,
    interval,
    qualities: Object.keys(target.hashes),
    hashes: target.hashes,
    sizes: target.sizes,
    pay: {
      payplay: Number(copyright.audio_pay_type || 0),
      privilege: Number(baseQuality.privilege ?? song.privilege_128 ?? 0),
      feetype: 0,
      pkgPrice: 0,
      price: 0,
    },
    trial: {
      available: trialDuration > 0,
      duration: trialDuration,
    },
    file: {},
    /** 批次内来源标注：主选流 */
    source: 'feed',
  }
}

/**
 * 归一化补池曲目（扁平口径）
 *
 * 时长口径：上游 `time_length` 是**秒**，对外 `duration` 换算成毫秒、`interval` 保留秒。
 * 付费判据取基档授权位 `privilege`（`0` / `8` 可免费播），
 * 试听判据取 `trans_param.hash_offset.end_ms`（毫秒）。
 * @param {any} raw 上游曲目条目
 * @param {string} source 来源标注
 * @returns {Record<string, any> | null} 归一化后的曲目，无有效 hash 时返回 null
 */
const normalizePoolSong = (raw, source) => {
  const entry = raw || {}
  const trans = entry.trans_param || {}
  const hash = String(entry.hash_128 || entry.hash || '')
  if (!hash) return null

  const singerInfo = Array.isArray(entry.singerinfo) ? entry.singerinfo : []
  // 歌手条目：优先用上游 `singerinfo`（带平台歌手号），缺失时按歌手串拆分
  const singers = singerInfo.map((singer) => ({
    id: singer && singer.id !== undefined ? String(singer.id) : '',
    name: decodeName((singer && singer.name) || ''),
  }))
  const namedSingers = singers.filter((singer) => singer.name)
  const artists = namedSingers.length
    ? namedSingers
    : splitArtistNames(entry.author_name).map((name) => ({ id: '', name }))
  const artistName = artists.map((singer) => singer.name).join(' / ')

  const interval = Number(entry.time_length || 0)

  const target = { hashes: {}, sizes: {} }
  putQuality(
    target,
    '128k',
    entry.hash_128 || entry.hash,
    entry.filesize_128 || entry.filesize,
  )
  putQuality(target, '320k', entry.hash_320, entry.filesize_320)
  putQuality(target, 'flac', entry.hash_flac, entry.filesize_flac)
  putQuality(target, 'flac24bit', entry.hash_high, entry.filesize_high)

  const hashOffset = trans.hash_offset || {}
  const trialDuration = Number(hashOffset.end_ms || 0)

  const coverTemplate = entry.sizable_cover || trans.union_cover || ''

  return {
    id: String(entry.album_audio_id || ''),
    mid: '',
    audioId: Number(entry.songid || 0),
    albumAudioId: Number(entry.album_audio_id || 0),
    mixSongId: String(entry.album_audio_id || ''),
    hash,
    name: decodeName(entry.songname || ''),
    artist: artistName,
    artists,
    album: decodeName(entry.album_name || ''),
    albumMid: '',
    albumId: String(entry.album_id || ''),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    duration: interval * 1000,
    interval,
    qualities: Object.keys(target.hashes),
    hashes: target.hashes,
    sizes: target.sizes,
    pay: {
      payplay: Number(entry.pay_type || 0),
      privilege: Number(entry.privilege || 0),
      feetype: 0,
      pkgPrice: 0,
      price: 0,
    },
    trial: {
      available: trialDuration > 0,
      duration: trialDuration,
    },
    file: {},
    source,
  }
}

/**
 * 读取主选流
 * @param {any} session 登录凭据
 * @returns {Promise<Record<string, any>[]>} 归一化后的主选曲目
 */
const fetchFeed = async (session) => {
  const body = await kgGatewayRequest(
    KG_FEED_PATH,
    {},
    {
      method: 'GET',
      baseURL: KG_GATEWAY_BASE_URL,
      session,
    },
  )
  const list = (body && body.data && body.data.list) || []
  if (!Array.isArray(list)) {
    throw new Error('酷狗推荐流响应缺少曲目列表')
  }
  return list.map(normalizeFeedSong).filter(Boolean)
}

/**
 * 读取主题目录与「随目录一起下发曲目」的主题
 * @param {any} session 登录凭据
 * @returns {Promise<{ catalogIds: number[], local: Map<number, any[]> }>} 主题目录
 */
const fetchThemeCatalog = async (session) => {
  const body = await kgGatewayRequest(
    KG_MUL_THEME_PATH,
    { show_theme_category_ids: '' },
    {
      method: 'POST',
      baseURL: KG_GATEWAY_BASE_URL,
      session,
    },
  )
  const data = (body && body.data) || {}

  /** 随目录一起下发曲目的主题 */
  const local = new Map()
  const themeList = Array.isArray(data.theme_list) ? data.theme_list : []
  for (const theme of themeList) {
    const id = Number(theme && theme.theme_detail && theme.theme_detail.id)
    const songs = theme && Array.isArray(theme.song_list) ? theme.song_list : []
    if (id && songs.length) local.set(id, songs)
  }

  /** 主题目录（上游 `all_theme_detail_list`，实测 6 个主题） */
  const catalogIds = []
  const details = Array.isArray(data.all_theme_detail_list)
    ? data.all_theme_detail_list
    : []
  for (const detail of details) {
    const id = Number(detail && detail.id)
    if (id && !catalogIds.includes(id)) catalogIds.push(id)
  }
  if (!catalogIds.length && data.all_theme_id) {
    for (const part of String(data.all_theme_id).split(',')) {
      const id = Number(part.trim())
      if (id && !catalogIds.includes(id)) catalogIds.push(id)
    }
  }
  for (const id of local.keys()) {
    if (!catalogIds.includes(id)) catalogIds.push(id)
  }

  return { catalogIds, local }
}

/**
 * 读取单个主题的曲目
 * @param {any} session 登录凭据
 * @param {number} themeId 主题号
 * @returns {Promise<any[]>} 上游曲目列表
 */
const fetchSingleTheme = async (session, themeId) => {
  const body = await kgGatewayRequest(
    KG_THEME_PATH,
    { theme_category_id: themeId },
    {
      method: 'POST',
      baseURL: KG_GATEWAY_BASE_URL,
      session,
    },
  )
  const list = (body && body.data && body.data.song_list) || []
  return Array.isArray(list) ? list : []
}

/**
 * 读取每日推荐（兜底补池）
 * @param {any} session 登录凭据
 * @returns {Promise<any[]>} 上游曲目列表
 */
const fetchDaily = async (session) => {
  const body = await kgGatewayRequest(
    KG_DAILY_PATH,
    { platform: 'Android', alldays: 1 },
    {
      method: 'POST',
      baseURL: KG_DAILY_BASE_URL,
      session,
    },
  )
  const list = (body && body.data && body.data.song_list) || []
  return Array.isArray(list) ? list : []
}

/**
 * 选出本批补池要用的主题并解析出曲目
 *
 * 口径：主题目录里随机取 2 个主题号，曲目按「先本地后补取」解析：
 * - `mul_theme_category_recommend` 会带 3 个主题的曲目（本地命中，0 额外请求）
 * - 其余主题号走单主题端点补取，每批最多补 1 次（把整批上游请求压在 3 次以内）
 * - 补不到时退化为「本地可用主题里随机取一个」，并按实际使用的主题号记账
 * @param {any} session 登录凭据
 * @param {{ catalogIds: number[], local: Map<number, any[]> }} catalog 主题目录
 * @returns {Promise<{ themes: number[], songs: any[] }>} 主题号与合并后的上游曲目
 */
const pickPoolThemes = async (session, catalog) => {
  const { catalogIds, local } = catalog
  const shuffled = shuffle(catalogIds)

  /** 选中的主题号（按「先本地后补取」的顺序） */
  const picked = []
  const localFirst = shuffled.find((id) => local.has(id))
  if (localFirst !== undefined) picked.push(localFirst)
  for (const id of shuffled) {
    if (picked.length >= POOL_THEME_COUNT) break
    if (!picked.includes(id)) picked.push(id)
  }

  /** 实际用到的主题号 */
  const themes = []
  /** 合并后的上游曲目 */
  const songs = []
  let extraFetchUsed = false

  for (const id of picked) {
    if (themes.includes(id)) continue

    if (local.has(id)) {
      themes.push(id)
      songs.push(...local.get(id))
      continue
    }

    if (!extraFetchUsed) {
      extraFetchUsed = true
      try {
        const fetched = await fetchSingleTheme(session, id)
        if (fetched.length) {
          themes.push(id)
          songs.push(...fetched)
          continue
        }
      } catch (err) {
        logger.warn('酷狗单主题补取失败：', err && err.message)
      }
    }

    // 补不到时退化为本地可用主题（避开已用主题）
    const fallback = shuffled.find(
      (candidate) => local.has(candidate) && !themes.includes(candidate),
    )
    if (fallback === undefined) continue
    themes.push(fallback)
    songs.push(...local.get(fallback))
  }

  return { themes, songs }
}

module.exports = async (query = {}) => {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(query.limit) || DEFAULT_LIMIT),
  )
  const session = readSession(query)

  try {
    // 主选流：批次前段的来源，失败即整批失败（不产出「只有补池」的残缺批次）
    const primary = await fetchFeed(session)

    /** 补池需要的曲目数 */
    const need = Math.max(0, limit - primary.length)
    /** 补池曲目 */
    const pool = []
    /** 实际用到的主题号 */
    const themes = []
    /** 补池来源标注 */
    let poolSource = 'theme'

    if (need > 0) {
      try {
        const catalog = await fetchThemeCatalog(session)
        const picked = await pickPoolThemes(session, catalog)
        themes.push(...picked.themes)
        pool.push(...picked.songs)
      } catch (err) {
        logger.warn('酷狗主题补池不可用，改用每日推荐：', err && err.message)
        poolSource = 'daily'
        try {
          pool.push(...(await fetchDaily(session)))
        } catch (dailyErr) {
          logger.warn('酷狗每日推荐补池不可用：', dailyErr && dailyErr.message)
        }
      }
    }

    // 补池曲目合并后洗牌再截取：跨批次多样性靠随机主题 + 洗牌
    const poolSongs = shuffle(pool)
      .map((item) => normalizePoolSong(item, poolSource))
      .filter(Boolean)
      .slice(0, need)

    // 整批按 hash 去重（主选与补池可能撞车）
    const songs = []
    const seen = new Set()
    for (const song of [...primary, ...poolSongs]) {
      if (!song.hash || seen.has(song.hash)) continue
      seen.add(song.hash)
      songs.push(song)
      if (songs.length >= limit) break
    }

    return success({
      code: 200,
      total: songs.length,
      songs,
      source: {
        platform: 'kugou',
        primary: 'feed',
        pool: poolSource,
        themes,
        primaryCount: primary.length,
        poolCount: poolSongs.length,
      },
    })
  } catch (err) {
    logger.error('酷狗刷歌推荐流获取异常:', err && err.message)
    return upstreamError(`酷狗刷歌推荐流获取失败: ${err && err.message}`)
  }
}
