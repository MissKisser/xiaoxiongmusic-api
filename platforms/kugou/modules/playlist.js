/**
 * 酷狗公开歌单详情
 *
 * 与「我的歌单」（云歌单）是两套东西：这里读的是酷狗对外公开的精选歌单
 * （special），任何人都能访问，不需要登录。
 *
 * 端点：
 * - 歌单信息：GET http://mobilecdn.kugou.com/api/v3/special/info
 * - 歌单歌曲：GET http://mobilecdn.kugou.com/api/v3/special/song
 * - 专辑信息：POST /kmr/v2/albums（x-router `openapi.kugou.com`，kg-tid 255）
 * - 专辑信息兜底：GET http://mobilecdn.kugou.com/api/v3/album/info
 *
 * 歌单歌曲条目只带 `album_id`、不带专辑名，因此要按 album_id 反查专辑名：
 * 优先走网关的批量接口（单次上限 50 个 album_id），失败时回落 mobilecdn
 * 的单专辑接口。
 *
 * 歌名口径：歌名剥离规则由 `../core/song_title` 统一提供，与云歌单详情、
 * 加歌写入三处共用同一实现，同一首歌在任何页面显示的都是同一个名字。
 */

const { kgGatewayRequest, kgRequest, kgErrorCode } = require('../core/request')
const { readSession } = require('../core/session')
const { extractSongTitle } = require('../core/song_title')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 单页最大歌曲数 */
const MAX_PAGE_SIZE = 300

/** 网关单次批量解析的专辑数量上限，超过会返回 `error_code=20010` */
const ALBUM_BATCH_SIZE = 50

/** 专辑信息批量请求的并发上限 */
const ALBUM_CONCURRENCY = 4

/**
 * 解析源歌单的全局标识
 *
 * `global_specialid` 形如 `collection_3_<源用户id>_<源云歌单号>_0`，
 * 其中第三段是源歌单作者、第四段是源歌单在该作者账号下的云歌单号。
 * 这两个值才是上游认可的「源歌单身份」：直接拿精选号当云歌单号提交，
 * 上游会以 error_code=30203 拒收。
 * @param {string} globalSpecialid 源歌单全局标识
 * @returns {{ userid: string, listid: string }} 源歌单作者与云歌单号
 */
const parseGlobalSpecialid = (globalSpecialid) => {
  const parts = String(globalSpecialid || '').split('_')
  return { userid: parts[2] || '', listid: parts[3] || '' }
}

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
 * 从歌曲条目里取专辑名
 *
 * 各端点的专辑名字段并不统一：网关为 `album_info.album_name`，云歌单为
 * `albuminfo.name`，而公开歌单的歌曲条目完全不带专辑名（只有 `album_id`），
 * 此时要按 album_id 反查。
 * @param {any} raw 原始歌曲条目
 * @returns {string} 专辑名，取不到时返回空串
 */
const pickAlbumName = (raw) => {
  const info = raw.albuminfo || raw.album_info || {}
  const candidate =
    raw.album_name || raw.albumname || info.name || info.album_name || ''
  return decodeName(candidate)
}

/**
 * 把数组切成固定长度的分片
 * @param {any[]} items 原数组
 * @param {number} size 每片长度
 * @returns {any[][]} 分片结果
 */
const chunk = (items, size) => {
  const result = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}

/**
 * 以受限并发执行任务
 * @param {any[]} items 任务输入
 * @param {number} limit 并发上限
 * @param {(item: any) => Promise<any>} worker 单个任务的执行器
 * @returns {Promise<any[]>} 各任务结果，顺序与输入一致
 */
const mapWithLimit = async (items, limit, worker) => {
  const results = new Array(items.length)
  let cursor = 0

  const runner = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }

  const workers = []
  const count = Math.min(limit, items.length)
  for (let i = 0; i < count; i += 1) workers.push(runner())
  await Promise.all(workers)
  return results
}

/**
 * 批量解析专辑信息
 *
 * 公开歌单的歌曲条目只有 `album_id`，专辑名要按 album_id 反查。优先走网关的
 * 批量接口（单次上限 50 个 album_id，超出会返回 `error_code=20010`），
 * 网关拿不到的再逐个回落 mobilecdn 的单专辑接口。
 * @param {string[]} albumIds 去重后的专辑 ID
 * @param {any} session 酷狗会话凭据，可为空
 * @returns {Promise<Map<string, { name: string, cover: string }>>} 专辑信息表
 */
const resolveAlbums = async (albumIds, session) => {
  const albums = new Map()
  if (albumIds.length === 0) return albums

  const pending = [...albumIds]

  await mapWithLimit(
    chunk(pending, ALBUM_BATCH_SIZE),
    ALBUM_CONCURRENCY,
    async (batch) => {
      try {
        const response = await kgGatewayRequest(
          '/kmr/v2/albums',
          {
            data: batch.map((id) => ({ album_id: id })),
            fields: 'album_id,album_name,sizable_cover',
          },
          {
            method: 'POST',
            headers: { 'x-router': 'openapi.kugou.com', 'kg-tid': '255' },
            session,
          },
        )
        if (kgErrorCode(response) !== 0) return

        const list = Array.isArray(response.data) ? response.data : []
        list.forEach((item) => {
          const id = String(item.album_id || '')
          if (!id || !item.album_name) return
          albums.set(id, {
            name: decodeName(item.album_name),
            cover: fillCover(item.sizable_cover, 300),
          })
        })
      } catch (err) {
        logger.warn('批量解析专辑信息失败：', err.message || err)
      }
    },
  )

  const rest = pending.filter((id) => !albums.has(id))
  if (rest.length === 0) return albums

  await mapWithLimit(rest, ALBUM_CONCURRENCY, async (id) => {
    try {
      const response = await kgRequest(
        `http://mobilecdn.kugou.com/api/v3/album/info?albumid=${encodeURIComponent(id)}&format=json`,
      )
      const detail = response.data || {}
      if (!detail.albumname) return
      albums.set(id, {
        name: decodeName(detail.albumname),
        cover: fillCover(detail.imgurl, 300),
      })
    } catch (err) {
      logger.warn('解析专辑信息失败：', err.message || err)
    }
  })

  return albums
}

