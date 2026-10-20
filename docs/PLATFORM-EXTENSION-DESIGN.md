# 三平台接口层改造方案

- **仓库**：`MissKisser/xiaoxiongmusic-api`（GitHub，公开）
- **上游**：`NeteaseCloudMusicApiEnhanced/api-enhanced`（MIT，作者 MoeFurina）
- **定位**：把网易云 API 库升级为**小熊音乐三平台（网易云 / QQ 音乐 / 酷狗）的独立接口层**，服务层仍由 `xiaoxiongmusic-server` 承担
- **状态**：设计已定，改造待实施

---

## 一、为什么要做这件事

现状是三平台能力**散在两处**：

| 平台 | 接口实现在哪 | 问题 |
|---|---|---|
| 网易云 | 后端 `xiaoxiongmusic-server` 依赖 npm 包 `@neteasecloudmusicapienhanced/api` | 协议跟着上游漂移，两端版本已分叉（4.40.1 / 4.38.0） |
| QQ 音乐 | 桌面端 `electron/main/apis/qqmusic/` | 协议实现在 Electron 主进程，**每个客户端都要实现一遍**；安卓端、Web 端无法复用 |
| 酷狗 | 桌面端 `electron/main/apis/kugou/` | 同上 |

目标形态是**接口层统一、服务层独立**：

```
xiaoxiongmusic-api（公开，本仓库）        xiaoxiongmusic-server（私有，服务层）
├─ 网易云 439 个接口（上游主体）          ├─ Fastify 路由 /api/{netease,qqmusic,kugou}/*
│  └─ util/ 签名与加密                    ├─ 账号体系：JWT + MySQL 授权码
├─ platforms/qqmusic/  ★新增             ├─ 限流 / SSRF 音频代理 / 多源解锁
├─ platforms/kugou/   ★新增             ├─ 凭据托管：用户 → 平台凭据
└─ platforms.js      ★第二组导出         └─ 部署：Docker / nginx / PM2
```

好处：协议只实现一次，多端共享；接口层无状态（凭据由参数传入），天然杜绝串号；上游网易云更新仍可继续跟。

---

## 二、与上游的关系

| 事项 | 决定 |
|---|---|
| 许可证 | 保留上游 `LICENSE`（MIT 全文，`Copyright (c) 2013-2022 Binaryify`）**原文不动** |
| 署名 | README 顶部标注派生关系与原作者；`package.json` 的 `author` 保留上游 `MoeFurina` 并补充说明 |
| 归属义务 | MIT 只要求「在所有副本或实质性部分中保留版权与许可声明」——保留 `LICENSE` 即满足 |
| 上游同步 | 配置 `upstream` remote，定期 `git fetch upstream && git merge upstream/main`。**改造必须做到与上游零文件重叠**（见第四节） |
| 自动化发布 | **必须停用** `.github/workflows/release-on-version-change.yml`：该 workflow 按 `package.json` 的 `version` 变化自动打 tag、发 Release、推 Docker、**publish 到 npm**。fork 改版本号会误发到 npm 上游包名 |

> **注意**：GitHub fork API 创建的 fork 可能落后上游较远（本仓库初建时落后 9 个月）。**开工第一步必须把 fork 同步到上游最新**，否则会在缺少 neapi 加密通道与新接口的旧基线上开发。

---

## 三、目录结构与新增物

```
xiaoxiongmusic-api/
├─ module/            上游 439 个网易云接口 —— 原样不动
├─ util/              上游签名与加密 —— 原样不动
├─ plugins/ data/ public/  上游 —— 原样不动
├─ main.js            上游库入口 —— 原样不动
├─ server.js          上游 Express 工厂 —— 原样不动
├─ app.js index.js index.mjs generateConfig.js interface.d.ts —— 原样不动
│
├─ platforms/                    ★ 新增：平台扩展层
│  ├─ index.js                   平台注册表 + moduleDefs 生成
│  ├─ shared/
│  │  ├─ logger.js               薄封装上游 util/logger.js
│  │  ├─ cookie.js               各平台自己的 cookie 解析
│  │  ├─ response.js             统一响应形状 {status, body, cookie}
│  │  └─ no-cache.js             写接口的免缓存标记
│  ├─ qqmusic/
│  │  ├─ index.js
│  │  ├─ config.json             域名与常量
│  │  ├─ crypto.js               QQ 签名/加密
│  │  ├─ request.js              QQ 自有 HTTP 层
│  │  ├─ session.js              uin / skey / cookies 生命周期
│  │  └─ modules/*.js            业务模块
│  └─ kugou/
│     ├─ index.js
│     ├─ config.json
│     ├─ crypto.js               酷狗签名体系
│     ├─ request.js              酷狗自有 HTTP 层
│     ├─ session.js
│     └─ modules/*.js
│
├─ platforms.js                   ★ 第二组导出入口：{ qqmusic, kugou }
├─ docs/                          ★ 改造说明（本目录）
└─ README.MD                      ★ 改写：派生声明 + 三平台说明
```

