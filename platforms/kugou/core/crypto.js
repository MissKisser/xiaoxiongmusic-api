/**
 * 酷狗加密与签名工具
 *
 * 只依赖 node:crypto，不引用任何客户端运行时，可直接用于服务端。
 */

const {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
} = require('node:crypto')

const {
  KG_MID_SEED,
  getKgAppid,
  getKgClientver,
  getPublicKey,
  getSignKeySalt,
  getSignSalt,
} = require('./config')

/** Web 端签名盐值 */
const WEB_SIGN_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'

/**
 * 计算 MD5 哈希
 * @param {string | Buffer} data 待计算的数据
 * @returns {string} 32 位小写 hex 哈希
 */
const md5 = (data) => createHash('md5').update(data).digest('hex')

/**
 * 把参数表序列化为参与签名的字符串
 *
 * key 按字母序排列，逐个拼成无分隔符的 `k=v` 串；对象值先做 JSON 序列化。
 * @param {Record<string, any>} params 参数表
 * @returns {string} 参与签名的参数字符串
 */
const stringifyParams = (params) =>
  Object.keys(params)
    .sort()
    .map((key) => {
      const value = params[key]
      const text =
        typeof value === 'object' && value !== null
          ? JSON.stringify(value)
          : value
      return `${key}=${text ?? ''}`
    })
    .join('')

/**
 * 按酷狗协议执行无填充 RSA 加密
 *
 * 明文先补齐到 128 字节再整体加密，密文以 hex 输出。
 * @param {Record<string, any>} data 待加密对象
 * @returns {string} 十六进制密文
 */
const rsaEncryptKugou = (data) => {
  const input = Buffer.from(JSON.stringify(data))
  const block = Buffer.alloc(128)
  input.copy(block)
  return publicEncrypt(
    { key: getPublicKey(), padding: constants.RSA_NO_PADDING },
    block,
  ).toString('hex')
}

/**
 * 按酷狗协议执行 PKCS1 填充的 RSA 加密
 * @param {Record<string, any>} data 待加密对象
 * @returns {string} 十六进制密文
 */
const rsaEncryptKugouPkcs1 = (data) =>
  publicEncrypt(
    { key: getPublicKey(), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(JSON.stringify(data)),
  ).toString('hex')

/**
 * 加密设备指纹数据
 * @param {Record<string, any>} data 设备指纹
 * @returns {{ key: string, content: string }} 会话串与 base64 密文
 */
const encryptKugouDeviceData = (data) => {
  const key = randomBytes(3).toString('hex')
  const digest = md5(key)
  const cipher = createCipheriv(
    'aes-128-cbc',
    digest.slice(0, 16),
    digest.slice(16, 32),
  )
  const content = Buffer.concat([
    cipher.update(JSON.stringify(data)),
    cipher.final(),
  ]).toString('base64')
  return { key, content }
}

/**
 * 解密设备指纹数据
 * @param {Buffer} content 密文字节
 * @param {string} key 会话串
 * @returns {any} 解析后的设备指纹
 */
const decryptKugouDeviceData = (content, key) => {
  const digest = md5(key)
  const decipher = createDecipheriv(
    'aes-128-cbc',
    digest.slice(0, 16),
    digest.slice(16, 32),
  )
  const text = Buffer.concat([
    decipher.update(content),
    decipher.final(),
  ]).toString('utf8')
  return JSON.parse(text)
}

/**
 * 由 GUID 计算设备 MID
 * @param {string} [guid] 设备 GUID
 * @returns {string} MID 十进制字符串
 */
const calculateMid = (guid = '550e8400-e29b-41d4-a716-446655440000') =>
  BigInt(`0x${md5(guid)}`).toString(10)

/**
 * 计算本应用使用的设备 MID
 *
 * 固定种子，结果恒定，因此不需要任何缓存。
 * @returns {string} MID 十进制字符串
 */
const getDeviceMid = () => calculateMid(KG_MID_SEED)

/**
 * Android 端接口请求签名
 *
 * 算法：`md5(salt + 排序后的 k=v 串 + body + salt)`。
 * @param {Record<string, any>} params 查询参数，参与签名的表里不能含 signature
 * @param {string | Buffer} [data] 请求体
 * @returns {string} 32 位签名字符串
 */
const signatureAndroidParams = (params, data = '') => {
  const paramsString = stringifyParams(params)
  const bodyStr = typeof data === 'string' ? data : data.toString('utf8')
  return md5(`${getSignSalt()}${paramsString}${bodyStr}${getSignSalt()}`)
}

/**
 * Web 端接口请求签名
 * @param {Record<string, any>} params 请求参数
 * @returns {string} 32 位签名字符串
 */
const signatureWebParams = (params) => {
  const paramsString = Object.keys(params)
    .map((key) => `${key}=${params[key] ?? ''}`)
    .sort()
    .join('')
  return md5(`${WEB_SIGN_SALT}${paramsString}${WEB_SIGN_SALT}`)
}

/**
 * 参数密钥签名
 *
 * 算法：`md5(appid + salt + clientver + data)`。
 * @param {string | number} data 参与签名的数据
 * @param {number} [appid] 客户端标识
 * @param {number} [clientver] 客户端版本号
 * @returns {string} 32 位签名字符串
 */
const signParamsKey = (
  data,
  appid = getKgAppid(),
  clientver = getKgClientver(),
) => md5(`${appid}${getSignSalt()}${clientver}${data}`)

/**
 * 音频请求密钥签名
 *
 * 算法：`md5(hash + salt + appid + mid + userid)`。
 * @param {string} hash 音频 hash
 * @param {string} [mid] 设备 MID
 * @param {string | number} [userid] 账号 ID
 * @param {number} [appid] 客户端标识
 * @returns {string} 32 位签名字符串
 */
const signKey = (
  hash,
  mid = getDeviceMid(),
  userid = 0,
  appid = getKgAppid(),
) => md5(`${hash}${getSignKeySalt()}${appid}${mid}${userid}`)

/**
 * 清理响应文本中的标签包裹
 * @param {string} text 原始响应文本
 * @returns {string} 纯 JSON 文本
 */
const cleanKgResponse = (text) =>
  String(text)
    .trim()
    .replace(/^<!--KG_TAG_RES_START-->/, '')
    .replace(/<!--KG_TAG_RES_END-->$/, '')

module.exports = {
  md5,
  stringifyParams,
  rsaEncryptKugou,
  rsaEncryptKugouPkcs1,
  encryptKugouDeviceData,
  decryptKugouDeviceData,
  calculateMid,
  getDeviceMid,
  signatureAndroidParams,
  signatureWebParams,
  signParamsKey,
  signKey,
  cleanKgResponse,
}
