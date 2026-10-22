/**
 * 酷狗音乐歌单加歌 / 删歌
 *
 * 加歌走 cloudlist 的 add_song 通道，删歌走 delete_songs 通道（客户端标识跟随当前登录模式）。
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
  failure,
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
 * 等待歌单曲目满足条件
 *
 * 上游的曲目读取偶发返回写操作之前的旧快照，写完立刻读回可能拿到旧值，
 * 读回校验会误判。这里在有限次数内重试，直到满足条件或用尽次数。
 * @param {any} session 酷狗会话凭据
 * @param {string} listid 歌单 listid
 * @param {(items: any[]) => boolean} predicate 判定条件
 * @returns {Promise<{ items: any[], count: number }>} 最后一次读到的曲目与总数
 */
const waitListSongs = async (session, listid, predicate) => {
  let last = { items: [], count: 0 }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    last = await readListSongs(session, listid)
    if (predicate(last.items)) return last
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  return last
}

/**
 * 归一化歌曲条目
 *
 * 歌名按写侧口径剥离成纯歌名：去掉歌手前缀与音频扩展名，与读侧展示一致。
 * `mixSongId` 是歌曲的逻辑 id（`album_audio_id` 口径），同一首歌的不同文件版本
 * （不同内容哈希、不同音质）共享同一个逻辑 id，删歌时按它定位歌单里的条目最可靠；
 * `singer` 是歌手名，作为内容哈希与逻辑 id 都匹配不上时的兜底判据。
 * @param {any} song 原始歌曲条目
 * @returns {{ hash: string, name: string, singer: string, albumId: number, mixsongId: number, fileId: string }} 归一化结果
 */
const normalizeSong = (song) => {
  const rawName = String(song.name || '').trim()
  const artists = Array.isArray(song.artists) ? song.artists : []
  const singer = artists
    .map((artist) => (artist && artist.name) || '')
    .filter(Boolean)
    .join(' / ')
  return {
    hash: String(song.hash || '')
      .trim()
      .toUpperCase(),
    name: extractEntryTitle(song, { nameFields: ['name'] }) || rawName,
    singer,
    albumId: Number(song.album_id || 0),
    mixsongId: Number(song.mixsongid || 0),
    fileId: String(song.fileid || ''),
  }
}

/**
 * 在歌单曲目中按歌曲逻辑 id 或内容哈希定位目标歌曲
 *
 * 定位口径按可靠性排序：
 * 1. 歌曲逻辑 id（`mixsongid`，`album_audio_id` 口径）：同一首歌在酷狗有多个文件
 *    版本（不同音质 / 不同来源），各版本共享同一个逻辑 id，只有内容哈希不同，
 *    因此逻辑 id 是跨版本最可靠的判据；
 * 2. 内容哈希（`hash`，大小写不敏感）：同一文件版本的精确匹配。
 * @param {any[]} items 歌单曲目
 * @param {{ hash: string, mixsongId: number }} song 待定位的写操作条目
 * @returns {any} 命中的曲目，未命中时返回 undefined
 */
const locateRowByKey = (items, song) => {
  if (song.mixsongId > 0) {
    const hit = items.find(
      (row) => Number(row.mixsongid || 0) === song.mixsongId,
    )
    if (hit) return hit
  }
  return items.find((row) => String(row.hash || '').toUpperCase() === song.hash)
}

/**
 * 在歌单曲目中按歌名与歌手定位目标歌曲
 *
 * 作为逻辑 id 与内容哈希都落空时的兜底：同一首歌在不同文件版本下的歌名与歌手一致。
 * @param {any[]} items 歌单曲目
 * @param {{ name: string, singer: string }} song 待定位的写操作条目
 * @returns {any} 命中的曲目，未命中时返回 undefined
 */
const locateRowByTitle = (items, song) => {
  if (!song.name) return undefined
  return items.find((row) => {
    if (extractEntryTitle(row, { nameFields: ['name'] }) !== song.name) {
      return false
    }
    if (!song.singer) return true
    const rowSinger = String(row.singername || '').trim()
    return !rowSinger || rowSinger === song.singer
  })
}

