/**
 * 酷狗歌名剥离
 *
 * 纯函数模块：只做字符串处理，不依赖网络、不依赖凭据。
 *
 * 酷狗的歌曲名在不同端点上有不同形态：
 * - 云歌单条目 `name`：`歌手们 - 歌名.mp3`，条目自带 `singerinfo[]`
 * - 公开歌单条目 `filename`：`歌手们 - 歌名`，**无扩展名、也没有歌手字段**
 * - 写侧加歌入参 `name`：与云歌单同形态
 *
 * 云歌单详情、公开歌单、加歌写入三个模块共用本模块，保证同一首歌在任何
 * 页面显示的都是同一个名字。
 */

/** 酷狗文件名形态的音频扩展名，用于从歌名里剥掉后缀 */
const AUDIO_EXTENSION =
  /\.(mp3|flac|m4a|wav|ape|aac|ogg|oga|opus|wma|mp4|m4s|dsf|dff)$/i

/** 酷狗连接多位歌手时使用的分隔符 */
const ARTIST_SEPARATOR = /[、,，;；]/

/**
 * 归一化歌手名：去掉所有空白与分隔符，便于逐字比较
 * @param {any} value 歌手名
 * @returns {string} 归一化后的歌手名
 */
const normalizeArtistName = (value) =>
  String(value || '')
    .replace(/\s+/g, '')
    .replace(/[、,，;；]/g, '')

/**
 * 从歌曲条目里收集歌手名
 *
 * 兼容三种来源：酷狗原始的 `singerinfo[]`、读侧对外的 `artists[]`、
 * 扁平字段 `singername` / `artist`。
 * @param {any} song 歌曲条目
 * @returns {string[]} 歌手名列表
 */
const collectArtistNames = (song) => {
  const names = []
  const push = (value) => {
    const text = String(value || '').trim()
    if (text) names.push(text)
  }

  for (const singer of Array.isArray(song.singerinfo) ? song.singerinfo : []) {
    push(singer && singer.name ? singer.name : singer)
  }
  for (const artist of Array.isArray(song.artists) ? song.artists : []) {
    push(artist && artist.name ? artist.name : artist)
  }
  for (const flat of [song.singername, song.artist]) {
    const text = String(flat || '').trim()
    if (!text) continue
    for (const part of text.split(ARTIST_SEPARATOR)) {
      push(part)
    }
  }

  return names
}

/**
 * 归一化歌手段：去掉空白、歌手分隔符与连字符，用于整段比较
 * @param {any} value 歌手段原文
 * @returns {string} 归一化后的歌手段
 */
const normalizeArtistBlock = (value) =>
  String(value || '')
    .replace(/\s+/g, '')
    .replace(/[、,，;；-]/g, '')

/**
 * 判断候选歌手段与给定歌手名是否指同一批歌手
 *
 * 两种判定都算数：逐个歌手名相等（`歌手A、歌手B` 对 `歌手A、歌手B`），
 * 或整段拼接后相等（`AC - DC` 对 `AC - DC`，歌手本身占多段时用得上）。
 * @param {string[]} segments 候选歌手段原文
 * @param {string[]} artistNames 给定的歌手名
 * @returns {boolean} 指同一批歌手时为 true
 */
const matchesArtists = (segments, artistNames) => {
  const expected = artistNames.map(normalizeArtistName).filter(Boolean)
  if (expected.length === 0) return false

  const names = new Set()
  for (const segment of segments) {
    for (const part of segment.split(ARTIST_SEPARATOR)) {
      const name = normalizeArtistName(part)
      if (name) names.add(name)
    }
  }
  if (names.size === expected.length && expected.every((n) => names.has(n))) {
    return true
  }

  return (
    expected.map(normalizeArtistBlock).join('') ===
    segments.map(normalizeArtistBlock).join('')
  )
}

/**
 * 从酷狗原始歌名里剥离出纯歌名
 *
 * 酷狗把歌名写成「歌手们 - 歌名.mp3」，歌手们用「、」连接；歌名本身也可能含
 * 「 - 」（如「歌手 - 歌名 - Remix」）。据此定规则：
 *
 * 1. 去掉末尾的音频扩展名；
 * 2. 按「 - 」切段；
 * 3. 给了歌手名时，取「前若干段的歌手恰好是这批歌手」里段数最小的一档，
 *    该档之后的内容即歌名——歌手占多段时也正确；
 * 4. 没给歌手名（或对不上）时，按酷狗「首段是歌手」的约定，首段之后即歌名。
 *
 * @param {string} fullName 原始歌名
 * @param {object} [options] 剥离选项
 * @param {string[]} [options.artistNames] 歌手名列表，用于定位歌名起点
 * @param {boolean} [options.artistPrefix] 原始串是否确定按「歌手 - 歌名」形态
 *   组织；传 true 时无条件把首段当歌手，不传时只有能定位到歌手段才剥离
 * @returns {string} 纯歌名，取不到时返回空串
 */
const extractSongTitle = (fullName, options = {}) => {
  const { artistNames = [], artistPrefix = false } = options
  const source = String(fullName || '').trim()
  if (!source) return ''

  const hasExtension = AUDIO_EXTENSION.test(source)
  const segments = source
    .replace(AUDIO_EXTENSION, '')
    .split(' - ')
    .map((part) => part.trim())
    .filter(Boolean)
  if (segments.length === 0) return ''
  if (segments.length === 1) return segments[0]

  for (let count = 1; count < segments.length; count += 1) {
    if (matchesArtists(segments.slice(0, count), artistNames)) {
      return segments.slice(count).join(' - ')
    }
  }

  if (artistPrefix || hasExtension) {
    return segments.slice(1).join(' - ')
  }

  return segments.join(' - ')
}

/**
 * 从歌曲条目里取出纯歌名
 *
 * 原始歌名所在的字段按端点不同，取值顺序由 `nameFields` 决定。
 * @param {any} entry 歌曲条目
 * @param {object} [options] 剥离选项
 * @param {string[]} [options.nameFields] 原始歌名字段候选，按顺序取第一个非空
 * @param {boolean} [options.artistPrefix] 原始串是否确定按「歌手 - 歌名」形态
 *   组织；公开歌单条目没有歌手字段，只能按此约定剥离
 * @returns {string} 纯歌名，取不到时返回空串
 */
const extractEntryTitle = (entry, options = {}) => {
  const { nameFields = ['name'], artistPrefix = false } = options
  const source = nameFields
    .map((field) => String((entry && entry[field]) || '').trim())
    .find((text) => text)
  if (!source) return ''

  return extractSongTitle(source, {
    artistNames: collectArtistNames(entry),
    artistPrefix,
  })
}

module.exports = {
  extractSongTitle,
  extractEntryTitle,
  collectArtistNames,
}
