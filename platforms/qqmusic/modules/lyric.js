/**
 * QQ 音乐歌词
 *
 * 走 `music.musichallSong.PlayLyricInfo` / `GetPlayLyricInfo`：
 * 1. 带 `qrc: 1` 请求一次，服务端按 `qrc_t` 决定返回 QRC（逐字）还是 LRC；
 * 2. 若拿到的是 QRC，再带 `qrc: 0` 请求一次补齐普通 LRC；
 * 3. 翻译（trans）与罗马音（roma）随同返回。
 *
 * 接口返回的是十六进制密文，解密与解析交给 `core/qrc.js`。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { decryptQrc, parseLyric } = require('../core/qrc')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 歌词接口模块名
 * @type {string}
 */
const LYRIC_MODULE = 'music.musichallSong.PlayLyricInfo'

/**
 * 歌词接口方法名
 * @type {string}
 */
const LYRIC_METHOD = 'GetPlayLyricInfo'

/**
 * 把文本编码为 Base64
 * @param {any} text 原始文本
 * @returns {string} Base64 字符串
 */
const encodeName = (text) =>
  Buffer.from(String(text ?? ''), 'utf8').toString('base64')

/**
 * 把歌曲 ID 转成可安全传输的数字
 *
 * 歌曲 ID 远小于安全整数上限，超限时保留字符串形态交给上游处理。
 * @param {any} value 原始 ID
 * @returns {number | string} 安全的数字或原始字符串
 */
const toSafeNumber = (value) => {
  const num = Number(value)
  return Number.isSafeInteger(num) ? num : String(value ?? '')
}

/**
 * 尝试解密歌词密文
 * @param {any} hex 十六进制密文
 * @returns {string | undefined} 解密后的文本，失败时返回 undefined
 */
const tryDecrypt = (hex) => {
  if (!hex) return undefined
  try {
    return decryptQrc(hex)
  } catch (err) {
    return undefined
  }
}

/**
 * 请求一次歌词
 * @param {Record<string, any>} param 歌词接口参数
 * @param {any} session 调用方凭据，缺省时匿名访问
 * @returns {Promise<any>} 接口返回的业务数据段
 */
const requestLyric = async (param, session) =>
  qmRequest(LYRIC_MODULE, LYRIC_METHOD, param, { session })

module.exports = async (query = {}) => {
  const id = query.id ?? query.songId ?? query.songid
  if (id === undefined || id === null || String(id).trim() === '') {
    return badRequest('id required')
  }

  const name = String(query.name ?? '')
  const artist = String(query.artist ?? '')
  const album = String(query.album ?? '')
  const duration = Number(query.duration ?? 0)

  const baseParam = {
    albumName: encodeName(album),
    crypt: 1,
    ct: 19,
    cv: 2111,
    interval: duration,
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    singerName: encodeName(artist),
    songID: toSafeNumber(id),
    songName: encodeName(name),
    trans: 1,
    trans_t: 0,
    type: 0,
  }

  const session = readSession(query)

  try {
    const resp = (await requestLyric(baseParam, session)) || {}
    const result = { lrc: '', qrc: '', trans: '', roma: '' }

    // 主歌词：按 qrc_t 判断服务端返回的是 QRC 还是 LRC
    const mainDecrypted = tryDecrypt(resp.lyric)
    if (mainDecrypted) {
      if (resp.qrc_t === 0) {
        result.lrc = mainDecrypted
      } else {
        result.qrc = mainDecrypted
      }
    }

    // 只拿到 QRC 时再单独请求一次 LRC
    if (result.qrc && !result.lrc) {
      try {
        const lrcResp = await requestLyric(
          { ...baseParam, qrc: 0, qrc_t: 0 },
          session,
        )
        const lrcText = tryDecrypt(lrcResp && lrcResp.lyric)
        if (lrcText) result.lrc = lrcText
      } catch (err) {
        // 次级失败不影响主结果
      }
    }

    result.trans = tryDecrypt(resp.trans) || ''
    result.roma = tryDecrypt(resp.roma) || ''

    const mainParsed = result.qrc
      ? parseLyric(result.qrc)
      : parseLyric(result.lrc)

    return success({
      id: String(id),
      name,
      artist,
      album,
      duration,
      lrc: result.lrc,
      qrc: result.qrc,
      trans: result.trans,
      roma: result.roma,
      format: mainParsed.format,
      lines: mainParsed.lines,
      hasLyric: Boolean(result.lrc || result.qrc),
      hasTranslation: Boolean(result.trans),
      hasRoma: Boolean(result.roma),
      raw: { code: 200, ...result },
    })
  } catch (err) {
    logger.error('QQ 音乐歌词获取异常:', err && err.message)
    return upstreamError(`QQ 音乐歌词获取失败: ${err && err.message}`)
  }
}
