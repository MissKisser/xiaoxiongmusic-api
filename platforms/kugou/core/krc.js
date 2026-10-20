/**
 * KRC 逐字歌词解密与格式化
 *
 * 加密链路：base64 字符串去掉头 4 字节 → 与 16 字节定 key 循环 XOR →
 * zlib inflate → UTF-8 明文。
 *
 * 明文格式示例：`[285,3800]<0,120,0>字<120,200,0>字...`
 *   - 行首 `[start_ms, duration_ms]`
 *   - 行内 `<offset_ms, duration_ms, 0>` 逐字时间
 *
 * 本文件输出 4 种歌词：
 *   - lrc   标准 LRC（行级）
 *   - krc   逐字 LRC（`<offset_ms,duration_ms>字`）
 *   - trans 翻译（行级 LRC）
 *   - roma 罗马音（行级 LRC）
 *
 * 只依赖 node:zlib 与 node:util，不引用任何客户端运行时。
 */

const { inflate } = require('node:zlib')
const { promisify } = require('node:util')

const inflateAsync = promisify(inflate)

/** KRC 解密用的 16 字节定 key */
const KRC_KEY = Uint8Array.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce,
  0xd2, 0x6e, 0x69,
])

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

/** KRC 头部的 id 标记行 */
const HEAD_ID_REG = /^.*\[id:\$\w+\]\n/
/** 翻译 / 罗马音承载行 */
const LANGUAGE_REG = /\[language:([\w=\/+=]+)\]/
/** 承载行的整行匹配 */
const LANGUAGE_LINE_REG = /\[language:[\w=\/+=]+\]\n?/
/** 行首时间标签（全局） */
const LINE_TIME_REG = /\[((\d+),\d+)\].*/g
/** 行首时间标签（单行） */
const LINE_TIME_EACH_REG = /\[((\d+),\d+)\].*/

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
 * 把毫秒格式化成 `MM:SS.xxx`
 * @param {number} ms 毫秒数
 * @returns {string} 时间标签
 */
const msToTimeTag = (ms) => {
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const x = Math.floor(ms % 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${x}`
}

/**
 * 解密一段 KRC base64 内容
 * @param {string} base64 KRC 的 base64 文本
 * @returns {Promise<string>} 解压后的 UTF-8 明文
 * @throws {Error} 内容为空或解压失败时抛出
 */
const decryptKrc = async (base64) => {
  if (!base64) throw new Error('empty krc content')
  const buf = Buffer.from(base64, 'base64').subarray(4)
  for (let i = 0; i < buf.length; i += 1) buf[i] ^= KRC_KEY[i % 16]
  const out = await inflateAsync(buf)
  return out.toString('utf8')
}

/**
 * 解析解密后的 KRC 明文 → 四种歌词
 * @param {string} raw 解密后的明文
 * @returns {{ lrc: string, krc: string, trans: string, roma: string }} 四种歌词文本
 */
const parseKrc = (raw) => {
  let text = String(raw).replace(/\r/g, '')
  if (HEAD_ID_REG.test(text)) text = text.replace(HEAD_ID_REG, '')

  // 翻译与罗马音以 [language:base64(json)] 整体嵌入
  let transLines
  let romaLines
  const langMatch = text.match(LANGUAGE_REG)
  if (langMatch) {
    text = text.replace(LANGUAGE_LINE_REG, '')
    try {
      const json = JSON.parse(
        Buffer.from(langMatch[1], 'base64').toString('utf8'),
      )
      for (const item of json.content || []) {
        const lines = (item.lyricContent || []).map((arr) => arr.join(''))
        if (item.type === 0) romaLines = lines
        else if (item.type === 1) transLines = lines
      }
    } catch {
      // 译文解析失败不影响主歌词
    }
  }

  // 逐行替换行首时间标签：[start_ms,dur_ms] → [MM:SS.xxx]
  // 同时按行索引给翻译 / 罗马音补上同样的时间头
  let idx = 0
  const krcBody = text.replace(LINE_TIME_REG, (line) => {
    const match = line.match(LINE_TIME_EACH_REG)
    if (!match) return line
    const timeTag = msToTimeTag(parseInt(match[2], 10))
    if (romaLines && romaLines[idx] !== undefined) {
      romaLines[idx] = `[${timeTag}]${romaLines[idx]}`
    }
    if (transLines && transLines[idx] !== undefined) {
      transLines[idx] = `[${timeTag}]${transLines[idx]}`
    }
    idx += 1
    return line.replace(match[1], timeTag)
  })

  // 字级时间标签 <offset,dur,0> → <offset,dur>
  const krc = decodeName(krcBody.replace(/<(\d+,\d+),\d+>/g, '<$1>'))
  const lrc = krc.replace(/<\d+,\d+>/g, '')

  return {
    lrc,
    krc,
    trans: decodeName(transLines ? transLines.join('\n') : ''),
    roma: decodeName(romaLines ? romaLines.join('\n') : ''),
  }
}

/**
 * 解密并解析一段 KRC base64 内容
 * @param {string} base64Content KRC 的 base64 文本
 * @returns {Promise<{ lrc: string, krc: string, trans: string, roma: string }>} 四种歌词文本
 */
const decodeKrc = async (base64Content) => {
  const text = await decryptKrc(base64Content)
  return parseKrc(text)
}

module.exports = {
  decodeKrc,
  decryptKrc,
  parseKrc,
  decodeName,
  msToTimeTag,
}
