/**
 * QQ 音乐播放地址解析辅助
 *
 * 播放地址走的是 vkey 协议，请求体是 `{ comm, req_0: { module, method, param } }`
 * 的旧式结构，与平台层其余接口使用的 `{ comm, request: { module, method, param } }`
 * 不同，因此这里单独实现一次直连请求。
 *
 * 音质策略：一次请求把所有候选档位的文件名都报上去，接口只会给有权限的档位
 * 返回有效直链，因此按「首选档位 → 更低档位」的顺序取第一个命中的即为最高可用音质。
 *
 * 无状态约束：
 * - 凭据只从入参取，不持有任何模块级状态
 * - 每次请求独立生成 guid，不做跨请求缓存
 */

const { randomUUID } = require('node:crypto')

const { QM_API_URL, QM_REFERER, DEFAULT_TIMEOUT_MS } = require('./config')
const { sessionToCookieHeader } = require('./credential')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 播放地址请求使用的网页端 UA
 * @type {string}
 */
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/**
 * 音质档位候选表，按音质从高到低排列
 * @type {Array<{ prefix: string, ext: string, level: string, label: string }>}
 */
const QUALITY_CANDIDATES = [
  { prefix: 'AI00', ext: '.flac', level: 'hi-res', label: 'Hi-Res FLAC' },
  { prefix: 'F000', ext: '.flac', level: 'lossless', label: '无损 FLAC' },
  { prefix: 'M800', ext: '.mp3', level: 'hq', label: '320k MP3' },
  { prefix: 'M500', ext: '.mp3', level: 'sq', label: '128k MP3' },
  { prefix: 'C400', ext: '.m4a', level: 'lq', label: '标准 AAC' },
]

/**
 * 按首选音质生成顺位候选列表
 *
 * 首选档位不存在时返回完整列表，交给接口决定可用音质。
 * @param {string} preferredLevel 首选音质档位
 * @returns {Array<{ prefix: string, ext: string, level: string, label: string }>} 候选档位列表
 */
const getQualityCandidates = (preferredLevel) => {
  const target = String(preferredLevel || 'hq').toLowerCase()
  const index = QUALITY_CANDIDATES.findIndex((item) => item.level === target)
  if (index >= 0) return QUALITY_CANDIDATES.slice(index)
  return QUALITY_CANDIDATES
}

/**
 * 计算 QQ 系 CSRF token
 * @param {string} str 参与计算的字符串
 * @param {number} [seed] 初始种子
 * @returns {number} 32 位无符号整数
 */
const hash33 = (str, seed = 0) => {
  let h = seed
  for (const ch of str) {
    h = (((h << 5) + h + ch.codePointAt(0)) & 0xffffffff) >>> 0
  }
  return h & 2147483647
}

/**
 * 播放地址解析结果
 * @typedef {object} SongUrlResult
 * @property {boolean} ok 是否拿到可用直链
 * @property {string} [url] 播放地址
 * @property {string} [level] 命中的音质档位
 * @property {string} [label] 命中音质的中文说明
 * @property {string} [format] 音频格式
 * @property {boolean} [isFallback] 是否降级到低于首选档位的音质
 * @property {string[]} [triedLevels] 本次尝试的音质档位
 * @property {string} [reason] 失败原因
 * @property {any} [raw] vkey 接口原始返回
 */

/**
 * 请求一次 vkey，取回播放地址
 * @param {object} options 请求选项
 * @param {string} options.mid 歌曲 mid
 * @param {string} [options.mediaMid] 媒体 mid，缺省时用 `mid + mid`
 * @param {string} [options.level] 首选音质档位
 * @param {string} [options.uin] 登录账号 ID
 * @param {Record<string, string>} [options.cookies] 登录凭据
 * @param {number} [options.timeoutMs] 请求超时毫秒数
 * @returns {Promise<SongUrlResult>} 播放地址解析结果
 */
const requestSongUrl = async (options) => {
  const {
    mid,
    mediaMid = '',
    level = 'hq',
    uin = '',
    cookies = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const fileBase = mediaMid || `${mid}${mid}`
  const targetLevel = String(level || 'hq')
  const candidates = getQualityCandidates(targetLevel)
  const filenames = candidates.map(
    (item) => `${item.prefix}${fileBase}${item.ext}`,
  )
  const triedLevels = candidates.map((item) => item.level)

  const musickey = cookies.qm_keyst || cookies.qqmusic_key || ''
  const gtk = hash33(musickey, 5381)
  const guid = randomUUID().replace(/-/g, '')
  const account = uin && uin !== '0' ? uin : ''
  const cookieHeader = sessionToCookieHeader(cookies)

  const body = {
    comm: {
      uin: account,
      format: 'json',
      ct: 24,
      cv: 4747474,
      platform: 'yqq.json',
      chid: '0',
      g_tk: gtk,
      g_tk_new_20200303: gtk,
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      needNewCode: 1,
    },
    req_0: {
      module: 'music.vkey.GetVkey',
      method: 'UrlGetVkey',
      param: {
        guid,
        songmid: filenames.map(() => mid),
        filename: filenames,
        songtype: filenames.map(() => 0),
        uin: account,
        ctx: 0,
        loginflag: 1,
        platform: '20',
      },
    },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let json
  try {
    const response = await fetch(QM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        Referer: QM_REFERER,
        Origin: 'https://y.qq.com',
        'User-Agent': WEB_UA,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    json = await response.json()
  } finally {
    clearTimeout(timer)
  }

  const inner = json && json.req_0
  const data =
    json && json.code === 0 && inner && inner.code === 0 ? inner.data : null
  const infos = (data && data.midurlinfo) || []
  const sip =
    ((data && data.sip) || []).find((item) =>
      String(item).startsWith('http'),
    ) || 'https://isure.stream.qqmusic.qq.com/'

  for (const candidate of candidates) {
    const filename = `${candidate.prefix}${fileBase}${candidate.ext}`
    const found = infos.find(
      (item) => item && item.filename === filename && item.purl,
    )
    if (!found) continue

    const purl = String(found.purl)
    logger.info(
      `播放地址命中: ${mid} -> ${candidate.label} (${candidate.level})`,
    )
    return {
      ok: true,
      url: purl.startsWith('http') ? purl : `${sip}${purl}`,
      level: candidate.level,
      label: candidate.label,
      format: candidate.ext.replace('.', ''),
      isFallback: candidate.level !== targetLevel,
      triedLevels,
      raw: json,
    }
  }

  logger.warn('vkey 未返回可用播放地址:', mid, targetLevel)
  return { ok: false, reason: 'no_url', triedLevels, raw: json }
}

module.exports = {
  QUALITY_CANDIDATES,
  getQualityCandidates,
  hash33,
  requestSongUrl,
}