---

## 四、关键设计决策

### 决策 1：平台代码放独立目录，**不塞进 `module/`**

上游 `main.js` 运行时 `fs.readdirSync` 扫描 `module/`，导出键名 ≡ 文件名，URL 路径由 `_` → `/` 机械推导。塞进去有四个问题：

1. `util/request.js` 写死了网易域名、密钥、`/api/` 前缀剥离、eapi/weapi/xeapi 三套加密。QQ / 酷狗的 URI 形态与签名体系完全不同，塞进去必须改核心文件或破坏 `module.exports = (query, request)` 的统一契约。
2. `module/` 是上游的活跃目录（近月新增 10+ 接口），新增几十个文件会让每次 `git merge upstream` 变成大面积冲突。独立目录与上游**零文件重叠**。
3. `main.js` 是**单层平铺导出**，加几十个平铺键会污染命名空间。
4. `module/` 的路由由文件名机械推导，无法批量加平台前缀。

### 决策 2：通过 `serveNcmApi({ moduleDefs })` 注入路由，**不改 `main.js` / `server.js`**

上游的 `getModulesDefinitions(modulesPath, specificRoute, doRequire)` 与 `serveNcmApi({ moduleDefs })` **已经参数化**，天然支持第二个目录。调用侧把两边的 defs 合并传入即可：

```js
const neteaseDefs = await getModulesDefinitions(path.join(__dirname, 'module'));
const platformDefs = await loadPlatformModuleDefs();
await serveNcmApi({ checkVersion: true, moduleDefs: [...neteaseDefs, ...platformDefs] });
```

平台模块**忽略 server 注入的 `request` 参数**，自行 `require` 平台自己的 HTTP 层——这是做到「上游三个核心文件一行不改」的关键。

> 限制：`constructServer` 未导出，只能走 `moduleDefs` 合并路线，不能单独复用构造器。

**实际部署路径比这更简单**：服务层 `xiaoxiongmusic-server` 本来就**没有使用上游的 express server**——它自己用 fastify 实现路由与鉴权，只是 require npm 包的**模块函数**（靠 `pathCase(键名)` 匹配）。所以：

- 服务层只需 `require('xiaoxiongmusic-api')` 拿网易云模块 + `require('xiaoxiongmusic-api/platforms')` 拿 QQ / 酷狗模块
- 路由分三组：`/api/netease/*`、`/api/qqmusic/*`、`/api/kugou/*`
- **上游的 `app.js` / `server.js` / `main.js` 一行都不用改**，fork 也不必自带 HTTP 服务

本 fork 仍然提供 `platforms/index.js` 的 `allPlatformModuleDefs()`，供需要用上游 express server 的场景（如独立自建部署）使用。

### 决策 3：第二组导出用独立入口 `platforms.js`，**不动 `main.js`**

`package.json` 没有 `exports` 字段，只有 `main` + `types`。新增子路径入口有两种做法：

- 加 `exports` 映射 —— **会改变现有深层导入的解析方式，有破坏性** ❌
- 把 `platforms.js` 与 `platforms/` 加进 `files` 数组 —— **无破坏性** ✅

调用方：`require('xiaoxiongmusic-api/platforms').qqmusic.playlist_detail({...})`

### 决策 4：接口层**无状态**，凭据由参数传入

这是整个改造最重要的一条。接口层**不存任何会话、不做任何跨请求缓存**：

- 3.x 现状里 `qqmusic/core/request.ts` 的 session 是**模块级单例**、缓存 key 是 `name|md5(params)` **不含账号** → 一旦搬到后端就是**静默串号**
- 凭据托管交给服务层：服务层按用户查凭据 → 注入调用参数
- 接口层对「同一账号」不做任何隐式状态

