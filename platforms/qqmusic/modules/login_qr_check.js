/**
 * QQ 音乐扫码登录：轮询扫码结果
 *
 * key 由 `login_qr_key` 返回（QQ 为 qrsig，微信为 uuid）。
 * 登录成功后把音乐凭据以 cookie 键值对回传给调用方，由服务层负责持久化，
 * 接口层自身不保存任何会话状态。
 */

const crypto = require('crypto')

const { qmRequest } = require('../core/request')
const { success, badRequest, upstreamError } = require('../../shared/response')
const { stringifyCookie } = require('../../shared/cookie')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/** 模拟桌面浏览器的 User-Agent */
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 微信开放平台应用 ID */
const WX_APP_ID = 'wx48db31d50e334801'

/** 扫码轮询相关请求的超时时间（毫秒） */
const QR_TIMEOUT_MS = 8000

/**
 * QQ 系哈希算法（用于 ptqrtoken 及 g_tk 计算）
 * @param {string} str 待哈希字符串
 * @param {number} [seed] 初始种子
 * @returns {number} 哈希值
 */
const hash33 = (str, seed = 0) => {
  let h = seed
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h + str.charCodeAt(i)) & 0xffffffff) >>> 0
  }
  return h & 2147483647
}

/**
 * 生成一次性随机标识
 * @returns {string} 随机标识
 */
const randomId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

/**
 * 从响应头中提取 cookie
 * @param {any} res fetch 响应
 * @param {Record<string, string>} [existing] 需要合并的已有 cookie
 * @returns {Record<string, string>} 合并后的 cookie 键值对
 */
const extractCookies = (res, existing = {}) => {
  const cookieMap = { ...existing }
  const rawList =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : []

  const push = (raw) => {
    const first = String(raw).split(';')[0]
    const index = first.indexOf('=')
    if (index <= 0) return
    const name = first.slice(0, index).trim()
    const value = first.slice(index + 1).trim()
    if (name && value) cookieMap[name] = value
  }

  if (rawList.length > 0) {
    rawList.forEach(push)
    return cookieMap
  }

  const single = res.headers.get('set-cookie')
  if (single) {
    single.split(/,\s*(?=[a-zA-Z0-9_-]+=)/).forEach(push)
  }
  return cookieMap
}

/**
 * 生成 cookie 请求头
 * @param {Record<string, string>} cookies cookie 键值对
 * @returns {string} cookie 请求头字符串
 */
const toCookieHeader = (cookies) => {
  const usable = Object.fromEntries(
    Object.entries(cookies || {}).filter(([, value]) => !!value),
  )
  return stringifyCookie(usable)
}

/**
 * 生成 Set-Cookie 响应头数组
 * @param {Record<string, string>} cookies cookie 键值对
 * @returns {string[]} Set-Cookie 字符串数组
 */
const toSetCookieArray = (cookies) =>
  Object.entries(cookies || {})
    .filter(([, value]) => !!value)
    .map(([key, value]) => `${key}=${value}; Path=/`)

/**
 * 把登录响应转换为可持久化的会话 cookie
 * @param {Record<string, any>} credential 登录接口返回的凭据
 * @param {1 | 2} loginType 登录类型，1 为微信、2 为 QQ
 * @param {string} [fallbackMusicId] 凭据未返回账号 ID 时的回退值
 * @returns {Record<string, string>} 会话 cookie 键值对
 */
