/**
 * QQ 音乐：歌单编辑信息
 *
 * 改名等写操作需要保留歌单的描述、封面与标签时，
 * 先用本接口读回原值再回填。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  failure,
  badRequest,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 把接口返回的标识字段解析为正整数
 * @param {unknown} value 原始值
 * @returns {number | undefined} 合法正整数，非法时返回 undefined
 */
const positiveInt = (value) => {
  const num =
    typeof value === 'string' && /^\d{1,15}$/.test(value)
      ? Number(value)
      : value
  return typeof num === 'number' && Number.isSafeInteger(num) && num > 0
    ? num
    : undefined
}

module.exports = async (query = {}) => {
  const dirId = positiveInt(query.dirId ?? query.dirid)
  if (!dirId) return badRequest('dirId required')

  const session = readSession(query)
  const cookies =
    session && typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : (session && session.cookies) || {}
  const uin = String(
    (session && session.uin) ||
      cookies.qm_str_musicid ||
      cookies.uin ||
      cookies.wxuin ||
      '',
  ).replace(/^o/, '')
  const authSession = session ? { ...session, uin, cookies } : null

  try {
    const data = await qmRequest(
      'music.srfDissInfo.aiDissInfo',
      'uniform_get_Dissinfo',
      { dirid: dirId, optype: 3, tag: 1, userinfo: 0, pic_dpi: 300 },
      { session: authSession, referer: 'https://y.qq.com/' },
    )

    const info = data && data.dirinfo
    if (!info) {
      logger.warn('读取歌单编辑信息失败:', dirId)
      return failure(404, { code: 404, message: '歌单编辑信息不可读' })
    }

    return success({
      dirId,
      title: info.title ?? '',
      desc: info.desc ?? '',
      picurl: info.picurl ?? '',
      picurl2: info.picurl2 ?? '',
      dirShow: info.dir_show === 2 ? 2 : 1,
      tag: info.tag ?? [],
    })
  } catch (err) {
    logger.error('读取歌单编辑信息异常:', err && err.message)
    return upstreamError(`读取歌单编辑信息失败: ${err && err.message}`)
  }
}
