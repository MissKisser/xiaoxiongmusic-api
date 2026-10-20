/**
 * 平台扩展层注册表
 *
 * 本目录承载网易云之外的音乐平台（QQ 音乐 / 酷狗）的能力。
 *
 * 设计约束（决定了本文件的全部形态）：
 * 1. **不碰上游 `module/`**。上游 `main.js` 运行时扫描 `module/` 目录，
 *    导出键名恒等于文件名，URL 路径由 `_` → `/` 机械推导。把平台模块塞进
 *    `module/` 会污染上游命名空间，并让每次合并上游都产生大面积冲突。
 * 2. **平台模块自带 HTTP 层**。上游 `server.js` 注入的 `request` 固定是网易
 *    的 `util/request.js`（写死了网易域名、密钥、eapi/weapi/xeapi 加密），
 *    平台必须忽略该入参、自行发请求。
 * 3. **接口层无状态**。凭据由调用方以参数传入，平台层不做任何跨请求缓存，
 *    避免多账号场景下静默串号。
 */

const fs = require('fs')
const path = require('path')

const { parseCookie } = require('./shared/cookie')

/**
 * 平台注册表
 * @typedef {object} PlatformSpec
 * @property {string} id 平台标识
 * @property {string} dir 平台目录名（相对本目录）
 * @property {string} prefix 路由前缀
 * @property {string} label 平台中文名
 */

/** @type {PlatformSpec[]} */
const PLATFORM_SPECS = [
  { id: 'qqmusic', dir: 'qqmusic', prefix: '/qqmusic', label: 'QQ 音乐' },
  { id: 'kugou', dir: 'kugou', prefix: '/kugou', label: '酷狗音乐' },
]

/**
 * 列出某平台 modules 目录下的模块文件
 * @param {PlatformSpec} spec 平台描述
 * @returns {string[]} 模块文件名列表
 */
const listModuleFiles = (spec) => {
  const modulesPath = path.join(__dirname, spec.dir, 'modules')
  if (!fs.existsSync(modulesPath)) return []
  return fs.readdirSync(modulesPath).filter((file) => file.endsWith('.js'))
}

/**
 * 由模块文件名推导路由
 *
 * 规则与上游 `getModulesDefinitions` 一致（`_` → `/`），额外加平台前缀。
 * @param {PlatformSpec} spec 平台描述
 * @param {string} file 模块文件名
 * @returns {string} 完整路由
 */
const routeOf = (spec, file) =>
  `${spec.prefix}/${file.replace(/\.js$/i, '').replace(/_/g, '/')}`

/**
 * 加载单个平台的模块函数表
 *
 * 包装方式与上游 `main.js` 一致：调用方传入的 cookie 字符串在此处统一解析，
 * 平台模块拿到的永远是键值对对象。
 * @param {PlatformSpec} spec 平台描述
 * @returns {Record<string, (data?: any) => Promise<any>>} 模块函数表
 */
const loadPlatform = (spec) => {
  const modulesPath = path.join(__dirname, spec.dir, 'modules')
  const api = {}

  for (const file of listModuleFiles(spec)) {
    const identifier = file.replace(/\.js$/i, '')
    const platformModule = require(path.join(modulesPath, file))

    api[identifier] = async (data = {}) => {
      const cookie = parseCookie(data.cookie)
      return platformModule({ ...data, cookie })
    }
  }

  return api
}

/**
 * 生成某平台的路由定义
 *
 * 形状与上游 `getModulesDefinitions` 的返回值一致，可直接与网易云侧的
 * moduleDefs 数组合并后传给 `serveNcmApi({ moduleDefs })`。
 * @param {PlatformSpec} spec 平台描述
 * @returns {Array<{ identifier: string, route: string, module: any }>} 路由定义
 */
const platformModuleDefs = (spec) => {
  const modulesPath = path.join(__dirname, spec.dir, 'modules')

  return listModuleFiles(spec).map((file) => ({
    identifier: file.replace(/\.js$/i, ''),
    route: routeOf(spec, file),
    module: require(path.join(modulesPath, file)),
  }))
}

/**
 * 生成全部平台的路由定义
 * @returns {Array<{ identifier: string, route: string, module: any }>} 路由定义
 */
const allPlatformModuleDefs = () =>
  PLATFORM_SPECS.flatMap((spec) => platformModuleDefs(spec))

/**
 * 平台分组导出
 *
 * 结构：`{ qqmusic: { playlist_create: fn, ... }, kugou: { ... } }`
 */
const platforms = Object.fromEntries(
  PLATFORM_SPECS.map((spec) => [spec.id, loadPlatform(spec)]),
)

module.exports = {
  ...platforms,
  platforms,
  PLATFORM_SPECS,
  listModuleFiles,
  routeOf,
  platformModuleDefs,
  allPlatformModuleDefs,
}
