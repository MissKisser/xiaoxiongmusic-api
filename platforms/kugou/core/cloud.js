/**
 * 酷狗请求构造层
 *
 * 这里只做「拼请求」，不发网络请求，因此可以脱离网络单测。
 *
 * 覆盖两套协议：
 * - 协议 A（buildGatewayRequest）：Android 客户端签名 + 明文 JSON body
 * - 协议 B（buildCloudRequest）：RSA 传参 + AES-128-CBC 加密 body
 */

const {
  constants,
  createCipheriv,
  createDecipheriv,
  publicEncrypt,
  randomInt,
} = require('node:crypto')

const {
  KG_AES_ALPHABET,
  KG_ANDROID_UA,
  KG_CLOUDLIST_ROUTER,
  KG_CLOUD_APPID,
  KG_CLOUD_CLIENTVER,
  KG_CLOUD_PUBLIC_KEY,
  KG_CLOUD_SIGN_SALT,
  KG_GATEWAY_URL,
} = require('./config')

const { md5, stringifyParams } = require('./crypto')

/**
 * 协议请求上下文
 *
 * @typedef {object} KgRequestContext
 * @property {number} appid 客户端标识
 * @property {number} clientver 客户端版本号
 * @property {string} signSalt 签名盐值
 * @property {string} mid 设备 MID（十进制字符串）
 * @property {string} dfid 设备指纹
 * @property {string} userid 账号 ID
 * @property {string} token 登录 token
 * @property {number} clienttime 秒级时间戳
 */

/**
 * 构造好的请求
 *
 * @typedef {object} BuiltRequest
 * @property {string} url 完整请求地址
 * @property {Record<string, string>} headers 请求头
 * @property {string | Buffer} body 请求体（协议 A 为 JSON 文本，协议 B 为密文字节）
 * @property {string} [method] 请求方法（协议 A；GET 时不携带 body 与 Content-Type）
 * @property {Record<string, any>} [params] 参与签名的参数表（协议 A）
 * @property {string} [signature] 请求签名（协议 A）
 * @property {string} [aes] AES 会话串（协议 B，用于解密响应）
 */

/**
 * 由 AES 会话串派生密钥与初始向量
 *
 * 两者都是 16 个 ASCII 字符，按 UTF-8 字节使用，不是 hex 解码后的 8 字节。
 * @param {string} aes 6 位会话串
 * @returns {{ key: string, iv: string }} 密钥与初始向量
 */
const deriveAesKey = (aes) => {
  const digest = md5(aes)
  return { key: digest.slice(0, 16), iv: digest.slice(16, 32) }
}

/**
 * 随机生成 AES 会话串
 * @returns {string} 6 位会话串
 */
const randomAes = () => {
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    out += KG_AES_ALPHABET[randomInt(KG_AES_ALPHABET.length)]
  }
  return out
}

/**
 * 构造协议 A 请求：Android 客户端签名 + 明文 JSON body
 * @param {string} path 网关相对路径
 * @param {Record<string, any>} body 业务请求体
 * @param {KgRequestContext} ctx 请求上下文
 * @param {{ params?: Record<string, any>, headers?: Record<string, string>, baseURL?: string, method?: 'GET' | 'POST' }} [options] 附加参数、请求头、网关地址与请求方法
 * @returns {BuiltRequest} 构造好的请求
 */
