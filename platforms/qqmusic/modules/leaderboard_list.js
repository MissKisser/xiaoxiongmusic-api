/**
 * QQ 音乐排行榜清单
 *
 * 走 `musicToplist.ToplistInfoServer` / `GetAll`：
 * 上游按分组下发全部榜单（巅峰榜 / 特色榜 / 地区榜 / 全球榜 / 网络榜），
 * 每组内是若干榜单条目，条目自带榜单号、标题、封面、期数与曲目总数。
 *
 * 榜单号用于后续查详情（见 `leaderboard_detail`）：
 * 26 热歌榜 / 62 飙升榜 / 427 新歌榜 / 58 说唱榜 / 65 国风热歌榜。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { success, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 去掉搜索结果的命中高亮标签
 * @param {any} text 原始文本
 * @returns {string} 处理后的文本
 */
const stripHighlight = (text) =>
  typeof text === 'string' ? text.replace(/<\/?em>/g, '') : ''

/**
 * 归一化榜单清单条目
 * @param {any} board 接口返回的榜单条目
 * @returns {Record<string, any>} 归一化后的榜单条目
 */
const normalizeBoard = (board) => {
  const source = board || {}
  return {
    topId: Number(source.topId ?? source.topid ?? 0),
    title: stripHighlight(source.title ?? ''),
    subTitle: stripHighlight(source.titleDetail ?? source.titleSub ?? ''),
    intro: source.intro ?? '',
    period: source.period ?? '',
    updateTime: source.updateTime ?? '',
    cover: source.headPicUrl ?? source.frontPicUrl ?? '',
    listenCount: Number(source.listenNum ?? 0),
    total: Number(source.totalNum ?? 0),
  }
}

module.exports = async (query = {}) => {
  const groupId = Number(query.groupId ?? query.group_id ?? 0)
  const session = readSession(query)

  try {
    const data =
      (await qmRequest(
        'musicToplist.ToplistInfoServer',
        'GetAll',
        { ...(groupId ? { groupId } : {}) },
        { session },
      )) || {}

    const groups = (Array.isArray(data.group) ? data.group : [])
      .map((group) => ({
        groupId: Number((group && group.groupId) ?? 0),
        groupName: stripHighlight((group && group.groupName) ?? ''),
        type: Number((group && group.type) ?? 0),
        toplists: (Array.isArray(group && group.toplist)
          ? group.toplist
          : []
        ).map(normalizeBoard),
      }))
      .filter((group) => group.toplists.length > 0)

    const toplists = groups.flatMap((group) =>
      group.toplists.map((board) => ({
        ...board,
        groupId: group.groupId,
        groupName: group.groupName,
      })),
    )

    return success({
      code: 200,
      total: toplists.length,
      groups,
      toplists,
    })
  } catch (err) {
    logger.error('QQ 音乐榜单清单获取异常:', err && err.message)
    return upstreamError(`QQ 音乐榜单清单获取失败: ${err && err.message}`)
  }
}
