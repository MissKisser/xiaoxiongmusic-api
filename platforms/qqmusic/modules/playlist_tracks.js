/**
 * QQ 音乐：歌单加歌 / 删歌
 *
 * 写完读回歌单，确认目标歌曲在列（加歌）或不在列（删歌）才返回成功。
 * `like` 为 true 时写入「我喜欢」系统目录（红心），目录号固定为 201。
 */

const { qmRequest } = require('../core/request')
const { readSession } = require('../core/credential')
const {
  success,
  failure,
  unauthorized,
  badRequest,
  upstreamError,
} = require('../../shared/response')
const { parseCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/**
 * 写入类接口要求的 Referer
 *
 * QQ 音乐对写接口校验来源：`https://y.qq.com`（无尾斜杠）会被判为非法来源，
 * 写接口统一返回 inner=1000 / authorize fail；带尾斜杠的 `https://y.qq.com/` 才能写入。
 */
const WRITE_REFERER = 'https://y.qq.com/'

/** 「我喜欢」目录的系统 dirId（红心写入走这个目录） */
const LIKED_DIR_ID = 201

/** 系统目录的目录号下限，`dirId >= 200` 为系统目录 */
const SYSTEM_DIR_ID_MIN = 200

/** 单次写入的歌曲数量上限 */
const MAX_SONGS = 100

/** 读回歌单时单次请求的歌曲数量 */
const SONG_WINDOW = 100

/** 读回歌单时最多扫描的窗口数 */
const MAX_WINDOWS = 5

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

/**
 * 从自建歌单列表中定位某个 tid 对应的普通目录
 * @param {Record<string, any>[]} list 自建 + 收藏歌单列表
 * @param {number} tid 歌单 tid
 * @returns {{ dirId: number } | { error: string }} 目录号或拒绝原因
 */
const findOwnedDirId = (list, tid) => {
  const matches = (list || []).filter(
    (item) => item && positiveInt(item.tid) === tid,
  )
  if (matches.length !== 1) {
    return { error: `歌单 ${tid} 在自建列表中不唯一` }
  }
  const entry = matches[0]
  const dirId = positiveInt(entry.dirId)
  if (!dirId) return { error: `歌单 ${tid} 缺少 dirId` }
  if (entry.dirType !== undefined && entry.dirType !== 0) {
    return { error: `歌单 ${tid} 不是自建目录，拒绝写入` }
  }
  if (dirId >= SYSTEM_DIR_ID_MIN) {
    return { error: `歌单 ${tid} 是系统目录，拒绝写入` }
  }
  return { dirId }
}

/**
 * 读回歌单中的歌曲 id 集合
 *
 * 按窗口顺序扫描，必要时补读尾部窗口，确保追加在末尾的新歌也能被看到。
 * @param {number} tid 歌单 tid
 * @param {number} dirId 歌单目录号
 * @param {{ uin: string, cookies: Record<string, string> }} authSession 登录会话
 * @returns {Promise<{ ids: Set<number>, total: number, complete: boolean }>} 歌曲 id 集合与扫描完整性
 */
const readPlaylistSongIds = async (tid, dirId, authSession) => {
  const ids = new Set()
  let total = 0
  let scanned = 0

  const readWindow = async (begin) => {
    const data = await qmRequest(
      'music.srfDissInfo.DissInfo',
      'CgiGetDiss',
      {
        uin: authSession.uin,
        disstid: tid,
        dirid: dirId,
        tag: true,
        song_begin: begin,
        song_num: SONG_WINDOW,
        userinfo: true,
        orderlist: true,
        enc_host_uin: authSession.cookies.euin ?? '',
      },
      { session: authSession, referer: WRITE_REFERER },
    )
    const songlist = (data && data.songlist) || []
    for (const song of songlist) {
      const id = positiveInt(song.id)
      if (id) ids.add(id)
    }
    total = Number((data && data.total_song_num) ?? songlist.length)
    return songlist.length
  }

  for (let index = 0; index < MAX_WINDOWS; index++) {
    const count = await readWindow(scanned)
    scanned += count
    if (count < SONG_WINDOW || scanned >= total) break
  }

  const complete = scanned >= total
  if (!complete) {
    // 歌单超出扫描上限时补读尾部窗口，新加入的歌曲追加在末尾
    await readWindow(Math.max(0, total - SONG_WINDOW))
  }

  return { ids, total, complete }
}

module.exports = async (query = {}) => {
  const op = String(query.op ?? 'add')
  if (!['add', 'del'].includes(op)) {
    return badRequest('op 必须是 add 或 del')
  }

  const songs = Array.isArray(query.songs) ? query.songs : []
  if (songs.length < 1 || songs.length > MAX_SONGS) {
    return badRequest(`songs 数量需在 1~${MAX_SONGS} 之间`)
  }

  const v_songInfo = []
  for (const song of songs) {
    const id = positiveInt(song && (song.id ?? song.songId))
    if (!id) return badRequest(`歌曲 id 非法: ${String(song && song.id)}`)
    const type = song.type ?? song.songType ?? 0
    if (Number(type) !== 0) {
      return badRequest(`暂不支持的歌曲类型: ${String(type)}`)
    }
    v_songInfo.push({ songId: id, songType: 0 })
  }

  const like = query.like === true
  const rawTid = like ? undefined : positiveInt(query.tid)
  const explicitDirId = like ? undefined : positiveInt(query.dirId)
  // 系统目录不可写入，调用方直接给出 dirId 时先就地拒绝
  if (explicitDirId && explicitDirId >= SYSTEM_DIR_ID_MIN) {
    return badRequest(`目录 ${explicitDirId} 是系统目录，拒绝写入`)
  }

  const session = readSession(query)
  if (!session) return unauthorized('未登录 QQ 音乐账号')
  const cookies =
    typeof session.cookies === 'string'
      ? parseCookie(session.cookies)
      : session.cookies || {}
  const uin = String(
    session.uin || cookies.qm_str_musicid || cookies.uin || cookies.wxuin || '',
  ).replace(/^o/, '')
  const hasKey = !!(
    cookies.qm_keyst ||
    cookies.qqmusic_key ||
    cookies.pskey ||
    cookies.p_skey ||
    cookies.skey
  )
  if (!uin || uin === '0' || !hasKey) {
    return unauthorized('未登录 QQ 音乐账号')
  }

  const authSession = { ...session, uin, cookies }

  if (!like && !rawTid) return badRequest('tid required')

  try {
    // 定位目标歌单：红心写「我喜欢」系统目录，普通写入自建目录
    let dirId = LIKED_DIR_ID
    let tid = undefined

    if (like) {
      const listData = await qmRequest(
        'music.musicasset.PlaylistBaseRead',
        'GetPlaylistByUin',
        { uin },
        { session: authSession, referer: WRITE_REFERER },
      )
      const likedEntry = ((listData && listData.v_playlist) || []).find(
        (item) => item && positiveInt(item.dirId) === LIKED_DIR_ID,
      )
      tid = positiveInt(likedEntry && likedEntry.tid)
      if (!tid) {
        return failure(404, { code: 404, message: '未找到「我喜欢」歌单' })
      }
    } else {
      tid = rawTid
      dirId = explicitDirId
      if (!dirId) {
        const listData = await qmRequest(
          'music.musicasset.PlaylistBaseRead',
          'GetPlaylistByUin',
          { uin },
          { session: authSession, referer: WRITE_REFERER },
        )
        const located = findOwnedDirId(
          (listData && listData.v_playlist) || [],
          rawTid,
        )
        if (located.error) return badRequest(located.error)
        dirId = located.dirId
      }
    }

    const data = await qmRequest(
      'music.musicasset.PlaylistDetailWrite',
      op === 'add' ? 'AddSonglist' : 'DelSonglist',
      { dirId, v_songInfo },
      { session: authSession, referer: WRITE_REFERER },
    )

    if (!data || data.retCode !== 0 || !data.result) {
      logger.warn('写歌曲失败:', data && data.retCode)
      return upstreamError('写歌曲失败', { retCode: data && data.retCode })
    }

    const changed =
      positiveInt(data.result.dirId) === dirId &&
      positiveInt(data.result.tid) === tid
    const cleared =
      (data.result.dirId === 0 || data.result.dirId === '0') &&
      (data.result.tid === 0 || data.result.tid === '0')
    if (!changed && !cleared) {
      return upstreamError('写歌曲返回的 dirId/tid 不匹配')
    }

    // 读回确认：加歌后歌曲应在列，删歌后歌曲应不在列
    const read = await readPlaylistSongIds(tid, dirId, authSession)
    const targetIds = v_songInfo.map((item) => item.songId)
    const present = targetIds.filter((id) => read.ids.has(id))

    if (op === 'add') {
      if (present.length !== targetIds.length) {
        return failure(502, {
          code: 502,
          message: '加歌后读回校验失败：目标歌曲未全部出现在歌单中',
          tid,
          dirId,
          missing: targetIds.filter((id) => !read.ids.has(id)),
        })
      }
    } else {
      if (present.length > 0) {
        return failure(502, {
          code: 502,
          message: '删歌后读回校验失败：目标歌曲仍在歌单中',
          tid,
          dirId,
          remaining: present,
        })
      }
      if (!read.complete) {
        return failure(502, {
          code: 502,
          message: '删歌后读回校验失败：歌单过长，无法完整确认删除结果',
          tid,
          dirId,
        })
      }
    }

    return success({
      changed: true,
      op,
      dirId,
      tid,
      songs: targetIds,
      verified: true,
    })
  } catch (err) {
    logger.error('写歌曲异常:', err && err.message)
    return upstreamError(`写歌曲失败: ${err && err.message}`)
  }
}