/**
 * 判断歌单曲目里是否仍有目标条目
 *
 * 删后回查用：跨版本删除时请求里的哈希本就不在歌单里，
 * 拿请求哈希回查会误判成「已删除」。
 * @param {any[]} items 歌单曲目
 * @param {{ mixsongid: number, hash: string }} row 目标条目
 * @returns {boolean} 是否仍存在
 */
const isTargetPresent = (items, row) =>
  items.some(
    (item) =>
      (row.mixsongid > 0 && Number(item.mixsongid || 0) === row.mixsongid) ||
      (!!row.hash && String(item.hash || '').toUpperCase() === row.hash),
  )

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
  // 删歌优先按歌曲逻辑 id 定位，歌名与歌手只作兜底，不做必填校验
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
      after = await waitListSongs(session, listid, (items) =>
        songs.every((song) => Boolean(locateRowByKey(items, song))),
      )
    } catch (err) {
      logger.warn('加歌后读回失败：', err.message || err)
      return upstreamError(
        `加歌后读回校验失败：无法读取歌单歌曲（${err.message || err}）`,
      )
    }

    const missing = songs.filter((song) => !locateRowByKey(after.items, song))
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

  // 删歌要按歌单里的 fileid 定位歌曲。
  // 定位口径：歌曲逻辑 id（mixsongid）> 内容哈希（hash，大小写不敏感）> 歌名 + 歌手。
  // 同一首歌在酷狗有多个文件版本，用户当年加入「我喜欢」时的文件与现在拿到的
  // 文件内容哈希可能不同，只按哈希精确匹配会永远定位不到，
  // 那种情况不是「读取延迟」，而是「版本不匹配」。
  let before
  try {
    before = await waitListSongs(session, listid, (items) =>
      songs.every((song) => {
        if (Number(song.fileId || 0) > 0) return true
        return Boolean(locateRowByKey(items, song))
      }),
    )
  } catch (err) {
    logger.warn('删歌前读取歌单歌曲失败：', err.message || err)
    return upstreamError(`删歌失败：${err.message || err}`)
  }

  const fileIds = []
  /** 实际定位到的歌单条目，用于删后按同一口径回查 */
  const targeted = []
  const missing = []
  for (let index = 0; index < songs.length; index += 1) {
    const song = songs[index]
    if (song.fileId) {
      fileIds.push(Number(song.fileId))
      continue
    }
    const hit =
      locateRowByKey(before.items, song) || locateRowByTitle(before.items, song)
    if (!hit || !hit.fileid) {
      missing.push(song.hash)
      continue
    }
    fileIds.push(Number(hit.fileid))
    targeted.push({
      mixsongid: Number(hit.mixsongid || 0),
      hash: String(hit.hash || '').toUpperCase(),
    })
  }
  if (missing.length > 0) {
    // 区分两种失败原因：上游曲目尚未读取完整（重试可能成功）与歌单里确实没有这首歌
    const incomplete = before.items.length < before.count
    if (incomplete) {
      return upstreamError(
        `删歌失败：上游歌单曲目尚未读取完整（已读到 ${before.items.length}/${before.count} 首），请重试：${missing.join(', ')}`,
      )
    }
    return failure(404, {
      code: 404,
      message: `删歌失败：未在该歌单中找到该歌曲（已按歌曲 id、内容哈希、歌名匹配）：${missing.join(', ')}`,
    })
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
    after = await waitListSongs(session, listid, (items) =>
      targeted.every((row) => !isTargetPresent(items, row)),
    )
  } catch (err) {
    logger.warn('删歌后读回失败：', err.message || err)
    return upstreamError(
      `删歌后读回校验失败：无法读取歌单歌曲（${err.message || err}）`,
    )
  }

  const still = targeted.filter((row) => isTargetPresent(after.items, row))
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
