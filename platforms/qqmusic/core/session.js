/**
 * QQ 音乐会话读取入口
 *
 * 平台层契约约定会话读取入口为 `core/session.js` 的 `readSession(query)`，
 * 实际解析实现放在 `core/credential.js`，本文件提供同一入口的转发，
 * 避免平台模块因引用路径不同而拿不到凭据。
 */

const { readSession } = require('./credential')

module.exports = {
  readSession,
}