### 决策 5：扫码登录放后端

三平台的登录 key 都是自包含的（QQ = `qrsig` 值、微信 = `uuid`、酷狗 = `qrcode` 串），登录全程可在单次请求内完成。放后端可让多端共享同一份登录流程。

### 决策 6：酷狗「概念版」开关上移为后端配置

3.x 现在把它放在 `electron-store`（`system.kugouLoginVersion`）。但酷狗 cloudlist 读写**只在概念版集群可用**（正式版返回 20017 / 502）——开关必须跟着协议走，不能留在客户端。接口层用环境变量承载：

```
KUGOU_LOGIN_VERSION=concept|standard   # 默认 concept
```

### 决策 7：写接口禁用上游的 2 分钟全局缓存

上游 `server.js:265` 的 `cache('2 minutes', ...)` 对**所有**请求生效，平台写接口也会被缓存——「建歌单」被缓存 2 分钟是灾难。平台模块需带免缓存标记。

### 决策 8：平台自己解析 cookie

上游 `server.js:289-292` 会把 `query.cookie` / `body.cookie` 字符串按**网易格式** `cookieToJson` 解析。QQ / 酷狗的 cookie 字段语义不同，平台模块需在自己的边界内重新解析，不依赖上游的解析结果。

---

## 四之二、平台层契约（实现依据）

> 以下签名是**所有实现者的唯一依据**。各子任务只改自己负责的目录，接口以本节为准。

### 通用约定

| 约定 | 内容 |
|---|---|
| 语言 | **纯 JavaScript**（CommonJS，`require`），与上游一致，不引入构建步骤 |
| 风格 | prettier：`semi: false`、单引号、`trailingComma: all`、2 空格缩进 |
| 注释 | JSDoc 风格，说明功能/入参/返回值；**不得出现日期、版本号、TODO** |
| 命名 | 模块文件名一律纯小写下划线（不能含连字符，否则进不了 TS 声明） |
| 响应形状 | 统一 `{ status, body, cookie }`，`status` 为 HTTP 状态码 |
| 响应助手 | 用 `platforms/shared/response.js` 的 `success` / `failure` / `unauthorized` / `badRequest` / `upstreamError` |
| cookie | 用 `platforms/shared/cookie.js` 的 `parseCookie` / `stringifyCookie`，**不依赖上游的网易格式解析** |

### 平台模块签名

```
platforms/<platform>/modules/<name>.js

module.exports = async (query) => {
  // query: { ...业务参数, cookie: Record<string,string> }
  return { status, body, cookie }
}
```

- 平台模块**只接受一个参数** `query`，**忽略上游 server.js 注入的第二个 `request` 参数**（那是网易专用）。
- `query.cookie` 在到达模块前已由 `platforms/index.js` 解析成对象；模块内部若需原始字符串，用 `stringifyCookie(query.cookie)` 自行拼。

### 平台 core 契约

```
platforms/<platform>/core/session.js

/**
 * 读取平台会话凭据
 * @param {any} query 调用参数
 * @returns {PlatformSession | null} 无凭据时返回 null
 */
readSession(query) → { token, userid, ... } | null
```

凭据读取优先级（**接口层不存任何状态**，全部来自调用参数）：

1. `query.session` —— 服务层注入的凭据对象（推荐路径）
2. `query.cookie` 里的平台字段
3. `query.token` / `query.userid` 等散字段

```
platforms/kugou/core/request.js

/**
 * 协议 A：网关 Android 签名（明文 JSON body）
 * @param {string} path 网关相对路径
 * @param {Record<string, any>} body 业务请求体
 * @param {Record<string, any>} [options] { params, headers, timeoutMs }
 * @returns {Promise<any>} 网关响应体
 */
kgGatewayRequest(path, body, options) → Promise<any>

/**
 * 协议 B：云歌单新协议（key + p 双因子，AES-128-CBC body）
 * @param {string} path 网关相对路径
 * @param {Record<string, any>} body 业务请求体
 * @returns {Promise<any>} 解密后的响应体
 */
kgCloudRequest(path, body) → Promise<any>
```

