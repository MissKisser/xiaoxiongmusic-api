/**
 * 酷狗音乐每日推荐歌单（官方客户端叫「每日歌曲推荐」）
 *
 * 走每日推荐独立服务域：
 * `POST http://everydayrec.service.kugou.com/everyday/api/v1/more`
 * body `{ platform: 'Android', alldays: 1 }`，协议 A 签名（该域 https 证书不受信，只能走 http）。
 *
 * - 响应形状是 `{ status, error_code, data: { song_list[], song_list_size, mid, sign, bi_biz, OlexpIds } }`
 * - `data.song_list[]` 是每日推荐曲目，实测固定 30 首，字段是扁平口径
 *   （`hash` / `songname` / `author_name` / `time_length`（秒）/ `privilege` /
 *   `pay_type` / `album_audio_id` / `sizable_cover` / `filesize*`）
 * - `data.mid` 实测恒为空串，`data.bi_biz` 恒为 `rcmd_evd`
 *
 * ## 与网易云「每日推荐歌单」的差异（桌面端须知）
 *
 * 网易云的每日推荐是**真实歌单**，有歌单号，能走 `/playlist/detail` 取曲目。
 * 酷狗这边**不存在可供既有歌单接口消费的每日推荐歌单号**：
 * - 客户端二进制里每日推荐只有两个协议：`everyday_song_recommend`（主端点）与
 *   `everyday/api/v1/more`（换一批）；后者实测可用，前者对 12 种 body 口径
 *   （含 `EverydayRecommendV1` / `EverydayRecommendGZip` 两种客户端命名）
 *   一律返回 `error_code=200103`，且独立域与 `gateway.kugou.com` + `x-router`
 *   两条路由口径结果一致，取不到歌单号
 * - 主端点对应的客户端本地缓存 `kgx_dailyRec_<uid>` 里存的是**每日推荐歌单卡片**
 *   （`specialname` / `img` / `global_collection_id`），是歌单推荐位而不是「每日歌曲推荐」本身
 *
 * 因此本模块对外给出的是**按日期生成的稳定定位键**（`id` = `daily-<date>`）
 * 加上客户端侧的官方叫法作为名称；平台未下发歌单封面，封面取首曲专辑封面兜底；
 * 曲目随定位信息一并给出，因为平台侧不存在可供「既有歌单接口」消费的每日推荐歌单号。
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const {
  success,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { businessError } = require('./user_playlist_list')
const { normalizePoolSong } = require('./songfm')

const logger = createLogger('kugou')

/** 每日推荐端点路径 */
const KG_DAILY_PATH = '/everyday/api/v1/more'

/** 每日推荐端点所属域名（https 证书不受信，只能走 http） */
const KG_DAILY_BASE_URL = 'http://everydayrec.service.kugou.com'

/** 单次返回的曲目数默认值 */
const DEFAULT_LIMIT = 30

/** 单次返回的曲目数上限 */
const MAX_LIMIT = 100

/**
 * 取当天的日期串
 * @returns {string} `YYYYMMDD` 形式的日期串
 */
const today = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

/**
 * 读取每日推荐曲目
 * @param {{ token: string, userid: string }} session 酷狗会话凭据
 * @returns {Promise<Record<string, any>[]>} 上游曲目列表
 * @throws {Error} 酷狗返回业务错误时抛出
 */
const fetchDailySongs = async (session) => {
  const body = await kgGatewayRequest(
    KG_DAILY_PATH,
    { platform: 'Android', alldays: 1 },
    {
      method: 'POST',
      baseURL: KG_DAILY_BASE_URL,
      session,
    },
  )

  const error = businessError(body)
  if (error) throw new Error(error)

  const list = (body && body.data && body.data.song_list) || []
  return Array.isArray(list) ? list : []
}

module.exports = async (query = {}) => {
  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(query.limit) || DEFAULT_LIMIT),
  )

  let rawSongs
  try {
    rawSongs = await fetchDailySongs(session)
  } catch (err) {
    logger.warn('酷狗每日推荐获取失败：', err && err.message)
    return upstreamError(`酷狗每日推荐获取失败：${err && err.message}`)
  }

  const songs = rawSongs
    .map((item) => normalizePoolSong(item, 'daily'))
    .filter(Boolean)
    .slice(0, limit)

  if (!songs.length) {
    return upstreamError('酷狗每日推荐返回空曲目')
  }

  return success({
    code: 200,
    /** 平台无每日推荐歌单号，这里给按日期生成的稳定定位键 */
    id: `daily-${today()}`,
    name: '每日歌曲推荐',
    /** 平台未下发歌单封面，取首曲专辑封面兜底 */
    cover: songs[0].cover || '',
    coverSource: songs[0].cover ? 'song' : 'none',
    count: songs.length,
    date: today(),
    source: 'everydayrec',
    songs,
  })
}
