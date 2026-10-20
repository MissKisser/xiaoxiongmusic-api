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
 * filename 口径：文件名形如 `{档位前缀}{base}{扩展名}`，base 取自候选列表。
 * - 首选 base 是**媒体 mid 单个**（`file.media_mid`），与上游实际下发的直链文件名一致
 * - 兜底 base 是**歌曲 mid×2**
 * - **不要用歌曲 mid 单个**：上游会回 result=0 与非空 purl，但直链下载会 404，
 *   属于「看起来成功、实际不可用」的陷阱
 *
 * 错误分级（由 `midurlinfo[].result` 与歌曲付费标记共同判定）：
 * - need_pay          整首付费歌，当前账号无播放权限
 * - no_authorization  免费歌也拿不到授权
 * - filename_rejected 上游未接受该文件名
 * - vkey_error        上游返回其它异常码，或没给出可用结果
 *
 * 试听分支：正式音质全部拿不到直链时，再按 `RS02{媒体 mid}.mp3` 探一次，
 * 付费歌会由官方下发 60 秒试听片段，命中时 `level` 为 `trial`、`isTrial` 为 true。
 * 试听文件名的口径已实测定案：只用 `.mp3` 后缀、base 取单个媒体 mid
 * （不能空格分隔多个 mid）、请求不带 `songid` 参数、匿名登录态同样可用。
 *
 * 无状态约束：
 * - 凭据只从入参取，不持有任何模块级状态
 * - 每次请求独立生成 guid，不做跨请求缓存
 */

const { randomUUID } = require('node:crypto')

const {
  QM_API_URL,
  QM_REFERER,
  QM_HEADERS,
  MOBILE_COMM,
  DEFAULT_TIMEOUT_MS,
} = require('./config')
const { sessionToCookieHeader } = require('./credential')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/** 试听直链的文件名前缀 */
const TRIAL_PREFIX = 'RS02'

/** 试听直链的文件扩展名 */
const TRIAL_EXT = '.mp3'

/** 试听音质档位标识 */
const TRIAL_LEVEL = 'trial'

/** 试听音质说明 */
const TRIAL_LABEL = '试听片段'

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
 * 允许原样回传的 vkey 结果字段
 *
 * 其余字段（`purl` / `vkey` / `ekey` / 各类直链与 `auth_switch`）都带凭证或
 * 播放票据，一律不进 `raw`，避免播放凭证随日志、文档外泄。
 * @type {string[]}
 */
