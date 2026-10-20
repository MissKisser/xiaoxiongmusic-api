/**
 * QQ 音乐热搜词
 *
 * 走 `tencent_musicsoso_hotkey.HotkeyService` / `GetHotkeyForQQMusicPC`，
 * 返回当前 QQ 音乐站内热搜关键词榜。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { success, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 归一化热搜条目
 * @param {any} item 接口返回的热搜条目
 * @param {number} index 条目序号
 * @returns {Record<string, any>} 归一化后的热搜条目
 */
const normalizeHotItem = (item, index) => {
  const source = item || {}
  return {
    rank: index + 1,
    keyword: source.query || source.title || '',
    id: source.hotkey_id ?? source.id ?? '',
    score: Number(source.score) || 0,
    cover: source.cover_pic_url ?? '',
    description: source.description ?? '',
  }
}

module.exports = async (query = {}) => {
  const session = readSession(query)

  try {
    const data = await qmRequest(
      'tencent_musicsoso_hotkey.HotkeyService',
      'GetHotkeyForQQMusicPC',
      { search_id: '', uin: 0 },
      { session },
    )

    const list = ((data && data.vec_hotkey) || []).map(normalizeHotItem)

    return success({
      total: list.length,
      list,
      raw: data,
    })
  } catch (err) {
    logger.error('QQ 音乐热搜获取异常:', err && err.message)
    return upstreamError(`QQ 音乐热搜获取失败: ${err && err.message}`)
  }
}
