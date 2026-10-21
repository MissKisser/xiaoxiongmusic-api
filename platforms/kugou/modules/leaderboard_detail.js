/**
 * 酷狗音乐单个榜单详情
 *
 * 走 `GET http://mobilecdn.kugou.com/api/v3/rank/song?rankid=<id>&page=<n>&pagesize=<n>`：
 * - `data.info` 是榜单曲目明细，每曲自带歌名、歌手（`authors` 数组）、`hash`、
 *   `album_audio_id`、`audio_id`、`duration`（**单位是秒**）、`sort`（榜内排名）
 *   与 `privilege` / `pay_type`（授权与付费标记）
 * - `data.total` 是榜单曲目总数（TOP500 为 500）
 *
 * 榜单元信息另走 `GET http://mobilecdn.kugou.com/api/v3/rank/info?rankid=<id>`：
 * 该端点只给榜单名、简介与封面；期数与发布时间取自曲目条目。
 *
 * 端点只能走 `http://`：`mobilecdn.kugou.com` 的 https 证书不受信，握手会失败。
 *
 * 曲目主键是 `hash` 与 `album_audio_id` 的组合，签播放地址时两者都要，模块原样保留。
 *
 * 榜单号来自榜单清单（见 `leaderboard_list`），TOP500 为 8888。
 */

const { kgRequest } = require('../core/request')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 榜单曲目端点（https 证书不受信，只能走 http） */
const KG_RANK_SONG_URL = 'http://mobilecdn.kugou.com/api/v3/rank/song'

/** 榜单元信息端点 */
const KG_RANK_INFO_URL = 'http://mobilecdn.kugou.com/api/v3/rank/info'

/** 默认榜单号（TOP500） */
const DEFAULT_RANKID = 8888

/** 默认每页条数 */
const DEFAULT_LIMIT = 50

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
 * 填充并安全化酷狗图片模板中的尺寸占位符
 *
 * 口径：模块层就把 `{size}` 换成实际尺寸（`cover` 用 300、`coverOriginal` 用 480），
 * 与本平台其他模块（搜索 / 专辑 / 歌单）保持一致，渲染端拿到即可直接用。
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
 * 归一化榜单曲目
 *
 * 时长口径：上游 `duration` 是秒，对外 `duration` 换算成毫秒、`interval` 保留秒。
 * 付费判据取基档授权位 `privilege`（`0` / `8` 可免费播，其余为会员墙）。
 * 试听判据取 `trans_param.hash_offset.end_ms`：有值即存在试听片段。
 * @param {any} raw 上游曲目条目
 * @returns {Record<string, any>} 归一化后的曲目
 */
const normalizeSong = (raw) => {
  const source = raw || {}
  const trans = source.trans_param || {}
  const authors = Array.isArray(source.authors) ? source.authors : []

  const authorNames = authors
    .map((author) => author && author.author_name)
    .filter(Boolean)
  const artistName = authorNames.length
    ? decodeName(authorNames.join(' / '))
    : ''
  const artists = authors.map((author) => ({
    id:
      author && author.author_id !== undefined ? String(author.author_id) : '',
    name: decodeName((author && author.author_name) || ''),
  }))

  const filename = String(source.filename || '')
  const name = decodeName(
    source.songname ||
      (filename ? filename.split(' - ').slice(1).join(' - ') : ''),
  )

  const coverTemplate = trans.union_cover || source.album_sizable_cover || ''
  const interval = Number(source.duration || 0)

  const hashes = {}
  const sizes = {}
  const put = (quality, hash, size) => {
    if (!hash || !size) return
    hashes[quality] = String(hash)
    sizes[quality] = Number(size)
  }
  put('128k', source.hash, source.filesize)
  put('320k', source['320hash'], source['320filesize'])
  put('flac', source.sqhash, source.sqfilesize)
  put('flac24bit', source.hash_high, source.filesize_high)

  const hashOffset = trans.hash_offset || null
  const trialDuration = Number((hashOffset && hashOffset.end_ms) || 0)

  return {
    id: String(source.audio_id || source.hash || ''),
    mid: '',
    audioId: Number(source.audio_id || 0),
    albumAudioId: Number(source.album_audio_id || 0),
    /** 歌曲主键（album_audio_id 口径），签播放地址用它 */
    mixSongId: String(source.album_audio_id || ''),
    hash: String(source.hash || ''),
    name,
    artist: artistName,
    artists,
    album: '',
    albumMid: '',
    albumId: String(source.album_id || ''),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    duration: interval * 1000,
    interval,
    rank: Number(source.sort || 0),
    qualities: Object.keys(hashes),
    hashes,
    sizes,
    pay: {
      payplay: Number(source.pay_type || 0),
      privilege: Number(source.privilege || 0),
      feetype: Number(source.feetype || 0),
      pkgPrice: Number(source.pkg_price || 0),
      price: Number(source.price || 0),
    },
    trial: {
      available: trialDuration > 0,
      duration: trialDuration,
    },
    file: {},
  }
}