const credentialToSession = (credential, loginType, fallbackMusicId = '') => {
  const musicId = String(
    credential.str_musicid || credential.musicid || fallbackMusicId,
  ).replace(/^o/, '')
  const session = {
    uin: musicId,
    qm_str_musicid: musicId,
    qm_keyst: credential.musickey || '',
    qqmusic_key: credential.musickey || '',
    tmeLoginType: String(credential.loginType || loginType),
  }

  if (loginType === 1) session.wxuin = musicId
  if (credential.encryptUin) session.euin = credential.encryptUin
  if (credential.openid) {
    session[loginType === 1 ? 'wxopenid' : 'psrf_qqopenid'] = credential.openid
  }
  if (credential.unionid) session.psrf_qqunionid = credential.unionid
  if (credential.refresh_token) {
    session[loginType === 1 ? 'wxrefresh_token' : 'psrf_qqrefresh_token'] =
      credential.refresh_token
  }
  if (credential.access_token) {
    session.psrf_qqaccess_token = credential.access_token
  }
  if (credential.refresh_key) session.qm_refresh_key = credential.refresh_key
  if (credential.expired_at) {
    session.psrf_access_token_expiresAt = String(credential.expired_at)
  }
  if (credential.musickeyCreateTime) {
    session.psrf_musickey_createtime = String(credential.musickeyCreateTime)
  }
  if (credential.keyExpiresIn) {
    session.qm_key_expires_in = String(credential.keyExpiresIn)
  }

  return session
}