```
platforms/qqmusic/core/request.js

/**
 * 发送 QQ 音乐接口请求
 * @param {string} module 接口模块名，如 music.musicasset.PlaylistBaseRead
 * @param {string} method 接口方法名，如 GetPlaylistByUin
 * @param {Record<string, any>} param 业务参数
 * @param {Record<string, any>} [options] { session, referer, timeoutMs }
 * @returns {Promise<any>} 接口返回的业务数据段
 */
qmRequest(module, method, param, options) → Promise<any>
```

`options.session` 形如 `{ uin, cookies }`。**未传 `options.session` 时不得回退到任何模块级状态**，
应直接抛出「未登录」错误。凭据的读取统一走 `core/session.js` 的 `readSession(query)`。

### 路由

| 平台 | 前缀 | 示例 |
|---|---|---|
| QQ 音乐 | `/qqmusic` | `/qqmusic/playlist/create` |
| 酷狗 | `/kugou` | `/kugou/playlist/create` |

由 `platforms/index.js` 的 `routeOf()` 统一推导（规则同上游：文件名 `_` → `/`，再拼平台前缀）。
**必须与网易云侧 439 条路由无碰撞**（网易云没有 `/qqmusic/*` 与 `/kugou/*` 前缀，天然不冲突，但要用断言验证）。

### 平台清单

| 平台 | 模块 | 读写 | 来源 |
|---|---|---|---|
| 酷狗 | `login_qr_key` / `login_qr_check` | 登录 | 3.x `kugou/modules/login_qr.ts` |
| 酷狗 | `user_detail` | 读 | 3.x `kugou/modules/user_detail.ts` |
| 酷狗 | `user_playlist_list` | 读 | 3.x `kugou/modules/user_playlist.ts` |
| 酷狗 | `playlist_detail` | 读 | 同上 |
| 酷狗 | `user_profile` | 读 | 同上 |
| 酷狗 | `playlist_create` | 写 | 3.x `kugou/modules/playlist_write.ts` |
| 酷狗 | `playlist_rename` | 写 | 同上 |
| 酷狗 | `playlist_delete` | 写 | 同上 |
| 酷狗 | `playlist_tracks` | 写 | 同上 |
| 酷狗 | `playlist_subscribe` | 写 | 同上 |
| QQ 音乐 | `login_qr_key` / `login_qr_check` | 登录 | 3.x `qqmusic/modules/login_qr.ts` |
| QQ 音乐 | `user_detail` | 读 | 3.x `qqmusic/modules/user_detail.ts` |
| QQ 音乐 | `user_playlist_list` | 读 | 3.x `qqmusic/modules/user_playlist.ts` |
| QQ 音乐 | `user_liked_songs` | 读 | 同上 |
| QQ 音乐 | `playlist_detail` | 读 | 同上 |
| QQ 音乐 | `song_detail` | 读 | 同上 |
| QQ 音乐 | `subscription_status` | 读 | 同上 |
| QQ 音乐 | `playlist_create` | 写 | 3.x `qqmusic/modules/playlist_write.ts` |
| QQ 音乐 | `playlist_rename` | 写 | 同上 |
| QQ 音乐 | `playlist_delete` | 写 | 同上 |
| QQ 音乐 | `playlist_tracks` | 写 | 同上 |
| QQ 音乐 | `playlist_subscribe` | 写 | 同上 |

### 关键改造点（相对 3.x 现状）

| 3.x 现状 | 改造后 | 原因 |
|---|---|---|
| `getSessionCookies('kugou')` 模块级单例 | `readSession(query)` 从参数取 | 接口层无状态，杜绝串号 |
| 2 分钟缓存 key = `name\|md5(params)` | **接口层不做任何缓存** | 缓存放服务层，且 key 必须带账号维度 |
| `system.kugouLoginVersion` 在 electron-store | 环境变量 `KUGOU_LOGIN_VERSION`（默认 `concept`） | 开关必须跟着协议走，客户端管不了 |
| `import { coreLog } from '../../../logger'` | `require('../../shared/logger')` | 去掉 electron-log 依赖 |
| TypeScript 类型标注 | 去掉标注 + 补 JSDoc | 保持纯 JS，免构建 |
| QQ 的 `refresh_key` 一次性 | 刷新逻辑留在服务层独占 | 多端各刷会互相作废 |

---

## 五、必须避开的坑

