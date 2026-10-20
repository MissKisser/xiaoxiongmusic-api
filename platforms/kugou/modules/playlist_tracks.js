/**
 * 酷狗音乐歌单加歌 / 删歌
 *
 * 加歌走概念版 cloudlist 的 add_song 通道，删歌走 delete_songs 通道。
 * 加歌接口要求歌曲以数组形式提交（发扁平字段会被服务端拒绝），且每首歌必须
 * 带歌名，否则服务端以 error_code=20010 拒绝。
 *
 * 语义：写入 → 读回确认 → 才返回成功。加歌后重新读一次歌单歌曲确认新歌已
 * 在列表中，删歌后确认目标歌曲已不在列表中；读回结果与预期不符时返回失败
 * 且不自动重试。
 *
 * 歌名口径：写侧发**纯歌名**（剥离歌手前缀与音频扩展名），与读侧
 * `playlist_detail.js` 展示的歌名一致。剥离规则统一由 `../core/song_title`
 * 提供，写侧、云歌单读侧、公开歌单三处共用同一实现。实测服务端对 name 只做
 * 非空校验——纯歌名、完整格式、完整格式去扩展名三种写法都返回 error_code=0，
 * 且入库的 name 一律被服务端改写成酷狗自己的「歌手 - 歌名.mp3」规范名，所以写侧用
 * 纯歌名是口径统一的选择，不是因为服务端强制。
 */

const { kgGatewayRequest } = require('../core/request')
const { readSession } = require('../core/session')
const { KG_CLOUDLIST_ROUTER } = require('../core/config')
const { extractSongTitle, extractEntryTitle } = require('../core/song_title')
const {
  success,
  badRequest,
  unauthorized,
  upstreamError,
} = require('../../shared/response')
const { createLogger } = require('../../shared/logger')
const { readMyLists, businessError } = require('./user_playlist_list')
const { readListSongs } = require('./playlist_detail')

const logger = createLogger('kugou')

/** 单次写入的最大歌曲数 */
const MAX_TRACKS = 200

/**
 * 归一化歌曲条目
 *
 * 歌名按写侧口径剥离成纯歌名：去掉歌手前缀与音频扩展名，与读侧展示一致。
 * @param {any} song 原始歌曲条目
 * @returns {{ hash: string, name: string, albumId: number, mixsongId: number, fileId: string }} 归一化结果
 */
const normalizeSong = (song) => {
  const rawName = String(song.name || '').trim()
  return {
    hash: String(song.hash || '')
      .trim()
      .toUpperCase(),
    name: extractEntryTitle(song, { nameFields: ['name'] }) || rawName,
    albumId: Number(song.album_id || 0),
    mixsongId: Number(song.mixsongid || 0),
    fileId: String(song.fileid || ''),
  }
}

/**
 * 往歌单加歌 / 从歌单删歌
 * @param {Record<string, any>} [query] 调用参数，cookie 已由平台注册表解析
 * @returns {Promise<{ status: number, body: any, cookie: string[] }>} 统一响应
 */