module.exports = async (query = {}) => {
  const key = String(query.key ?? '').trim()
  const type = String(query.type ?? 'qq').toLowerCase()
  if (!key) return badRequest('缺少二维码 key')
  if (type !== 'qq' && type !== 'wx') {
    return badRequest('type 只能是 qq 或 wx')
  }

  try {
    if (type === 'wx') {
      const searchParams = new URLSearchParams({
        uuid: key,
        _: String(Date.now()),
      })
      const res = await fetch(
        `https://lp.open.weixin.qq.com/connect/l/qrconnect?${searchParams}`,
        {
          headers: {
            Referer: 'https://open.weixin.qq.com/',
            'User-Agent': WEB_UA,
          },
          signal: AbortSignal.timeout(QR_TIMEOUT_MS),
        },
      )
      const text = await res.text()
      const match = /window\.wx_errcode=(\d+);window\.wx_code='([^']*)'/.exec(
        text,
      )
      if (!match) return success({ status: 1 })

      const errcode = Number(match[1])
      const wxCode = match[2]

      if (errcode === 404) return success({ status: 2 })
      if (errcode === 402 || errcode === 403) return success({ status: 0 })

      if (errcode === 405 && wxCode) {
        const loginData = await qmRequest(
          'music.login.LoginServer',
          'Login',
          { code: wxCode, strAppid: WX_APP_ID },
          { session: { uin: '', cookies: { tmeLoginType: '1' } } },
        )
        const musicId = String(
          loginData.str_musicid || loginData.musicid || '',
        ).replace(/^o/, '')
        if (!musicId || !loginData.musickey) {
          return upstreamError('微信登录响应缺少有效凭据')
        }
        const cookies = credentialToSession(loginData, 1, musicId)
        logger.info(`微信扫码登录成功 (uin: ${musicId})`)
        return success(
          {
            status: 4,
            uin: musicId,
            nickname: loginData.nick || loginData.nickname || '',
            avatarUrl: loginData.logo || loginData.avatarUrl || '',
            cookie: cookies,
          },
          { cookie: toSetCookieArray(cookies) },
        )
      }

      return success({ status: 1 })
    }

    const ptqrtoken = hash33(key, 0)
    const searchParams = new URLSearchParams({
      u1: 'https://graph.qq.com/oauth2.0/login_jump',
      ptqrtoken: String(ptqrtoken),
      ptredirect: '0',
      h: '1',
      t: '1',
      g: '1',
      from_ui: '1',
      ptlang: '2052',
      action: `0-0-${Date.now()}`,
      js_ver: '20102616',
      js_type: '1',
      pt_uistyle: '40',
      aid: '716027609',
      daid: '383',
      pt_3rd_aid: '100497308',
      has_onekey: '1',
    })
    const res = await fetch(
      `https://ssl.ptlogin2.qq.com/ptqrlogin?${searchParams}`,
      {
        headers: {
          Referer: 'https://xui.ptlogin2.qq.com/',
          Cookie: `qrsig=${key};`,
          'User-Agent': WEB_UA,
        },
        signal: AbortSignal.timeout(QR_TIMEOUT_MS),
      },
    )
    const text = await res.text()
    const match = /ptuiCB\((.*?)\)/.exec(text)
    if (!match) return success({ status: 1 })

    const args = [...match[1].matchAll(/'((?:\\.|[^'])*)'/g)].map((m) => m[1])
    const statusCode = args[0]
    const nickname = args[5] || ''

    if (statusCode === '65') return success({ status: 0 })
    if (statusCode === '67') return success({ status: 2, nickname })
    if (statusCode !== '0') return success({ status: 1 })

    const jumpUrl = args[2] ?? ''
    if (!jumpUrl || !jumpUrl.startsWith('http')) {
      return upstreamError(`无效的跳转链接: ${jumpUrl}`)
    }

    const initialCookies = extractCookies(res, { qrsig: key })
    const checkSigRes = await fetch(jumpUrl, {
      headers: {
        Referer: 'https://xui.ptlogin2.qq.com/',
        Cookie: toCookieHeader(initialCookies),
        'User-Agent': WEB_UA,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(QR_TIMEOUT_MS),
    })
    const sessionCookies = extractCookies(checkSigRes, initialCookies)
    const pSkey =
      sessionCookies.p_skey ||
      sessionCookies.p_sKey ||
      sessionCookies.skey ||
      sessionCookies.pskey
    if (!pSkey) {
      logger.warn('check_sig 未提取到 p_skey')
      return upstreamError('获取 p_skey 失败')
    }

    const authBody = new URLSearchParams({
      response_type: 'code',
      client_id: '100497308',
      redirect_uri:
        'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
      scope: 'get_user_info,get_app_friends',
      state: 'state',
      switch: '',
      from_ptlogin: '1',
      src: '1',
      update_auth: '1',
      openapi: '1010_1030',
      g_tk: String(hash33(pSkey, 5381)),
      auth_time: String(Date.now()),
      ui: randomId(),
    })
    const authRes = await fetch('https://graph.qq.com/oauth2.0/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://xui.ptlogin2.qq.com/',
        Cookie: toCookieHeader(sessionCookies),
        'User-Agent': WEB_UA,
      },
      body: authBody.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(QR_TIMEOUT_MS),
    })
    const location =
      authRes.headers.get('Location') || authRes.headers.get('location') || ''
    const codeMatch = /(?<=code=)(.+?)(?=&|$)/.exec(location)
    if (!codeMatch) {
      logger.warn('authorize 未返回 code')
      return upstreamError('获取 QQ 授权 code 失败')
    }
    const code = codeMatch[1]

    const loginData = await qmRequest(
      'QQConnectLogin.LoginServer',
      'QQLogin',
      { code },
      { session: { uin: '', cookies: { tmeLoginType: '2' } } },
    )

    const uinMatch = /(?:\?|&)uin=(.+?)&/.exec(jumpUrl)
    const connectUin = uinMatch ? uinMatch[1] : ''
    const musicId = String(
      loginData.str_musicid || loginData.musicid || connectUin,
    ).replace(/^o/, '')
    if (!musicId || !loginData.musickey) {
      return upstreamError('QQ 登录响应缺少有效凭据')
    }

    const cookies = {
      ...credentialToSession(loginData, 2, connectUin),
    }
    // 音乐凭据只够读：歌单写入类接口会做更严的授权校验，
    // 缺 p_skey 一类互联 cookie 时统一返回 1000 / authorize fail。
    for (const name of ['p_skey', 'skey', 'p_uin', 'pt4_token', 'supervisor']) {
      const value = sessionCookies[name]
      if (value) cookies[name] = value
    }

    logger.info(`QQ 扫码登录成功 (uin: ${musicId})`)
    return success(
      {
        status: 4,
        uin: musicId,
        nickname: loginData.nick || loginData.nickname || nickname,
        avatarUrl:
          loginData.logo ||
          loginData.avatarUrl ||
          `https://q.qlogo.cn/headimg_dl?dst_uin=${musicId}&spec=100`,
        cookie: cookies,
      },
      { cookie: toSetCookieArray(cookies) },
    )
  } catch (err) {
    logger.error('轮询扫码结果异常:', err && err.message)
    return upstreamError(`轮询扫码结果失败: ${err && err.message}`)
  }
}
