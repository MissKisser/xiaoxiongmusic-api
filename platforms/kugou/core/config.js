/**
 * 酷狗平台常量与运行时配置
 *
 * 这里的取值直接决定签名结果，改动会让平台侧请求全部失效。
 * 「概念版 / 标准版」由环境变量 `KUGOU_LOGIN_VERSION` 决定：
 * - `concept`：概念版标识，走概念版集群
 * - `standard`（默认）：标准版标识
 *
 * 选择理由：酷狗的登录 token 与客户端标识是**绑定**的，cloudlist 的读写必须
 * 与登录时同一套标识。用另一套标识签名，网关会以 `error_code=20017` 拒收，
 * 「读取歌单列表」这类前置调用直接落空，依赖它们的写操作（定位「我喜欢」
 * 歌单、加歌、删歌）随之全部失败。账号用哪套标识以登录时的那套为准。
 */

/** 酷狗网关地址 */
const KG_GATEWAY_URL = 'https://gateway.kugou.com'

/** 登录服务地址（二维码登录） */
const KG_LOGIN_URL = 'https://login-user.kugou.com'

/** 移动端 CDN 搜索地址 */
const KG_MOBILECDN_URL = 'http://mobilecdn.kugou.com/api/v3/search/song'

/** 兜底搜索地址 */
const KG_SEARCH_URL = 'https://songsearch.kugou.com/song_search_v2'

/** 歌词搜索地址 */
const KG_LYRIC_SEARCH_URL = 'http://lyrics.kugou.com/search'

/** 歌词下载地址 */
const KG_LYRIC_DOWNLOAD_URL = 'http://lyrics.kugou.com/download'

/** Android 客户端 UA */
const KG_ANDROID_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'

/** 云歌单服务路由头 */
const KG_CLOUDLIST_ROUTER = 'cloudlist.service.kugou.com'

/** 默认请求超时（毫秒） */
const KG_DEFAULT_TIMEOUT_MS = 10000

/** 概念版标识与密钥 */
const KG_CONCEPT_PROFILE = {
  appid: 3116,
  clientver: 11440,
  signSalt: 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA',
  signKeySalt: '185672dd44712f60bb1736df5a377e82',
  publicKey: `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB
-----END PUBLIC KEY-----`,
}

/** 标准版标识与密钥 */
const KG_STANDARD_PROFILE = {
  appid: 1005,
  clientver: 20489,
  signSalt: 'OIlwieks28dk2k092lksi2UIkp',
  signKeySalt: '57ae12eb6890223e355ccfcb74edf70d',
  publicKey: `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`,
}

/** 概念版开关的环境变量名 */
const KG_LOGIN_VERSION_ENV = 'KUGOU_LOGIN_VERSION'

/** 协议 B 公钥兜底（请求上下文中未带公钥时使用） */
const KG_CLOUD_PUBLIC_KEY = KG_CONCEPT_PROFILE.publicKey

/** AES 会话串字符表 */
const KG_AES_ALPHABET =
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** 设备 MID 的固定种子 */
const KG_MID_SEED = 'splayer-next-kugou-device-mid'

/**
 * 判断当前是否运行在概念版模式
 *
 * 未设置或取值不合法时一律按标准版处理。
 * @returns {boolean} true 表示概念版
 */
const isConceptMode = () => {
  const raw = String(process.env[KG_LOGIN_VERSION_ENV] || '')
    .trim()
    .toLowerCase()
  return raw === 'concept'
}

/**
 * 取当前生效的标识与密钥集合
 * @returns {{ appid: number, clientver: number, signSalt: string, signKeySalt: string, publicKey: string }} 标识与密钥
 */
const currentProfile = () =>
  isConceptMode() ? KG_CONCEPT_PROFILE : KG_STANDARD_PROFILE

/**
 * 取当前生效的 appid
 * @returns {number} 客户端标识
 */
const getKgAppid = () => currentProfile().appid

/**
 * 取当前生效的 clientver
 * @returns {number} 客户端版本号
 */
const getKgClientver = () => currentProfile().clientver

/**
 * 取当前生效的 Android 签名盐值
 * @returns {string} 签名盐值
 */
const getSignSalt = () => currentProfile().signSalt

/**
 * 取当前生效的音频请求密钥盐值
 * @returns {string} 密钥盐值
 */
const getSignKeySalt = () => currentProfile().signKeySalt

/**
 * 取当前生效的 RSA 公钥
 * @returns {string} PEM 格式公钥
 */
const getPublicKey = () => currentProfile().publicKey

module.exports = {
  KG_GATEWAY_URL,
  KG_LOGIN_URL,
  KG_MOBILECDN_URL,
  KG_SEARCH_URL,
  KG_LYRIC_SEARCH_URL,
  KG_LYRIC_DOWNLOAD_URL,
  KG_ANDROID_UA,
  KG_CLOUDLIST_ROUTER,
  KG_DEFAULT_TIMEOUT_MS,
  KG_CONCEPT_PROFILE,
  KG_STANDARD_PROFILE,
  KG_LOGIN_VERSION_ENV,
  KG_CLOUD_PUBLIC_KEY,
  KG_AES_ALPHABET,
  KG_MID_SEED,
  isConceptMode,
  currentProfile,
  getKgAppid,
  getKgClientver,
  getSignSalt,
  getSignKeySalt,
  getPublicKey,
}
