# Radikall Lite

移动端优先的个人日本电台。原生网页、深色/浅色/系统主题、收藏、地区筛选、节目标题、底部播放器、睡眠定时与 Media Session 锁屏控制。

这是 [baudmusic/radikall](https://github.com/baudmusic/radikall) 的轻量衍生版本。保留电台协议实现，把平台入口与 UI 分离；不依赖作者的公共 Worker。

## 技术栈

- 前端：原生 HTML、分层 CSS、严格 TypeScript、ES modules。没有 UI 框架。
- 后端：TypeScript + 标准 Web `Request` / `Response` / `ReadableStream` / Web Crypto。
- Node.js **24.x** 原生执行可擦除类型的 TypeScript；不使用 ts-node、tsx 或后端 bundler。
- 构建：Node 自带 `stripTypeScriptTypes` 生成浏览器 JavaScript。该 Node API 仍标记 experimental；固定 Node 24.x，并保留构建检查。
- Safari 原生 HLS；不支持原生 HLS 的浏览器才加载本地 vendored **hls.js 1.6.13**。
- 无数据库、无 React、无 Vite、无 Next.js、无服务器运行时 npm 依赖。TypeScript、Node 类型包和 happy-dom 只用于开发检查与测试。

## 本地启动

```bash
# 在 lite/ 或解压后的同名项目目录执行；先安装 Node.js 24
npm ci
cp .env.example .env
npm run keygen
# 将上一条命令生成的随机字符串填入 .env 的 RADIKALL_SESSION_SECRET
npm run build
npm start
```

浏览器打开 `http://localhost:3000`。Windows PowerShell 用 `Copy-Item .env.example .env` 代替 `cp`。密钥只放 `.env` 或托管平台的环境变量，不提交 Git。

`npm run dev` 会构建前端并监视后端。修改 `src/app.ts` 后再次运行 `npm run build` 并刷新页面；这里刻意没有 HMR 开发服务器。

类型检查使用 [TypeScript 7](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) 的 Go 原生编译器，当前锁定 `7.0.2`，仍通过 `npm run check` / `tsc --noEmit` 执行。`npm ci` 自动安装当前平台的编译器，无需安装 Go。前端仍由 Node 去除类型；编译器不会下载到浏览器。`tsconfig.json` 显式启用 Node 类型，以适配新版编译器。

## 部署

完整步骤见 [docs/DEPLOY.zh-CN.md](docs/DEPLOY.zh-CN.md)。所有平台设置同一个环境变量：

```text
RADIKALL_SESSION_SECRET=<至少 32 字符的随机字符串，推荐 npm run keygen>
```

| Host | 入口 / 配置 | GitHub 导入设置 |
|---|---|---|
| Vercel | `api/index.ts` + `vercel.json` | Root Directory `lite`，Framework Other，Node 24.x |
| Netlify | `netlify/functions/radio.ts` + `netlify.toml` | Base directory `lite`，Build `npm run build`，Publish `public` |
| Railway | 普通 Node 或 Docker | Root directory `/lite`，Build `npm run build`，Start `npm start` |
| Render | 普通 Node 或 Docker | Root `lite`，Build `npm ci && npm run build`，Start `npm start`，Node 24.x |
| Cloudflare Workers | `adapters/cloudflare.ts` + `wrangler.jsonc` | Root `lite`，Build `npm run build`，Deploy `npx wrangler deploy` |
| VPS / Docker | `adapters/node.ts` / `Dockerfile` | 转发到环境变量 `PORT` 指定的端口；默认 3000 |

如果把轻量目录单独上传成一个新仓库，Root Directory 改成仓库根目录。GitHub Pages 只能托管静态页面，无法运行这里的鉴权和音频代理，不支持单独部署完整应用。

## 工程结构

```text
src/app.ts                 类型化前端状态、播放生命周期、交互
public/                    HTML / CSS / 图标 / hls.js
lib/app.ts                 可移植路由与音频代理
lib/auth.ts                上游鉴权
lib/crypto.ts              AES-GCM 无状态播放会话
lib/program.ts             节目元数据
lib/network.ts             上游白名单、重定向校验、请求超时
lib/catalog.json           从上游带入的电台/地区静态数据
adapters/node.ts           常驻 Node 服务器与静态资源
adapters/cloudflare.ts     Worker 适配器
api/index.ts               Vercel 适配器
netlify/functions/radio.ts Netlify 适配器
```

## 修改 UI

- 颜色与布局：`public/styles.css` 的 CSS custom properties、`@layer` 和 media queries。
- HTML 结构与文案：`public/index.html`。
- 交互：`src/app.ts`。使用 discriminated union 表示播放状态；`AbortController` 和 generation counter 防止快速切台的异步竞态。
- 服务端：`lib/app.ts` 的 `createHandler()` 可注入上游依赖，测试无需真实播放。
- 新增 Host：把平台请求转成标准 `Request`，调用 `handle(request, settings)`，把 `Response` 流式返回。

## 使用边界

- iPhone：Safari 打开 → 分享 → 添加到主屏幕。首次播放必须点击；某些 Safari 情况需要获取会话后再点一次播放，页面会提示。
- 没有 Service Worker，不缓存音频，也不提供离线收听。manifest 提供主屏幕入口；浏览器是否显示安装提示由平台决定。
- 收藏、主题、上次选择保存在本机 localStorage，不跨设备同步。
- 会话约 55 分钟有效，前端在过期前 5 分钟更新，可能短暂重新缓冲。系统在后台冻结 JS 时，续期和睡眠定时可能延迟；回到前台会检查。不要依赖它保证整夜锁屏不断流或精确定时停止。
- 停止播放会销毁 hls.js 并释放音频源，避免暂停后继续下载分片。
- 节目数据失败不会阻止创建播放会话；前端不会展示上游 HTML 错误页面。
- 音频分片仍经自己的后端代理，计入 Host 请求量和流量。轻量 UI 不会消除这些用量。
- 默认实例没有用户登录，任何知道网址的人都可调用播放接口。只供自己用时可启用 Host 自带的访问保护，并验证原生音频请求是否仍然可用。
- 电台目录来自上游快照，可能需要随上游更新；播放依赖电台当前的接口与部署区域。代码中保留上游鉴权行为。

## 验证

```bash
npm run check
npm run build
npm test
# 可选：需要网络和有效密钥，会真实访问电台，不在 CI 中执行
node --env-file=.env scripts/smoke-live.ts
```

当前验证结果见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。适配器测试通过不代表已经在你的托管账户部署；完成部署后请按教程测试真实 URL。

## 来源与许可

源自上游 commit `a07abfca433a6800ef20b211c6562e84fb299aee`。`auth.ts`、`crypto.ts`、`stream.ts`、`program.ts`、类型和目录数据基于上游改编。保留 [LICENSE](LICENSE) 与 [UPSTREAM-DISCLAIMER.md](UPSTREAM-DISCLAIMER.md)。上游 LICENSE 是 MIT，免责声明另外写明个人/非商业用途；这里保留二者的原文，按个人自用交付。

本目录新增的代码同样采用 MIT；电台内容和标志不属于代码许可证。hls.js 的 Apache-2.0 许可位于 `public/vendor/hls.LICENSE`。本项目与 Radiko 或各广播公司没有隶属关系。
