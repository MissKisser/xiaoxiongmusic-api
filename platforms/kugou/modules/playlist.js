/**
 * 酷狗公开歌单详情
 *
 * 与「我的歌单」（云歌单）是两套东西：这里读的是酷狗对外公开的精选歌单
 * （special），任何人都能访问，不需要登录。
 *
 * 端点：
 * - 歌单信息：GET http://mobilecdn.kugou.com/api/v3/special/info
 * - 歌单歌曲：GET http://mobilecdn.kugou.com/api/v3/special/song
 */

const { kgRequest } = require('../core/request')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 单页最大歌曲数 */
const MAX_PAGE_SIZE = 300

/** HTML 实体表 */
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
 * @param {any} text 原始文本
 * @returns {string} 清洗后的文本
 */
const decodeName = (text) => {
  if (!text) return ''
  return String(text).replace(
    /&nbsp;|&amp;|&lt;|&gt;|&quot;|&apos;|&#039;/g,
    (entity) => ENTITY_MAP[entity] ?? entity,
  )
}

/**
 * 填充并安全化封面地址
 * @param {any} url 封面模板
 * @param {number} size 尺寸
 * @returns {string} 封面地址
 */
const fillCover = (url, size = 300) => {
  if (!url) return ''
  return String(url)
    .replace(/\{size\}/g, String(size))
    .replace(/^http:\/\//, 'https://')
}

/**
 * 把音质 hash 与体积整理成对外结构
 * @param {any} raw 原始歌曲条目
 * @returns {{ qualities: string[], hashes: Record<string, string>, sizes: Record<string, number> }} 音质信息
 */
const collectQualities = (raw) => {
  const hashes = {}
  const sizes = {}

  const put = (quality, hash, size) => {
    if (!hash || !size) return
    hashes[quality] = hash
    sizes[quality] = size
  }

  put('128k', raw.hash, raw.filesize)
  put('320k', raw['320hash'], raw['320filesize'])
  put('flac', raw.sqhash, raw.sqfilesize)
  put(
    'flac24bit',
    raw.hires_hash ?? raw.reshash,
    raw.hires_filesize ?? raw.resfilesize,
  )

  return { qualities: Object.keys(hashes), hashes, sizes }
}

/**
 * 拆分歌手串
 * @param {any} singername 原始歌手字段
 * @param {any} filename 原始文件名
 * @returns {string} 归一化后的歌手名
 */
const formatArtist = (singername, filename) => {
  if (singername) {
    return decodeName(singername)
      .split(/、|,|;|\//)
      .map((name) => name.trim())
      .filter(Boolean)
      .join(' / ')
  }
  const parts = String(filename || '').split(' - ')
  return parts.length > 1 ? decodeName(parts[0].trim()) : ''
}

/**
 * 归一化歌单歌曲
 * @param {any} raw 原始歌曲条目
 * @param {string} fallbackCover 兜底封面模板
 * @returns {any} 对外歌曲对象
 */
const normalizeSpecialSong = (raw, fallbackCover) => {
  const trans = raw.trans_param || {}
  const coverTemplate = trans.union_cover || fallbackCover
  const interval = Number(raw.duration || 0)
  const qualities = collectQualities(raw)

  const artistName = formatArtist(raw.singername, raw.filename)
  const parts = String(raw.filename || '').split(' - ')
  const songName = raw.songname
    ? decodeName(raw.songname)
    : decodeName(
        parts.length > 1 ? parts.slice(1).join(' - ').trim() : raw.filename,
      )

  return {
    id: String(raw.audio_id || raw.hash || ''),
    audioId: Number(raw.audio_id || 0),
    albumAudioId: Number(raw.album_audio_id || 0),
    hash: raw.hash || '',
    name: songName,
    artist: artistName,
    artists: artistName
      ? artistName.split(' / ').map((name) => ({ id: '', name }))
      : [],
    album: decodeName(raw.album_name),
    albumId: String(raw.album_id || ''),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    duration: interval * 1000,
    interval,
    qualities: qualities.qualities,
    hashes: qualities.hashes,
    sizes: qualities.sizes,
    pay: {
      payplay: Number(raw.pay_type || 0),
      privilege: Number(raw.privilege || 0),
      feetype: Number(raw.feetype || 0),
      pkgPrice: Number(raw.pkg_price || 0),
      price: Number(raw.price || 0),
    },
  }
}

/**
 * 读取酷狗公开歌单
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const specialId = String(
    query.id || query.specialid || query.special_id || '',
  ).trim()
  if (!specialId) return badRequest('id 不能为空')

  const page = Math.max(1, Number(query.page || 1) || 1)
  const pageSize = Math.max(
    1,
    Math.min(
      MAX_PAGE_SIZE,
      Number(query.pageSize || query.pagesize || MAX_PAGE_SIZE) ||
        MAX_PAGE_SIZE,
    ),
  )

  let info
  let songs
  let total

  try {
    const infoResponse = await kgRequest(
      `http://mobilecdn.kugou.com/api/v3/special/info?specialid=${encodeURIComponent(specialId)}&format=json`,
    )
    info = infoResponse.data || {}

    const songsResponse = await kgRequest(
      `http://mobilecdn.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(specialId)}&page=${page}&pagesize=${pageSize}&format=json`,
    )
    songs = (songsResponse.data && songsResponse.data.info) || []
    total = Number(
      (songsResponse.data && songsResponse.data.total) || songs.length,
    )
  } catch (err) {
    logger.warn('读取公开歌单失败：', err.message || err)
    return upstreamError(`读取公开歌单失败：${err.message || err}`)
  }

  const coverTemplate = info.imgurl || ''

  return success({
    code: 200,
    id: String(info.specialid || specialId),
    name: decodeName(info.specialname),
    description: decodeName(info.intro),
    creator: decodeName(info.nickname),
    creatorId: info.suid === undefined ? '' : String(info.suid),
    cover: fillCover(coverTemplate, 300),
    coverOriginal: fillCover(coverTemplate, 480),
    playCount: Number(info.playcount || 0),
    collectCount: Number(info.collectcount || 0),
    commentCount: Number(info.commentcount || 0),
    publishTime: info.publishtime || '',
    tags: (Array.isArray(info.tags) ? info.tags : []).map((tag) => ({
      id: String(tag.tagid || ''),
      name: tag.tagname || '',
    })),
    page,
    pageSize,
    total: Number(info.songcount || total || songs.length),
    songs: songs.map((song) => normalizeSpecialSong(song, coverTemplate)),
    raw: { info, songs },
  })
}
