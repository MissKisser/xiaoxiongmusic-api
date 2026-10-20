#!/usr/bin/env node
/**
 * 三平台独立启动入口
 *
 * 与上游 `app.js` 的区别：把 QQ 音乐与酷狗音乐的路由也挂进来，
 * 使本仓库可以作为一个**三平台接口层**独立提供服务。
 *
 * 上游 `app.js` / `server.js` / `main.js` / `module/` / `util/` 一行未改，
 * 平台路由通过 `serveNcmApi({ moduleDefs })` 注入——上游的
 * `getModulesDefinitions` 与 `serveNcmApi` 本就支持传入自定义路由定义。
 *
 * 启动：node app-multi.js
 * 环境变量：
 * - PORT / HOST      监听端口与地址（与上游一致）
 * - KEEP_RESPONSE_CACHE=true  保留上游的 2 分钟响应缓存（默认关闭，见下方说明）
 */
const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()

/**
 * 上游 `server.js` 中对三个模块的硬编码路由特例。
 * 自行调用 `getModulesDefinitions` 时必须原样传入，否则这三个路由会从
 * `/daily_signin` 变成 `/daily/signin`，破坏已有客户端。
 */
const NETEASE_SPECIAL_ROUTES = {
  'daily_signin.js': '/daily_signin',
  'fm_trash.js': '/fm_trash',
  'personal_fm.js': '/personal_fm',
}

async function start() {
  // 检测是否存在 anonymous_token 文件，没有则生成
  if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {
    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')
  }

  // 启动时更新 anonymous_token
  const generateConfig = require('./generateConfig')
  await generateConfig()

  /**
   * 响应缓存策略
   *
   * 上游 apicache 的缓存键是 `hostname + url + cookies`，
   * **不含 method 与请求体**。平台写接口（建歌单、加歌、收藏等）都是 POST，
   * 同一 URL 下两次不同的写操作会命中同一条缓存——第二次会被直接返回上一次的
   * 响应，真正的写入根本没有发生。
   *
   * 因此默认关闭响应缓存。若确实需要保留（只跑网易云读接口的自建场景），
   * 设 `KEEP_RESPONSE_CACHE=true`，并让写操作请求带上 `x-apicache-bypass: 1`
   * 头——上游 apicache 支持该头逐请求旁路。
   */
  if (process.env.KEEP_RESPONSE_CACHE !== 'true') {
    require('./util/apicache').options({ enabled: false })
  }

  const { serveNcmApi, getModulesDefinitions } = require('./server')
  const { allPlatformModuleDefs } = require('./platforms')

  const neteaseDefs = await getModulesDefinitions(
    path.join(__dirname, 'module'),
    NETEASE_SPECIAL_ROUTES,
  )
  const platformDefs = allPlatformModuleDefs()

  await serveNcmApi({
    checkVersion: true,
    moduleDefs: [...neteaseDefs, ...platformDefs],
  })

  console.log(
    `已挂载 ${neteaseDefs.length} 个网易云接口与 ${platformDefs.length} 个平台接口`,
  )
}

start()
