/**
 * QQ 音乐歌单广场与歌单详情
 *
 * 两种模式：
 * - 不传 `id`：歌单广场列表，走 `c.y.qq.com` 的
 *   `fcg_get_diss_by_tag.fcg`（按分类 / 排序取推荐歌单）
 * - 传 `id`：歌单详情与歌曲，走 `c.y.qq.com` 的
 *   `fcg_ucc_getcdinfo_byids_cp.fcg`（JSONP 响应）
 *
 * 这两个接口不走 musicu.fcg，因此自带 HTTP 头与超时，不复用 `core/request.js`。
 */

const { QM_HEADERS, QM_REFERER, DEFAULT_TIMEOUT_MS } = require('../core/config')
const { readSession } = require('../core/session')
const { sessionToCookieHeader } = require('../core/credential')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 歌单广场列表接口
 * @type {string}
 */
const SQUARE_URL =
  'https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg'

/**
 * 歌单详情接口
 * @type {string}
 */
const DETAIL_URL =
  'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg'

/**
 * 去掉搜索结果的命中高亮标签
 * @param {any} text 原始文本
 * @returns {string} 处理后的文本
 */
const stripHighlight = (text) =>
  typeof text === 'string' ? text.replace(/<\/?em>/g, '') : ''

/**
 * 拼接歌手名
 * @param {any} singers 歌手数组
 * @returns {string} 形如 `A / B` 的歌手名
 */
const formatSingerName = (singers) => {
  if (!Array.isArray(singers)) return ''
  return singers
    .map((item) => stripHighlight(item && item.name))
    .filter(Boolean)
    .join(' / ')
}

/**
 * 发起一次 GET 请求
 * @param {string} url 请求地址
 * @param {string | undefined} cookie Cookie 请求头
 * @returns {Promise<string>} 响应正文
 */
const fetchText = async (url, cookie) => {
  const headers = { ...QM_HEADERS, Referer: QM_REFERER }
  if (cookie) headers.Cookie = cookie

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`QQ 音乐歌单接口 HTTP ${response.status}`)
  }

  return response.text()
}

/**
 * 解析 JSONP 响应
 * @param {string} text 响应正文
 * @returns {any} 解析后的 JSON
 */
const parseJsonp = (text) => {
  const trimmed = String(text)
    .trim()
    .replace(/^jsonCallback\s*\(/, '')
    .replace(/\)\s*;?$/, '')
  return JSON.parse(trimmed)
}

/**
 * 归一化广场歌单条目
 * @param {any} item 接口返回的歌单条目
 * @returns {Record<string, any>} 归一化后的歌单条目
 */
const normalizeSquareItem = (item) => {
  const source = item || {}
  const creator = source.creator || {}
  return {
    id: String(source.dissid ?? ''),
    name: stripHighlight(source.dissname ?? ''),
    cover: stripHighlight(source.imgurl ?? ''),
    creator: stripHighlight(creator.name ?? ''),
    creatorUin: String(creator.qq ?? ''),
    playCount: source.listennum ?? 0,
    description: stripHighlight(source.introduction ?? ''),
    createTime: source.createtime ?? '',
    updateTime: source.commit_time ?? '',
  }
}

/**
 * 归一化歌单歌曲
 * @param {any} item 接口返回的歌曲条目
 * @returns {Record<string, any>} 归一化后的歌曲
 */
const normalizeSong = (item) => {
  const source = item || {}
  return {
    id: String(source.songid ?? ''),
    mid: source.songmid ?? '',
    name: stripHighlight(source.songname ?? ''),
    artist: formatSingerName(source.singer),
    artists: (Array.isArray(source.singer) ? source.singer : []).map(
      (singer) => ({
        id: String((singer && singer.id) ?? ''),
        mid: (singer && singer.mid) ?? '',
        name: stripHighlight((singer && singer.name) ?? ''),
      }),
    ),
    album: stripHighlight(source.albumname ?? ''),
    albumMid: source.albummid ?? '',
    duration: (source.interval ?? 0) * 1000,
    mediaMid: source.strMediaMid ?? '',
    pay: source.pay ?? {},
    size128: source.size128 ?? 0,
    size320: source.size320 ?? 0,
    sizeApe: source.sizeape ?? 0,
    sizeFlac: source.sizeflac ?? 0,
    sizeOgg: source.sizeogg ?? 0,
  }
}