module.exports = async (query = {}) => {
  const op = String(query.op || 'add')
  if (op !== 'add' && op !== 'del') {
    return badRequest('op 必须是 add 或 del')
  }

  const rawSongs = Array.isArray(query.songs) ? query.songs : []
  if (rawSongs.length < 1) return badRequest('songs 不能为空')
  if (rawSongs.length > MAX_TRACKS) return badRequest('songs 数量超出上限')

  const songs = rawSongs.map(normalizeSong)
  if (songs.some((song) => !song.hash)) {
    return badRequest('songs 中存在缺少 hash 的条目')
  }
  // 酷狗加歌接口要求携带歌名，歌名为空会被服务端以 error_code=20010 拒绝；
  // 删歌按 hash 定位目标歌曲，不需要歌名
  if (op === 'add' && songs.some((song) => !song.name)) {
    return badRequest('songs 中存在缺少 name 的条目')
  }

  const session = readSession(query)
  if (!session || !session.token || !session.userid) {
    return unauthorized('未登录')
  }

  // 红心目标歌单按 is_def 动态定位，不写死 listid
  let listid = String(query.id || query.listid || '').trim()
  if (query.like === true) {
    let snapshot
    try {
      snapshot = await readMyLists(session)
    } catch (err) {
      logger.warn('定位「我喜欢」歌单失败：', err.message || err)
      return upstreamError(`定位「我喜欢」歌单失败：${err.message || err}`)
    }
    const liked = snapshot.items.find((item) => Number(item.is_def || 0) === 2)
    if (!liked) {
      return upstreamError('未找到「我喜欢」歌单')
    }
    listid = String(liked.listid || '')
  }
  if (!listid) return badRequest('id 不能为空')

  const clienttime = Math.floor(Date.now() / 1000)

  if (op === 'add') {
    const data = songs.map((song, index) => ({
      number: index + 1,
      name: song.name,
      hash: song.hash,
      size: 0,
      sort: 0,
      timelen: 0,
      bitrate: 128,
      album_id: song.albumId,
      mixsongid: song.mixsongId,
    }))

    let body
    try {
      body = await kgGatewayRequest(
        '/cloudlist.service/v6/add_song',
        {
          userid: Number(session.userid),
          token: session.token,
          listid: Number(listid),
          list_ver: 0,
          type: 0,
          slow_upload: 1,
          scene: 'false;null',
          data,
        },
        {
          params: {
            last_time: clienttime,
            last_area: 'gztx',
            userid: session.userid,
            token: session.token,
          },
          session,
        },
      )
    } catch (err) {
      logger.warn('加歌失败：', err.message || err)
      return upstreamError(`加歌失败：${err.message || err}`)
    }

    const error = businessError(body)
    if (error) {
      logger.warn('加歌失败：', error)
      return upstreamError(`加歌失败：${error}`)
    }

    let after
    try {
      after = await readListSongs(session, listid)
    } catch (err) {
      logger.warn('加歌后读回失败：', err.message || err)
      return upstreamError(
        `加歌后读回校验失败：无法读取歌单歌曲（${err.message || err}）`,
      )
    }

    const missing = songs.filter(
      (song) =>
        !after.items.some(
          (row) => String(row.hash || '').toUpperCase() === song.hash,
        ),
    )
    if (missing.length > 0) {
      return upstreamError(`加歌后读回校验失败：缺少 ${missing.length} 首`)
    }

    return success({
      code: 200,
      id: listid,
      changed: true,
      count: after.count || after.items.length,
      verified: true,
    })
  }

  let before
  try {
    before = await readListSongs(session, listid)
  } catch (err) {
    logger.warn('删歌前读取歌单歌曲失败：', err.message || err)
    return upstreamError(`删歌失败：${err.message || err}`)
  }

  const fileIds = []
  for (let index = 0; index < songs.length; index += 1) {
    const song = songs[index]
    if (song.fileId) {
      fileIds.push(Number(song.fileId))
      continue
    }
    const hit = before.items.find(
      (row) => String(row.hash || '').toUpperCase() === song.hash,
    )
    if (!hit || !hit.fileid) {
      return badRequest(`未在歌单中找到可删除的歌曲：${song.hash}`)
    }
    fileIds.push(Number(hit.fileid))
  }

  let body
  try {
    body = await kgGatewayRequest(
      '/v4/delete_songs',
      {
        listid: Number(listid),
        userid: Number(session.userid),
        data: fileIds.map((fileid) => ({ fileid })),
        type: 0,
        token: session.token,
        list_ver: 0,
      },
      {
        params: {
          last_time: clienttime,
          last_area: 'gztx',
          userid: session.userid,
          token: session.token,
        },
        headers: { 'x-router': KG_CLOUDLIST_ROUTER },
        session,
      },
    )
  } catch (err) {
    logger.warn('删歌失败：', err.message || err)
    return upstreamError(`删歌失败：${err.message || err}`)
  }

  const error = businessError(body)
  if (error) {
    logger.warn('删歌失败：', error)
    return upstreamError(`删歌失败：${error}`)
  }

  let after
  try {
    after = await readListSongs(session, listid)
  } catch (err) {
    logger.warn('删歌后读回失败：', err.message || err)
    return upstreamError(
      `删歌后读回校验失败：无法读取歌单歌曲（${err.message || err}）`,
    )
  }

  const still = songs.filter((song) =>
    after.items.some(
      (row) => String(row.hash || '').toUpperCase() === song.hash,
    ),
  )
  if (still.length > 0) {
    return upstreamError(`删歌后读回校验失败：仍有 ${still.length} 首`)
  }

  return success({
    code: 200,
    id: listid,
    changed: true,
    count: after.count || after.items.length,
    verified: true,
  })
}

module.exports.extractSongTitle = extractSongTitle
