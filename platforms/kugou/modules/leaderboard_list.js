/**
 * 酷狗音乐排行榜清单
 *
 * 走 `GET http://mobilecdn.kugou.com/api/v3/rank/list`：
 * 上游一次下发全部榜单（实测 56 榜），每条带榜单号 `rankid`、榜单名 `rankname`、
 * 分组号 `classify`、期数 `issue`、更新频率 `update_frequency`、播放量 `play_times`
 * 与封面模板（`imgurl` 方图、`img_9` 9:16 竖图，尺寸写成 `{size}` 占位符）。
 *
 * 端点只能走 `http://`：`mobilecdn.kugou.com` 的 https 证书不受信，握手会失败。
 *
 * 分组名由本地定义——上游 `theme.classify_list` 为空，不下发分组名：
 * - 1 巅峰榜：全站头部与热门维度榜（TOP500、网络热歌榜、飙升榜、新歌榜、百万收藏榜），
 *   另含短视频、DJ、粤语金曲、伤感等特色榜与昆明城市榜，实测 13 榜
 * - 2 地区榜：内地、欧美、韩国、日本、香港、台湾及 JOOX、KKBOX 合作榜，实测 8 榜
 * - 3 特色榜：年代（80/90/00 后）、会员、儿歌、闽南语、综艺、原创、识曲，实测 11 榜
 * - 4 全球榜：美国 Billboard、Beatport、英国单曲、韩国 Melon、日本公信等，实测 9 榜
 * - 5 曲风榜：国潮、民谣、电音、摇滚、R&B、说唱、古典、戏曲等，实测 15 榜
 *
 * 榜单号用于后续查详情（见 `leaderboard_detail`），TOP500 为 8888。
 */

const { kgRequest } = require('../core/request')
const { success, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('kugou')

/** 榜单清单端点（https 证书不受信，只能走 http） */
const KG_RANK_LIST_URL = 'http://mobilecdn.kugou.com/api/v3/rank/list'

/**
 * 榜单分组名
 *
 * 上游只给分组号 `classify`、不给分组名，命名依据见文件头说明。
 * @type {Record<number, string>}
 */
const GROUP_NAMES = {
  1: '巅峰榜',
  2: '地区榜',
  3: '特色榜',
  4: '全球榜',
  5: '曲风榜',
}

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
 * 填充并安全化酷狗图片模板中的尺寸占位符
 *
 * 口径：模块层就把 `{size}` 换成实际尺寸（`cover` 用 300、`coverOriginal` 用 480），
 * 与本平台其他模块（搜索 / 专辑 / 歌单）保持一致，渲染端拿到即可直接用。
 * @param {string | undefined} url 封面模板
 * @param {number} [size] 尺寸
 * @returns {string} 封面地址，无封面时返回空串
 */
const fillCover = (url, size = 300) => {
  if (!url) return ''
  return String(url)
    .replace(/\{size\}/g, String(size))
    .replace(/^http:\/\//, 'https://')
}

/**
 * 归一化榜单条目
 * @param {any} board 上游榜单条目
 * @returns {Record<string, any>} 归一化后的榜单条目
 */
const normalizeBoard = (board) => {
  const source = board || {}
  const extra = (source.extra && source.extra.resp) || {}
  return {
    topId: Number(source.rankid ?? 0),
    rankId: Number(source.rankid ?? 0),
    rankCid: Number(source.rank_cid ?? 0),
    title: decodeName(source.rankname ?? ''),
    subTitle: '',
    intro: decodeName(source.intro ?? ''),
    period: String(source.issue ?? ''),
    updateTime: source.rank_id_publish_date ?? '',
    updateFrequency: source.update_frequency ?? '',
    cover: fillCover(source.imgurl, 300),
    coverOriginal: fillCover(source.imgurl, 480),
    poster: fillCover(source.img_9, 480),
    listenCount: Number(source.play_times ?? 0),
    total: Number(extra.all_total ?? 0),
    isvol: Number(source.isvol ?? 0),
    classify: Number(source.classify ?? 0),
  }
}

module.exports = async (query = {}) => {
  const groupId = Number(query.groupId ?? query.group_id ?? 0)

  try {
    const body = await kgRequest(KG_RANK_LIST_URL)
    const boards = (body && body.data && body.data.info) || []
    if (!Array.isArray(boards)) {
      return upstreamError('酷狗榜单清单获取失败：上游响应缺少榜单列表')
    }

    const normalized = boards.map(normalizeBoard)

    const groups = Object.keys(GROUP_NAMES)
      .map(Number)
      .sort((left, right) => left - right)
      .filter((id) => !groupId || id === groupId)
      .map((id) => ({
        groupId: id,
        groupName: GROUP_NAMES[id],
        type: id,
        toplists: normalized.filter((board) => board.classify === id),
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
    logger.error('酷狗榜单清单获取异常:', err && err.message)
    return upstreamError(`酷狗榜单清单获取失败: ${err && err.message}`)
  }
}