/**
 * 归一化歌单歌曲
 * @param {any} raw 原始歌曲条目
 * @param {string} fallbackCover 兜底封面模板
 * @param {Map<string, { name: string, cover: string }>} albums 专辑信息表
 * @returns {any} 对外歌曲对象
 */
const normalizeSpecialSong = (raw, fallbackCover, albums) => {
  const trans = raw.trans_param || {}
  const albumId = String(raw.album_id || '')
  const album = albums.get(albumId)
  const coverTemplate =
    trans.union_cover || (album && album.cover) || fallbackCover
  const interval = Number(raw.duration || 0)
  const qualities = collectQualities(raw)

  const artistName = formatArtist(raw.singername, raw.filename)
  // 公开歌单条目没有歌手字段，只有 `filename`（形态为「歌手 - 歌名」，无扩展名），
  // 剥离规则由 `../core/song_title` 统一提供：按「首段是歌手」的约定取歌名。
  const songName =
    decodeName(extractSongTitle(raw.filename, { artistPrefix: true })) ||
    decodeName(raw.songname || '')

  return {
    id: String(raw.audio_id || raw.hash || ''),
    audioId: Number(raw.audio_id || 0),
    albumAudioId: Number(raw.album_audio_id || 0),
    /** 歌曲主键（album_audio_id 口径），查评论、签播放地址都用它 */
    mixSongId: String(raw.album_audio_id || ''),
    hash: raw.hash || '',
    name: songName,
    artist: artistName,
    artists: artistName
      ? artistName.split(' / ').map((name) => ({ id: '', name }))
      : [],
    album: pickAlbumName(raw) || (album ? album.name : ''),
    albumId,
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
/**
 * 读取酷狗公开歌单
 *
 * 收藏歌单的源歌单是公开歌单时，「我的歌单」详情据此解析源歌单曲目，
 * 故这里把读取逻辑单独导出，供公开歌单模块与「我的歌单」模块共用。
 * @param {string} specialId 公开歌单号
 * @param {number} page 页码，从 1 开始
 * @param {number} pageSize 每页数量
 * @param {any} session 酷狗会话凭据，可为空
 * @returns {Promise<any>} 歌单头部与曲目
 */
const readPublicPlaylist = async (specialId, page, pageSize, session) => {
  const infoResponse = await kgRequest(
    `http://mobilecdn.kugou.com/api/v3/special/info?specialid=${encodeURIComponent(specialId)}&format=json`,
  )
  const info = infoResponse.data || {}

  const songsResponse = await kgRequest(
    `http://mobilecdn.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(specialId)}&page=${page}&pagesize=${pageSize}&format=json`,
  )
  const songs = (songsResponse.data && songsResponse.data.info) || []
  const total = Number(
    (songsResponse.data && songsResponse.data.total) || songs.length,
  )

  const coverTemplate = info.imgurl || ''

  const globalSpecialid = String(info.global_specialid || '')
  const source = parseGlobalSpecialid(globalSpecialid)

  // 歌曲条目不带专辑名，按 album_id 批量反查
  const albumIds = [
    ...new Set(
      songs.map((song) => String(song.album_id || '')).filter(Boolean),
    ),
  ]
  let albums = new Map()
  try {
    albums = await resolveAlbums(albumIds, session)
  } catch (err) {
    logger.warn('解析歌单专辑信息失败：', err.message || err)
  }

  return {
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
    total: Number(info.songcount || total || songs.length),
    /** 源歌单的全局标识 `collection_3_<源用户id>_<源云歌单号>_0` */
    globalSpecialid,
    /** 源歌单在源账号下的云歌单号 */
    sourceListid: source.listid,
    /** 源歌单作者 userid */
    sourceUserid: source.userid,
    /** 歌单涉及的专辑，按专辑 ID 索引 */
    albums: [...albums.entries()].map(([albumId, album]) => ({
      id: albumId,
      name: album.name,
      cover: album.cover,
    })),
    songs: songs.map((song) =>
      normalizeSpecialSong(song, coverTemplate, albums),
    ),
    /** 上游原始响应 */
    raw: { info, songs },
  }
}

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

  let detail

  try {
    detail = await readPublicPlaylist(
      specialId,
      page,
      pageSize,
      readSession(query),
    )
  } catch (err) {
    logger.warn('读取公开歌单失败：', err.message || err)
    return upstreamError(`读取公开歌单失败：${err.message || err}`)
  }

  return success({
    code: 200,
    ...detail,
    page,
    pageSize,
  })
}

module.exports.readPublicPlaylist = readPublicPlaylist
module.exports.parseGlobalSpecialid = parseGlobalSpecialid
