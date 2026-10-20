# 文档总览

> 本目录是 `xiaoxiongmusic-api`（`NeteaseCloudMusicApiEnhanced/api-enhanced` 的 fork）的改造文档集。

## 目录结构

```
docs/
├── docs.md                          ← 本文件，文档总览
└── PLATFORM-EXTENSION-DESIGN.md     ← 三平台接口层改造方案（设计依据）
```

## 文档清单

| 文档 | 说明 |
|---|---|
| `docs/PLATFORM-EXTENSION-DESIGN.md` | 把网易云 API 库升级为小熊音乐三平台（网易云 / QQ 音乐 / 酷狗）接口层的完整方案：与上游的关系、目录结构、**平台层契约**（所有实现者的唯一依据）、必须避开的坑、分阶段实施、验收标准 |

## 相关资料（在「小熊音乐」工作区，不在本仓库）

| 资料 | 位置 | 说明 |
|---|---|---|
| 酷狗云歌单写协议规格 | `xiaoxiongmusic/docs/ops/KUGOU-WRITE-PROTOCOL.md` | 酷狗三套写协议（网关签名 / 云歌单 `key`+`p` 双因子 / 老协议）的精确口径与错误码语义标定表 |
| 3.x 三平台模块结构地图 | `xiaoxiongmusic/docs/ops/PLATFORM-MODULE-MAP.md` | 桌面端侧的平台能力代码地图 |
| 网易云后端来源调查 | `xiaoxiongmusic/docs/ops/NETEASE-BACKEND-PROVENANCE.md` | 网易云后端来源、两端版本差异、适配层分叉现状 |
| 上游扩展机制勘察 | `xiaoxiongmusic/.apiadv/API-ENHANCED-EXTENSION-MAP.md` | 上游 `main.js` / `server.js` 的模块加载与导出机制实证 |
| 服务端仓库勘察 | `xiaoxiongmusic/.srvscan/SERVER-REPO-MAP.md` | `xiaoxiongmusic-server` 的目录职责、账号体系、可搬迁性分析 |

## 约定

- 本目录文档**只做本地维护**，不进入版本控制的发布流程。
- 上游原始文档在 `public/docs/home.md`（docsify 站点），**不在本目录**，不要重复。
