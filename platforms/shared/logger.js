/**
 * 平台层日志
 *
 * 复用上游 `util/logger.js` 的 ANSI 彩色输出，但**不引入 electron-log**，
 * 以保证平台层能在任意 Node 进程（服务端、脚本、测试）里加载。
 */

const upstreamLogger = require('../../util/logger')

/**
 * 构造带平台前缀的日志器
 * @param {string} platform 平台标识
 * @returns {{ info: Function, error: Function, warn: Function, success: Function, debug: Function }} 日志器
 */
const createLogger = (platform) => ({
  info: (...args) => upstreamLogger.info(`[${platform}]`, ...args),
  error: (...args) => upstreamLogger.error(`[${platform}]`, ...args),
  warn: (...args) => upstreamLogger.warn(`[${platform}]`, ...args),
  success: (...args) => upstreamLogger.success(`[${platform}]`, ...args),
  debug: (...args) => upstreamLogger.debug(`[${platform}]`, ...args),
})

module.exports = {
  createLogger,
}
