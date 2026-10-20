/**
 * QQ 音乐扫码登录：获取二维码
 *
 * 支持两种扫码协议：`qq`（QQ 互联）与 `wx`（微信开放平台）。
 * 两者都返回自包含的 key（QQ 为 qrsig，微信为 uuid），
 * 供 `login_qr_check` 轮询登录结果，接口层自身不保存任何状态。
 */

const { success, badRequest, upstreamError } = require('../../shared/response')
const { createLogger } = require('../../shared/logger')

const logger = createLogger('qqmusic')

/** 模拟桌面浏览器的 User-Agent */
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 微信开放平台应用 ID */
const WX_APP_ID = 'wx48db31d50e334801'

/** 扫码相关请求的超时时间（毫秒） */
const QR_TIMEOUT_MS = 8000

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

module.exports = async (query = {}) => {
  const type = String(query.type ?? 'qq').toLowerCase()
  if (type !== 'qq' && type !== 'wx') {
    return badRequest('type 只能是 qq 或 wx')
  }

  try {
    if (type === 'wx') {
      const searchParams = new URLSearchParams({
        appid: WX_APP_ID,
        redirect_uri:
          'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/',
        response_type: 'code',
        scope: 'snsapi_login',
        state: 'STATE',
        href: 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect',
      })
      const pageRes = await fetch(
        `https://open.weixin.qq.com/connect/qrconnect?${searchParams}`,
        {
          headers: { 'User-Agent': WEB_UA },
          signal: AbortSignal.timeout(QR_TIMEOUT_MS),
        },
      )
      if (!pageRes.ok) {
        return upstreamError(`获取微信登录页面失败: HTTP ${pageRes.status}`)
      }
      const html = await pageRes.text()
      const match =
        /uuid=([^"]+)"/.exec(html) || /uuid=([a-zA-Z0-9_-]+)/.exec(html)
      if (!match) return upstreamError('获取微信登录二维码 uuid 失败')
      const uuid = match[1]

      const qrRes = await fetch(
        `https://open.weixin.qq.com/connect/qrcode/${uuid}`,
        {
          headers: {
            Referer: 'https://open.weixin.qq.com/connect/qrconnect',
            'User-Agent': WEB_UA,
          },
          signal: AbortSignal.timeout(QR_TIMEOUT_MS),
        },
      )
      if (!qrRes.ok) {
        return upstreamError(`获取微信登录二维码图片失败: HTTP ${qrRes.status}`)
      }
      const buffer = Buffer.from(await qrRes.arrayBuffer())
      return success({
        key: uuid,
        content: `data:image/jpeg;base64,${buffer.toString('base64')}`,
        type: 'wx',
      })
    }

    const url = `https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}&daid=383&pt_3rd_aid=100497308`
    const res = await fetch(url, {
      headers: {
        Referer: 'https://xui.ptlogin2.qq.com/',
        'User-Agent': WEB_UA,
      },
      signal: AbortSignal.timeout(QR_TIMEOUT_MS),
    })
    if (!res.ok) {
      return upstreamError(`获取 QQ 登录二维码失败: HTTP ${res.status}`)
    }

    const cookies = extractCookies(res)
    const qrsig = cookies.qrsig
    if (!qrsig) return upstreamError('未能获取到 QQ 登录 qrsig')

    const buffer = Buffer.from(await res.arrayBuffer())
    return success({
      key: qrsig,
      content: `data:image/png;base64,${buffer.toString('base64')}`,
      type: 'qq',
    })
  } catch (err) {
    logger.error('获取登录二维码异常:', err && err.message)
    return upstreamError(`获取登录二维码失败: ${err && err.message}`)
  }
}
