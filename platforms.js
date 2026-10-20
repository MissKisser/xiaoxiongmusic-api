/**
 * 平台扩展层第二组导出入口
 *
 * 与上游 `main.js` 平铺导出的网易云接口并列，互不干扰：
 * - `require('xiaoxiongmusic-api')` → 网易云 439 个接口（平铺）+ server 辅助
 * - `require('xiaoxiongmusic-api/platforms')` → 本文件，三平台分组导出
 *
 * 示例：
 * const { qqmusic, kugou } = require('xiaoxiongmusic-api/platforms')
 * await kugou.playlist_create({ name: '我的歌单', cookie: '...' })
 */

// 必须显式指向目录入口：本文件与 platforms/ 目录同名，
// `require('./platforms')` 会优先命中本文件自身，形成循环引用。
module.exports = require('./platforms/index.js')