/**
 * 取歌单广场列表
 * @param {any} query 调用参数
 * @param {string | undefined} cookie Cookie 请求头
 * @returns {Promise<Record<string, any>>} 归一化后的广场列表
 */
const fetchSquare = async (query, cookie) => {
  const limit = Math.max(1, Math.min(100, Number(query.limit) || 30))
  const page = Math.max(1, Number(query.page) || 1)
  const sin = (page - 1) * limit + 1
  const ein = sin + limit - 1
  const categoryId = String(query.categoryId ?? '10000000')
  const sortId = String(query.sortId ?? '5')

  const url =
    `${SQUARE_URL}?rnd=${Math.random().toFixed(16)}` +
    `&g_tk=5381&loginUin=0&hostUin=0&format=json` +
    `&inCharset=utf8&outCharset=utf-8&notice=0` +
    `&platform=yqq.json&needNewCode=0` +
    `&categoryId=${encodeURIComponent(categoryId)}` +
    `&sortId=${encodeURIComponent(sortId)}` +
    `&sin=${sin}&ein=${ein}`

  const data = JSON.parse(await fetchText(url, cookie))
  const body = data.data || {}
  const list = (body.list || []).map(normalizeSquareItem)

  return {
    mode: 'square',
    total: body.sum ?? list.length,
    page,
    limit,
    list,
    raw: data,
  }
}

/**
 * 取歌单详情与歌曲
 * @param {string} id 歌单号
 * @param {string | undefined} cookie Cookie 请求头
 * @returns {Promise<Record<string, any>>} 归一化后的歌单详情
 */
const fetchDetail = async (id, cookie) => {
  const url =
    `${DETAIL_URL}?type=1&json=1&utf8=1&onlysonglist=0` +
    `&platform=yqq&needNewCode=0&disstid=${encodeURIComponent(id)}`

  const data = parseJsonp(await fetchText(url, cookie))
  const cd = (data.cdlist || [])[0]

  if (!cd) {
    const err = new Error(data.msg ? `歌单不可访问: ${data.msg}` : '歌单不存在')
    err.notFound = true
    err.upstreamCode = data.subcode ?? data.code
    throw err
  }

  const songs = (cd.songlist || []).map(normalizeSong)

  return {
    mode: 'detail',
    id: String(cd.disstid ?? id),
    name: stripHighlight(cd.dissname ?? ''),
    description: stripHighlight(cd.desc ?? ''),
    creator: stripHighlight(cd.nickname || cd.nick || ''),
    cover: cd.logo ?? '',
    createTime: cd.ctime ?? 0,
    playCount: cd.visitnum ?? 0,
    commentCount: cd.cmtnum ?? 0,
    total: cd.songnum ?? songs.length,
    list: songs,
    raw: data,
  }
}

module.exports = async (query = {}) => {
  const id = String(query.id ?? query.disstid ?? '').trim()
  const session = readSession(query)
  const cookie = session ? sessionToCookieHeader(session.cookies) : undefined

  try {
    if (id) return success(await fetchDetail(id, cookie))
    return success(await fetchSquare(query, cookie))
  } catch (err) {
    if (err && err.notFound) {
      return {
        status: 404,
        body: {
          code: 404,
          message: err.message,
          upstreamCode: err.upstreamCode ?? null,
        },
        cookie: [],
      }
    }
    logger.error('QQ 音乐歌单获取异常:', err && err.message)
    return upstreamError(`QQ 音乐歌单获取失败: ${err && err.message}`)
  }
}
