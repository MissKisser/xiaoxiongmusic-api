/**
 * QQ 音乐：歌曲详情
 *
 * 支持用 mid 或数字 id 查询：
 * - 传 `mid` 时按 `song_mid` 检索
 * - 传 `id` 时按 `song_id` 检索（加歌接口需要数字 id）
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  badRequest,
  failure,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 专辑封面地址模板
 *
 * 专辑标识（mid 或 pmid）是 QQ 音乐图片资源的唯一标识，拼接后即可得到封面直链。
 * @type {string}
 */
const ALBUM_COVER_TEMPLATE =
  'https://y.gtimg.cn/music/photo_new/T002R300x300M000{albumMid}.jpg'

/**
 * info 段里承载图片的字段
 * @type {string[]}
 */
const INFO_PICTURE_FIELDS = ['picurl', 'ori_picurl']

/**
 * 把接口返回的标识字段解析为正整数
 * @param {unknown} value 原始值
 * @returns {number | undefined} 合法正整数，非法时返回 undefined
 */
const positiveInt = (value) => {
  const num =
    typeof value === 'string' && /^\d{1,15}$/.test(value)
      ? Number(value)
      : value
  return typeof num === 'number' && Number.isSafeInteger(num) && num > 0
    ? num
    : undefined
}

/**
 * 从响应中取出歌曲主体
 * @param {Record<string, any>} data 接口返回的数据段
 * @returns {Record<string, any> | null} 歌曲主体
 */
const pickTrack = (data) => {
  if (!data) return null
  if (data.track_info) return data.track_info
  if (data.song_info) return data.song_info
  if (Array.isArray(data.songs) && data.songs[0]) return data.songs[0]
  if (data.songid || data.mid) return data
  return null
}

/**
 * 从 info 段里取第一个可用图片地址
 *
 * info 段的每一项都带固定的图片字段，但绝大多数项为空串；
 * 只有少数曲目会在其中留下真实图片，因此这里遍历全部条目取首个非空值。
 * @param {any} info 接口返回的 info 数组
 * @returns {string} 图片地址，取不到时为空串
 */
const pickInfoPicture = (info) => {
  const entries = Array.isArray(info) ? info : []
  for (const entry of entries) {
    const content = Array.isArray(entry && entry.content) ? entry.content : []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      for (const field of INFO_PICTURE_FIELDS) {
        const value = item[field]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
  }
  return ''
}

/**
 * 取歌曲封面地址
 *
 * 优先用专辑标识拼出专辑封面直链：mid 优先，缺失时退到 pmid。
 * pmid 末尾的 `_0` / `_5` 之类后缀是图片资源的一部分，不能去掉。
 * 专辑标识也缺失时退到 info 段里的图片，两条路径都取不到则返回空串。
 * @param {Record<string, any>} track 歌曲主体
 * @param {any} info 接口返回的 info 数组
 * @returns {string} 封面地址，取不到时为空串
 */
const pickCover = (track, info) => {
  const album = (track && track.album) || {}
  const albumKey = String(album.mid || album.pmid || '').trim()
  if (albumKey) {
    return ALBUM_COVER_TEMPLATE.replace('{albumMid}', albumKey)
  }
  return pickInfoPicture(info)
}

/**
 * 取专辑名
 *
 * 专辑可能是对象也可能是字符串；对象里没有名字时只能退到空串，
 * 直接回传对象会被字符串化成无意义的占位文本。
 * @param {any} album 接口返回的专辑字段
 * @returns {string} 专辑名，取不到时为空串
 */
const pickAlbumName = (album) => {
  if (typeof album === 'string') return album.trim()
  if (!album || typeof album !== 'object') return ''
  const name = album.name || album.title
  return typeof name === 'string' ? name.trim() : ''
}

module.exports = async (query = {}) => {
  const mid = String(query.mid ?? query.song_mid ?? '').trim()
  const songId = positiveInt(query.id ?? query.song_id)
  if (!mid && !songId) return badRequest('mid 或 id required')

  const session = readSession(query)
  const cookies =
    session && typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : (session && session.cookies) || {}
  const uin = String(
    (session && session.uin) ||
      cookies.qm_str_musicid ||
      cookies.uin ||
      cookies.wxuin ||
      '',
  ).replace(/^o/, '')
  const authSession = session ? { ...session, uin, cookies } : null

  const param = mid
    ? { song_type: 0, song_mid: mid }
    : { song_num: 1, song_id: songId }

  try {
    const data = await qmRequest(
      'music.pf_song_detail_svr',
      'get_song_detail',
      param,
      { session: authSession },
    )

    const track = pickTrack(data)
    if (!track || (!track.id && !track.mid)) {
      return failure(404, { code: 404, message: '歌曲不存在' })
    }

    return success({
      id: track.id ?? songId ?? 0,
      mid: track.mid ?? mid,
      name: track.name ?? track.title ?? '',
      artist: (track.singer ?? [])
        .map((item) => item.name ?? '')
        .filter(Boolean)
        .join(' / '),
      album: pickAlbumName(track.album),
      duration: (track.interval ?? 0) * 1000,
      cover: pickCover(track, data && data.info),
    })
  } catch (err) {
    logger.error('读取歌曲详情异常:', err && err.message)
    return upstreamError(`读取歌曲详情失败: ${err && err.message}`)
  }
}
