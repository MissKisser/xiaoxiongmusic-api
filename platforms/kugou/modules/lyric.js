/**
 * 酷狗歌词
 *
 * 两步流程：
 *   1. GET lyrics.kugou.com/search?keyword=&hash=&timelength= → 取第一候选 {id, accesskey, fmt}
 *   2. GET lyrics.kugou.com/download?id=&accesskey=&fmt=       → base64 内容
 *      - fmt=krc：XOR + zlib 解密 → 行级 LRC + 逐字 KRC + 翻译 + 罗马音
 *      - fmt=lrc：base64 直接 UTF-8 解码 → 只有行级 LRC
 *
 * 酷狗要求同时提供 hash + 歌名 + 时长（秒），三者缺一时歌词匹配会失准。
 *
 * 公开读接口，不依赖登录态，免登录即可调用。
 *
 * @param {Record<string, any>} query 调用参数
 * @param {string} query.hash 文件 hash（搜索结果里的 hash / hashes['128k'] 等）
 * @param {string} [query.name] 歌曲名
 * @param {number | string} [query.duration] 时长（秒，或 `MM:SS` 形式的时长串）
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */

const { kgRequest } = require('../core/request')
const { decodeKrc } = require('../core/krc')
const { KG_LYRIC_DOWNLOAD_URL, KG_LYRIC_SEARCH_URL } = require('../core/config')
const {
  success,
  badRequest,
  failure,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 歌词接口伪装请求头 */
const KG_LYRIC_HEADERS = {
  'KG-RC': '1',
  'KG-THash': 'expand_search_manager.cpp:852736169:451',
  'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
}

/**
 * 把时长统一换算成秒
 *
 * 兼容秒数（number）与 `MM:SS` / `HH:MM:SS` 形式的时长串。
 * @param {number | string | undefined} interval 时长
 * @returns {number} 秒数，缺省时返回 0
 */
const intervalToSeconds = (interval) => {
  if (typeof interval === 'number') return Math.floor(interval)
  if (!interval) return 0
  const parts = String(interval).split(':').map(Number)
  let seconds = 0
  let unit = 1
  while (parts.length) {
    const value = parts.pop()
    if (Number.isFinite(value)) seconds += value * unit
    unit *= 60
  }
  return Math.floor(seconds)
}

/**
 * 查候选歌词
 * @param {{ hash: string, name: string, seconds: number }} params 查询条件
 * @returns {Promise<any>} 酷狗歌词搜索响应体
 */
const searchCandidates = async ({ hash, name, seconds }) => {
  const url =
    `${KG_LYRIC_SEARCH_URL}?ver=1&man=yes&client=pc&lrctxt=1` +
    `&keyword=${encodeURIComponent(name)}` +
    `&hash=${encodeURIComponent(hash)}` +
    `&timelength=${seconds}`
  return kgRequest(url, { headers: KG_LYRIC_HEADERS })
}

/**
 * 下载候选歌词的 base64 内容
 * @param {{ id: string, accesskey: string, fmt: string }} candidate 候选歌词
 * @returns {Promise<any>} 酷狗歌词下载响应体
 */
const downloadLyric = async ({ id, accesskey, fmt }) => {
  const url =
    `${KG_LYRIC_DOWNLOAD_URL}?ver=1&client=pc&charset=utf8` +
    `&id=${encodeURIComponent(id)}` +
    `&accesskey=${encodeURIComponent(accesskey)}` +
    `&fmt=${fmt}`
  return kgRequest(url, { headers: KG_LYRIC_HEADERS })
}

/**
 * 取一首歌的歌词
 * @param {Record<string, any>} [query] 调用参数
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const hash = String(query.hash || '').trim()
  if (!hash) return badRequest('hash 不能为空')

  const name = String(query.name || '').trim()
  const seconds = intervalToSeconds(query.duration)

  let searchResp
  try {
    searchResp = await searchCandidates({ hash, name, seconds })
  } catch (err) {
    logger.warn('查询酷狗歌词候选失败：', err.message || err)
    return upstreamError(`查询酷狗歌词候选失败：${err.message || err}`)
  }

  const candidates =
    searchResp && Array.isArray(searchResp.candidates)
      ? searchResp.candidates
      : []
  const candidate = candidates[0]
  if (!candidate) {
    return failure(404, {
      code: 404,
      message: '未找到匹配的歌词',
      hash,
      name,
      raw: { search: searchResp },
    })
  }

  // 逐字歌词且非纯翻译内容时才走 KRC 通道
  const fmt =
    candidate.krctype === 1 && candidate.contenttype !== 1 ? 'krc' : 'lrc'

  let downloadResp
  try {
    downloadResp = await downloadLyric({
      id: String(candidate.id || ''),
      accesskey: String(candidate.accesskey || ''),
      fmt,
    })
  } catch (err) {
    logger.warn('下载酷狗歌词失败：', err.message || err)
    return upstreamError(`下载酷狗歌词失败：${err.message || err}`)
  }

  const content = downloadResp && downloadResp.content
  if (!content) {
    return failure(404, {
      code: 404,
      message: '歌词内容为空',
      hash,
      name,
      raw: { search: searchResp, download: downloadResp },
    })
  }

  const raw = { search: searchResp, download: downloadResp }
  const responseFmt = String(downloadResp.fmt || fmt)

  if (responseFmt === 'krc') {
    let parsed
    try {
      parsed = await decodeKrc(content)
    } catch (err) {
      logger.warn('解密酷狗 KRC 歌词失败：', err.message || err)
      return upstreamError(`解密酷狗 KRC 歌词失败：${err.message || err}`, {
        raw,
      })
    }

    return success({
      code: 200,
      hash,
      name,
      duration: seconds,
      fmt: 'krc',
      lrc: parsed.lrc,
      krc: parsed.krc,
      trans: parsed.trans || undefined,
      roma: parsed.roma || undefined,
      raw,
    })
  }

  if (responseFmt === 'lrc') {
    return success({
      code: 200,
      hash,
      name,
      duration: seconds,
      fmt: 'lrc',
      lrc: Buffer.from(content, 'base64').toString('utf8'),
      raw,
    })
  }

  return upstreamError(`未知的酷狗歌词格式：${responseFmt}`, { raw })
}