const buildGatewayRequest = (path, body, ctx, options = {}) => {
  const method = options.method === 'GET' ? 'GET' : 'POST'
  const merged = {
    dfid: ctx.dfid || '-',
    mid: ctx.mid,
    uuid: '-',
    appid: ctx.appid,
    clientver: ctx.clientver,
    clienttime: ctx.clienttime,
    ...(ctx.token ? { token: ctx.token } : {}),
    ...(ctx.userid ? { userid: ctx.userid } : {}),
    ...(options.params || {}),
  }

  // 签名只覆盖不含 signature 自身的参数表
  const params = {}
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'signature') continue
    params[key] = value
  }

  // GET 请求不携带 body，签名按空 body 计算；
  // 带 `Content-Type: application/json` 却无 body 时网关会返回 error_code=20006。
  const bodyStr = method === 'GET' ? '' : JSON.stringify(body ?? {})
  const signature = md5(
    `${ctx.signSalt}${stringifyParams(params)}${bodyStr}${ctx.signSalt}`,
  )

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    query.append(
      key,
      typeof value === 'object' ? JSON.stringify(value) : String(value),
    )
  }
  query.append('signature', signature)

  const headers = {
    'User-Agent': KG_ANDROID_UA,
    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    dfid: ctx.dfid || '-',
    clienttime: String(ctx.clienttime),
    mid: ctx.mid,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    ...(options.headers || {}),
  }

  const baseURL = options.baseURL || KG_GATEWAY_URL
  return {
    url: `${baseURL}${path}?${query.toString()}`,
    headers,
    method,
    body: bodyStr,
    params,
    signature,
  }
}

/**
 * 构造协议 B 请求：RSA 传参 + AES-128-CBC 加密 body
 *
 * 协议 B 的标识固定取概念版：cloudlist 集群只受理概念版请求。
 * @param {string} path 网关相对路径
 * @param {Record<string, any>} body 业务请求体
 * @param {KgRequestContext} ctx 请求上下文
 * @param {{ baseURL?: string }} [options] 网关地址
 * @returns {BuiltRequest} 构造好的请求，aes 字段用于解密响应
 */
const buildCloudRequest = (path, body, ctx, options = {}) => {
  const aes = randomAes()
  const { key, iv } = deriveAesKey(aes)

  const appid = KG_CLOUD_APPID
  const clientver = KG_CLOUD_CLIENTVER
  const keyParam = md5(
    `${appid}${KG_CLOUD_SIGN_SALT}${clientver}${ctx.clienttime}`,
  ).toLowerCase()

  const p = publicEncrypt(
    { key: KG_CLOUD_PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(
      JSON.stringify({ aes, uid: ctx.userid, token: ctx.token }),
      'utf8',
    ),
  )
    .toString('hex')
    .toUpperCase()

  const query = new URLSearchParams()
  query.append('appid', String(appid))
  query.append('clientver', String(clientver))
  query.append('mid', ctx.mid)
  query.append('clienttime', String(ctx.clienttime))
  query.append('key', keyParam)
  query.append('dfid', ctx.dfid || '-')
  query.append('p', p)

  const headers = {
    'User-Agent': KG_ANDROID_UA,
    'x-router': KG_CLOUDLIST_ROUTER,
    'Content-Type': 'application/json;charset=utf-8',
    dfid: ctx.dfid || '-',
    clienttime: String(ctx.clienttime),
    mid: ctx.mid,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
  }

  const cipher = createCipheriv(
    'aes-128-cbc',
    Buffer.from(key, 'utf8'),
    Buffer.from(iv, 'utf8'),
  )
  const cipherText = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(body ?? {}), 'utf8')),
    cipher.final(),
  ])

  const baseURL = options.baseURL || KG_GATEWAY_URL
  return {
    url: `${baseURL}${path}?${query.toString()}`,
    headers,
    body: cipherText,
    aes,
  }
}

/**
 * 解密协议 B 的响应
 * @param {Buffer} raw 响应原始字节
 * @param {string} aes 请求时使用的 AES 会话串
 * @returns {string} 解密后的文本，解密失败时退回原始字节的 UTF-8 文本
 */
const decryptCloudResponse = (raw, aes) => {
  try {
    const { key, iv } = deriveAesKey(aes)
    const decipher = createDecipheriv(
      'aes-128-cbc',
      Buffer.from(key, 'utf8'),
      Buffer.from(iv, 'utf8'),
    )
    return Buffer.concat([decipher.update(raw), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    return raw.toString('utf8')
  }
}

module.exports = {
  deriveAesKey,
  randomAes,
  buildGatewayRequest,
  buildCloudRequest,
  decryptCloudResponse,
}