const RAW_ITEM_FIELDS = [
  'filename',
  'songmid',
  'mid',
  'result',
  'subcode',
  'isbuy',
  'onecan',
  'isonly',
  'pneed',
  'pneedbuy',
  'hisbuy',
  'hisdown',
  'errtype',
  'premain',
  'pdl',
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
 * 生成 filename 的 base 候选列表
 *
 * 首选是媒体 mid 单个，兜底是歌曲 mid×2。两者都实测可下载到真实音频。
 * @param {string} mid 歌曲 mid
 * @param {string} mediaMid 媒体 mid，缺省时只保留歌曲 mid×2
 * @returns {string[]} base 候选列表，顺序即优先级
 */
const getBaseCandidates = (mid, mediaMid) => {
  const bases = []
  const push = (value) => {
    if (!value) return
    if (bases.includes(value)) return
    bases.push(value)
  }
  push(mediaMid)
  push(`${mid}${mid}`)
  if (mediaMid && mediaMid !== mid) push(`${mediaMid}${mediaMid}`)
  return bases
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
 * 收敛 vkey 响应，只保留业务段
 *
 * 只保留 `code`、`req_0.code` 与脱敏后的 `midurlinfo[]`，
 * 剥离 `comm` 与所有带凭证的字段。
 * @param {any} json vkey 接口原始响应
 * @param {any[]} infos 原始 `midurlinfo` 列表
 * @returns {{ code: number, req_0: { code: number, data: { midurlinfo: any[] } } }} 收敛后的响应
 */
const sanitizeRaw = (json, infos) => {
  const inner = (json && json.req_0) || {}
  return {
    code: json && json.code !== undefined ? json.code : 0,
    req_0: {
      code: inner.code !== undefined ? inner.code : 0,
      data: {
        midurlinfo: (infos || []).map((info) => {
          const item = {}
          for (const field of RAW_ITEM_FIELDS) {
            if (info && info[field] !== undefined) item[field] = info[field]
          }
          return item
        }),
      },
    },
  }
}

/**
 * 判定失败原因
 *
 * 优先级：上游拒绝文件名 > 付费/无授权 > 其它异常码。
 * @param {any[]} infos 原始 `midurlinfo` 列表
 * @param {number | undefined} payPlay 歌曲付费标记，1 为付费
 * @returns {string} 失败原因
 */
const pickReason = (infos, payPlay) => {
  const codes = (infos || []).map((info) => Number(info && info.result))
  if (codes.some((code) => code === 101404)) return 'filename_rejected'
  if (codes.some((code) => code === 104003 || code === 10400)) {
    return payPlay === 1 ? 'need_pay' : 'no_authorization'
  }
  return 'vkey_error'
}

/**
 * 播放地址解析结果
 * @typedef {object} SongUrlResult
 * @property {boolean} ok 是否拿到可用直链
 * @property {string} [url] 播放地址
 * @property {string} [level] 命中的音质档位，试听直链为 trial
 * @property {string} [label] 命中音质的中文说明
 * @property {string} [format] 音频格式
 * @property {boolean} [isFallback] 是否降级到低于首选档位的音质
 * @property {boolean} [isTrial] 是否为官方下发的试听片段直链
 * @property {number} [payPlay] 歌曲付费标记，1 表示该歌曲需付费
 * @property {string[]} [triedLevels] 本次尝试的音质档位
 * @property {string} [reason] 失败原因
 * @property {any} [raw] 收敛后的 vkey 业务响应
 * @property {Array<{ level: string, filename: string, result: number | null, subcode: number | null }>} [vkeyResults] 每个候选文件的上游结果码
 */

/**
 * 发起一次 vkey 请求并收敛结果
 *
 * 请求体是 `{ comm, req_0: { module, method, param } }` 的旧式结构，
 * 与平台层其余接口的 `{ comm, request: { ... } }` 不同。
 * @param {object} options 请求选项
 * @param {string} options.mid 歌曲 mid
 * @param {Array<{ filename: string, level: string }>} options.entries 上报的候选文件列表
 * @param {string} [options.uin] 登录账号 ID
 * @param {Record<string, string>} [options.cookies] 登录凭据
 * @param {number} [options.timeoutMs] 请求超时毫秒数
 * @returns {Promise<{ infos: any[], sip: string, raw: any, byFilename: Map<string, any>, vkeyResults: any[] }>} 收敛后的 vkey 结果
 */
const postVkey = async (options) => {
  const {
    mid,
    entries,
    uin = '',
    cookies = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const filenames = entries.map((item) => item.filename)

  const musickey = cookies.qm_keyst || cookies.qqmusic_key || ''
  const gtk = hash33(musickey, 5381)
  const guid = randomUUID().replace(/-/g, '')
  const account = uin && uin !== '0' ? uin : ''
  const cookieHeader = sessionToCookieHeader(cookies)

  const body = {
    comm: {
      ...MOBILE_COMM,
      uin: account,
      format: 'json',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      needNewCode: 1,
      g_tk: gtk,
      g_tk_new_20200303: gtk,
      guid,
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
        'User-Agent': QM_HEADERS['User-Agent'],
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

  const byFilename = new Map()
  for (const info of infos) {
    if (info && info.filename && !byFilename.has(info.filename)) {
      byFilename.set(info.filename, info)
    }
  }

  const vkeyResults = entries.map((item) => {
    const info = byFilename.get(item.filename)
    return {
      level: item.level,
      filename: item.filename,
      result: info && info.result !== undefined ? Number(info.result) : null,
      subcode: info && info.subcode !== undefined ? Number(info.subcode) : null,
    }
  })

  return { infos, sip, raw: sanitizeRaw(json, infos), byFilename, vkeyResults }
}

/**
 * 请求一次 vkey，取回播放地址
 *
 * 先按「档位 × base」组合探测正式音质，全部落空时再探一次官方试听直链。
 * @param {object} options 请求选项
 * @param {string} options.mid 歌曲 mid
 * @param {string} [options.mediaMid] 媒体 mid，缺省时只用 `mid + mid` 作 base
 * @param {string} [options.level] 首选音质档位
 * @param {string} [options.uin] 登录账号 ID
 * @param {Record<string, string>} [options.cookies] 登录凭据
 * @param {number} [options.payPlay] 歌曲付费标记，1 表示该歌曲需付费
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
    payPlay,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const bases = getBaseCandidates(mid, mediaMid)
  const targetLevel = String(level || 'hq')
  const candidates = getQualityCandidates(targetLevel)
  const triedLevels = candidates.map((item) => item.level)

  // 同一个请求里带上所有「档位 × base」组合，filename 与 songtype 长度必然一致。
  // 顺序按「档位在外、base 在内」展开：同一档位先试首选 base，再试兜底 base，
  // 这样只要任一 base 能给到该档位就命中，返回的始终是最高可用音质。
  const requests = []
  for (const candidate of candidates) {
    for (const base of bases) {
      requests.push({
        filename: `${candidate.prefix}${base}${candidate.ext}`,
        level: candidate.level,
      })
    }
  }

  const outcome = await postVkey({
    mid,
    entries: requests,
    uin,
    cookies,
    timeoutMs,
  })

  for (const request of requests) {
    const found = outcome.byFilename.get(request.filename)
    if (!found || !found.purl) continue

    const candidate = candidates.find((item) => item.level === request.level)
    if (!candidate) continue

    const purl = String(found.purl)
    logger.info(
      `播放地址命中: ${mid} -> ${candidate.label} (${candidate.level})`,
    )
    return {
      ok: true,
      url: purl.startsWith('http') ? purl : `${outcome.sip}${purl}`,
      level: candidate.level,
      label: candidate.label,
      format: candidate.ext.replace('.', ''),
      isFallback: candidate.level !== targetLevel,
      isTrial: false,
      payPlay,
      triedLevels,
      raw: outcome.raw,
      vkeyResults: outcome.vkeyResults,
    }
  }

  // 正式音质拿不到时再探试听直链：付费歌由官方下发 60 秒试听片段
  const trialBase = mediaMid || mid
  const trialFilename = `${TRIAL_PREFIX}${trialBase}${TRIAL_EXT}`
  const trialOutcome = await postVkey({
    mid,
    entries: [{ filename: trialFilename, level: TRIAL_LEVEL }],
    uin,
    cookies,
    timeoutMs,
  })
  const trialInfo = trialOutcome.byFilename.get(trialFilename)
  if (trialInfo && trialInfo.purl) {
    const purl = String(trialInfo.purl)
    logger.info(`命中试听直链: ${mid}`)
    return {
      ok: true,
      url: purl.startsWith('http') ? purl : `${trialOutcome.sip}${purl}`,
      level: TRIAL_LEVEL,
      label: TRIAL_LABEL,
      format: TRIAL_EXT.replace('.', ''),
      isFallback: true,
      isTrial: true,
      payPlay,
      triedLevels,
      raw: trialOutcome.raw,
      vkeyResults: trialOutcome.vkeyResults,
    }
  }

  const reason = pickReason(outcome.infos, payPlay)
  logger.warn(
    `vkey 未返回可用播放地址: ${mid} 首选=${targetLevel} 原因=${reason}`,
  )
  return {
    ok: false,
    reason,
    isTrial: false,
    payPlay,
    triedLevels,
    raw: outcome.raw,
    vkeyResults: outcome.vkeyResults,
  }
}

module.exports = {
  QUALITY_CANDIDATES,
  TRIAL_PREFIX,
  TRIAL_EXT,
  TRIAL_LEVEL,
  TRIAL_LABEL,
  getQualityCandidates,
  getBaseCandidates,
  hash33,
  requestSongUrl,
}
