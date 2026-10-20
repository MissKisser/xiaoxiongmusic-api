/**
 * 酷狗设备指纹
 *
 * 提供设备指纹的构造、加解密与设备注册。
 * 本模块不做任何缓存：注册得到的 dfid 只作为返回值交给调用方，
 * 是否留存由服务层决定。
 */

const { randomUUID } = require('node:crypto')

const {
  KG_ANDROID_UA,
  KG_DEFAULT_TIMEOUT_MS,
  getKgAppid,
  getKgClientver,
} = require('./config')

const {
  decryptKugouDeviceData,
  encryptKugouDeviceData,
  getDeviceMid,
  rsaEncryptKugouPkcs1,
  signatureAndroidParams,
} = require('./crypto')

/** 设备注册服务地址 */
const KG_DEVICE_REGISTER_URL =
  'https://userservice.kugou.com/risk/v2/r_register_dev'

/**
 * 构造设备指纹
 * @param {string} guid 设备 GUID
 * @returns {Record<string, any>} 设备指纹
 */
const buildDevicePayload = (guid) => ({
  availableRamSize: 4983533568,
  availableRomSize: 48114719,
  availableSDSize: 48114717,
  basebandVer: '',
  batteryLevel: 100,
  batteryStatus: 3,
  brand: 'Redmi',
  buildSerial: 'unknown',
  device: 'marble',
  imei: guid,
  imsi: '',
  manufacturer: 'Xiaomi',
  uuid: guid,
  accelerometer: false,
  accelerometerValue: '',
  gravity: false,
  gravityValue: '',
  gyroscope: false,
  gyroscopeValue: '',
  light: false,
  lightValue: '',
  magnetic: false,
  magneticValue: '',
  orientation: false,
  orientationValue: '',
  pressure: false,
  pressureValue: '',
  step_counter: false,
  step_counterValue: '',
  temperature: false,
  temperatureValue: '',
})

/**
 * 加密设备指纹
 * @param {Record<string, any>} payload 设备指纹
 * @returns {{ key: string, content: string }} 会话串与 base64 密文
 */
const encryptDevicePayload = (payload) => encryptKugouDeviceData(payload)

/**
 * 解密设备指纹
 * @param {Buffer} content 密文字节
 * @param {string} key 会话串
 * @returns {any} 解析后的设备指纹
 */
const decryptDevicePayload = (content, key) =>
  decryptKugouDeviceData(content, key)

/**
 * 向酷狗注册设备，取回 dfid
 *
 * 该链路是可选的：dfid 缺失时平台侧按 `-` 处理也能工作，
 * 因此调用与否由上层决定。
 * @param {{ token?: string, userid?: string, guid?: string }} [session] 会话凭据
 * @returns {Promise<string>} dfid
 */
const registerDevice = async (session = {}) => {
  const guid = session.guid || randomUUID()
  const encrypted = encryptDevicePayload(buildDevicePayload(guid))
  const clienttime = Math.floor(Date.now() / 1000)

  const params = {
    dfid: '-',
    mid: getDeviceMid(),
    uuid: '-',
    appid: getKgAppid(),
    clientver: getKgClientver(),
    clienttime,
    part: 1,
    platid: 1,
    p: rsaEncryptKugouPkcs1({
      aes: encrypted.key,
      uid: Number(session.userid || 0),
      token: session.token || '',
    }),
  }
  params.signature = signatureAndroidParams(params, encrypted.content)

  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  )

  const res = await fetch(`${KG_DEVICE_REGISTER_URL}?${query.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': KG_ANDROID_UA,
      dfid: '-',
      mid: getDeviceMid(),
      clienttime: String(clienttime),
    },
    body: encrypted.content,
    signal: AbortSignal.timeout(KG_DEFAULT_TIMEOUT_MS),
  })

  if (!res.ok) throw new Error(`酷狗设备注册 HTTP ${res.status}`)

  const result = decryptDevicePayload(
    Buffer.from(await res.arrayBuffer()),
    encrypted.key,
  )
  const dfid = result && result.data ? result.data.dfid : ''
  if (!dfid) throw new Error('酷狗设备注册失败：未返回 dfid')
  return String(dfid)
}

/**
 * 取设备 dfid
 *
 * 会话里已有 dfid 时直接复用，否则走一次设备注册。
 * @param {{ token?: string, userid?: string, guid?: string, dfid?: string }} [session] 会话凭据
 * @returns {Promise<string>} dfid
 */
const ensureKugouDfid = async (session = {}) => {
  if (session.dfid) return session.dfid
  return registerDevice(session)
}

module.exports = {
  KG_DEVICE_REGISTER_URL,
  buildDevicePayload,
  encryptDevicePayload,
  decryptDevicePayload,
  registerDevice,
  ensureKugouDfid,
}