| # | 坑 | 后果 | 对策 |
|---|---|---|---|
| 1 | `release-on-version-change.yml` 未停用 | 改 `package.json` 版本号 → 自动 publish 到 npm | fork 后**第一件事**停用该 workflow |
| 2 | fork 落后上游 | 在旧基线上开发，缺 neapi 与新接口 | 开工前同步到 upstream/main |
| 3 | 平台代码塞进 `module/` | 每次合上游大面积冲突 + 破坏统一契约 | 独立目录 |
| 4 | 加 `exports` 字段 | 破坏现有深层导入 | 只加 `files` |
| 5 | 缓存 key 不含账号 | **静默串号** | 接口层无状态，缓存在服务层且带账号维度 |
| 6 | 平台写接口被上游 2 分钟全局缓存命中 | **写操作不生效** | 缓存键是 `hostname + url + cookies`，**不含 method 与请求体**——同一 URL 下两次不同的写操作会撞同一条缓存，第二个歌单根本不会被创建。`app-multi.js` 默认关闭响应缓存；确需保留时设 `KEEP_RESPONSE_CACHE=true` 并让写请求带 `x-apicache-bypass: 1` 头（上游 apicache 支持该头逐请求旁路）。**真实部署路径（服务层自建 fastify）没有这层缓存，不受影响** |
| 7 | 平台 cookie 走网易格式解析 | 解析错误 | 平台内部自行解析 |
| 8 | `pkg.assets` 未含 `platforms` | 打包二进制时平台模块丢失 | `package.json` 的 `pkg.assets` 补 `platforms` |
| 9 | 模块文件名含连字符 | 无法进 TS 声明（现存 `rep_ugc_user_collect-vip.js` 即如此） | 平台模块一律用纯小写下划线命名 |
| 10 | 沿用上游 `interface.d.ts` 风格手写类型 | 滞后 | 平台类型单独放 `platforms/types.d.ts`，不混进上游文件 |
| 11 | 以为 `ENABLE_FLAC` / `SELECT_MAX_BR` / `FOLLOW_SOURCE_ORDER` 生效 | 配置无效 | 这三个在 api 包与 unblockmusic-utils 中**均无读取点**，属遗留项，别依赖 |
| 12 | 上游 `util/request.js` require 时同步读 `os.tmpdir()/anonymous_token` | 令牌被清空需重启 | 部署侧保证 tmp 不清理 |

---

## 六、分阶段实施

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 | 同步 fork 到 upstream/main；停用发布 workflow；建 `platforms/` 骨架、`platforms.js`、改写 README 与 `package.json` | 可编译的骨架，与上游零重叠 |
| P1 | 酷狗接口层：`core`（协议 A / 协议 B）+ `modules`（读 4 项 + 写 5 项） | 酷狗全能力可从接口层调用 |
| P2 | QQ 音乐接口层：`core`（签名 / 凭据）+ `modules`（读 4 项 + 写 5 项） | QQ 全能力可从接口层调用 |
| P3 | 接入上游服务层：`getModulesDefinitions` 合并 + 免缓存标记 + 平台 cookie 解析 | `serveNcmApi` 同时暴露三平台 |
| P4 | 服务层对接：`xiaoxiongmusic-server` 改为依赖本 fork，凭据托管与鉴权 | 后端成为唯一入口 |
| P5 | 端到端验证 + 文档落档 | 三平台读+写全链路可复现 |

---

## 七、验收标准

1. `node -e "require('./platforms')"` 能加载三平台导出，**上游 439 个模块导出数量不变**（加断言，防静默漏挂）
2. 三平台路由与网易云路由**无路径碰撞**（加断言）
3. 写接口不被上游缓存命中（读回确认写入立即生效）
4. 两个账号并发调用同一写接口，**结果不串号**
5. `git diff upstream/main --stat` 只落在 `platforms/`、`platforms.js`、`docs/`、`README.MD`、`package.json` —— **不得触碰 `module/`、`util/`、`main.js`、`server.js`**
6. 端到端：三平台各跑一遍「建 → 写 → 读回 → 删 → 读回确认」，账号现场零污染

---

## 八、相关文档

- `docs/PLATFORM-EXTENSION-DESIGN.md` —— 本文
- 协议细节见小熊音乐工作区的 `docs/ops/KUGOU-WRITE-PROTOCOL.md`（酷狗三套写协议）与 `docs/ops/PLATFORM-MODULE-MAP.md`（3.x 模块地图）
- 上游扩展机制勘察见小熊音乐工作区的 `.apiadv/API-ENHANCED-EXTENSION-MAP.md`