/**
 * 读取榜单元信息（榜单名、简介、封面）
 *
 * 元信息端点不可用时不影响曲目返回，由调用方拿到空元信息。
 * @param {number} rankid 榜单号
 * @returns {Promise<Record<string, any> | null>} 榜单元信息，取不到时返回 null
 */
const fetchBoardMeta = async (rankid) => {
  try {
    const body = await kgRequest(
      `${KG_RANK_INFO_URL}?rankid=${encodeURIComponent(rankid)}&format=json`,
    )
    const data = (body && body.data) || null
    if (!data || typeof data !== 'object') return null
    return {
      title: decodeName(data.rankname || ''),
      intro: decodeName(data.intro || ''),
      cover: fillCover(data.imgurl, 300),
      coverOriginal: fillCover(data.imgurl, 480),
    }
  } catch (err) {
    logger.warn('酷狗榜单元信息获取失败：', err && err.message)
    return null
  }
}

module.exports = async (query = {}) => {
  const rankid = Number(
    query.rankid ?? query.rank_id ?? query.id ?? query.topid ?? DEFAULT_RANKID,
  )
  if (!rankid) return badRequest('rankid 不能为空')

  const page = Math.max(1, Number(query.page ?? 1) || 1)
  const limit = Math.max(
    1,
    Number(query.limit ?? query.pagesize ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
  )

  try {
    const body = await kgRequest(
      `${KG_RANK_SONG_URL}?rankid=${rankid}&page=${page}&pagesize=${limit}`,
    )
    const info = (body && body.data && body.data.info) || []
    if (!Array.isArray(info)) {
      return upstreamError('酷狗榜单详情获取失败：上游响应缺少曲目列表')
    }

    const songs = info.map(normalizeSong)
    const meta = await fetchBoardMeta(rankid)
    const first = info[0] || {}

    const ranks = songs.map((song) => ({
      rank: song.rank,
      songId: song.mixSongId,
      title: song.name,
      singer: song.artist,
      singerMid: '',
      albumMid: '',
      cover: song.cover,
    }))

    return success({
      code: 200,
      topid: rankid,
      rankid,
      title: (meta && meta.title) || '',
      subTitle: '',
      intro: (meta && meta.intro) || '',
      cover: (meta && meta.cover) || '',
      coverOriginal: (meta && meta.coverOriginal) || '',
      period: first.issue === undefined ? '' : String(first.issue),
      updateTime: first.rank_id_publish_date || '',
      listenCount: 0,
      total: Number((body && body.data && body.data.total) || songs.length),
      page,
      limit,
      songs,
      ranks,
    })
  } catch (err) {
    logger.error('酷狗榜单详情获取异常:', err && err.message)
    return upstreamError(`酷狗榜单详情获取失败: ${err && err.message}`)
  }
}
