# 三端架构与启动方式

KingSDK 工作台是一套「**1 个后端 + 1 份前端 + 2 个宿主形态**」的架构：所有业务能力
都在后端（`@kingsdk/server` 的 HTTP API），前端（`@kingsdk/web`）纯 fetch 相对路径；
Electron 与 Web 两个形态共享同一份 server 代码与同一份前端，区别只在**谁启动 server**
和 **运行形态 mode**。

```
                    @kingsdk/core / shared        纯分析引擎 + 类型
                            ↓
                    @kingsdk/server               唯一后端：analyze/compare/devops/AI/wework/upload
                    （mode: desktop | web）         + 静态托管 @kingsdk/web 构建产物
                    ↑                    ↑
        ┌───────────┘                    └───────────┐
   @kingsdk/electron                            远程部署
   本机 spawn server 子进程                      独立跑 server 进程
   mode=desktop（全功能）                        mode=web（屏蔽本机文件系统）
        ↑                                            ↑
        └────────── 同一份前端 @kingsdk/web ─────────┘
```

## 运行形态 mode

| mode | 用于 | 本地文件分析 | 目录浏览 / 配置本地工程 / 打开缓存目录 |
|------|------|-------------|----------------------------------|
| `desktop` | Electron、本机 CLI | 上传 或（同机）零拷贝 | ✅ 开放 |
| `web` | 远程部署 | **仅上传**（本地路径 403） | ❌ 全部 403（不暴露/不写服务器磁盘） |

分析/对比的「本地文件」统一走**上传**（`POST /api/uploads` 流式落盘 → analyze/compare
引用 uploadId），两形态同一套流。

## 构建

```bash
npm install          # 建立 workspace 链
npm run build        # tsup(cli/server/electron/viewer) + viewer 模板 + web(Vite) + 收拢 dist/web
```

产物：
- `dist/cli/index.cjs` —— CLI 可执行 bundle
- `dist/server/main.cjs` —— server 独立入口（Electron / web 共用）
- `dist/electron/{main,preload}.cjs` —— Electron 主进程 / preload
- `dist/web/` —— 前端 Vite 静态产物（server 静态托管）
- `packages/viewer/templates/` —— 单文件 HTML 报告模板

## 三端启动

### 1. 后端 server（独立进程）
```bash
# web 形态（远程部署，绑所有网卡）
npm run server:web
#   = node dist/server/main.cjs --mode web --host 0.0.0.0 --port 7790

# desktop 形态（本机）
node dist/server/main.cjs --mode desktop --port 7790
```
就绪后 stdout 打印 `KINGSDK_SERVER_READY <url>`。

### 2. Web 端
- **开发**（热更新 + 代理到后端）：
  ```bash
  npm run server            # 先起后端(7790)
  npm run -w @kingsdk/web dev   # Vite dev server(5273)，/api、/jobs 代理到 7790
  ```
- **生产**：`npm run build` 后由 server 直接静态托管 `dist/web`（`SDKTOOL_STATIC_DIR` 指向它）。
- **Docker**：见根目录 `Dockerfile`。
  ```bash
  npm run build
  docker build -t kingsdk-web .
  docker run -p 7790:7790 -v $PWD/pipelines.config.json:/app/pipelines.config.json:ro kingsdk-web
  ```

### 3. Electron 端（桌面，完整功能）
```bash
npm run electron          # build 后启动；主进程 spawn 本机 server 子进程(desktop) 再开窗
npm run electron:nobuild  # 已 build 过，直接启动
```
打安装包（需在对应平台的真实构建机上跑）：
```bash
npm run dist:electron     # electron-builder → release/
```

## 配置

`pipelines.config.json`（蓝盾流水线 / AI / 企业微信凭据）定位优先级：
环境变量 `SDKTOOL_PIPELINES_CONFIG` > 进程 cwd 下的 `pipelines.config.json`。
Electron 打包后 cwd 不可靠，主进程会把该环境变量指向 `userData/pipelines.config.json`。

其它环境变量：
- `SDKTOOL_STATIC_DIR` —— 前端静态资源目录（缺省则回退 server 内联 page.ts 渲染）
- `SDKTOOL_DEVOPS_ONLY=1` —— 等价 `mode=web`（兼容旧部署脚本）
