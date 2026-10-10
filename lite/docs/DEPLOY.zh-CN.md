# 从 GitHub fork 到自己的手机电台

推荐路线：**GitHub fork 原仓库 → 应用随包 patch → Vercel 导入 GitHub → 手机打开**。

你收到的是本地完成的 fork 代码与 Git 补丁；尚未在你的 GitHub 或托管账户创建资源。

## 1. fork 到 GitHub

1. 登录 GitHub，打开 https://github.com/baudmusic/radikall 。
2. 点击 **Fork**，Owner 选自己，仓库名可以保留 `radikall`。
3. 在电脑上安装 Git 与 Node.js 24。将交付 ZIP 解压，找到 `radikall-lite.patch`。
4. 执行以下命令，把 `<你的用户名>` 与 patch 路径换成自己的：

```bash
git clone https://github.com/<你的用户名>/radikall.git
cd radikall
git am /完整路径/radikall-lite.patch
git push origin HEAD
```

如果 Git 提示未配置身份，在当前仓库设置，再执行 `git am`：

```bash
git config user.name "你的名字"
git config user.email "你的 GitHub 提交邮箱"
```

Windows 的 patch 路径示例：`git am "C:/Users/你的用户/Downloads/radikall-lite/radikall-lite.patch"`。

该 patch 只添加 `lite/` 与 `.github/workflows/lite.yml`，保留原项目文件与历史。应用失败时先运行 `git am --abort`，然后用下面的复制路线。

### 不使用 patch 的替代方法

把 ZIP 中整个 `lite/` 目录复制到你的 fork 根目录，把 `github-workflow/lite.yml` 复制到 fork 的 `.github/workflows/lite.yml`，然后：

```bash
git add lite .github/workflows/lite.yml
git commit -m "Add portable TypeScript radio web app"
git push
```

第一次 fork 若 GitHub Actions 被禁用，进入仓库 Actions 页面按需启用。部署本身不依赖 Actions；Actions 用于类型检查和测试。

如果完全不需要 fork 关系，也可以新建空 GitHub 仓库，把 `lite/` **里面的文件**放到仓库根目录；这种情况下所有 Host 的 Root Directory 使用根目录，不填 `lite`。

## 2. 推荐：Vercel GitHub 路线

1. Vercel → **Add New → Project**，连接 GitHub，导入刚才的 fork。
2. **Root Directory：`lite`**。这是关键；否则平台会尝试构建原 Kotlin 项目。
3. Framework Preset 选择 **Other**。Node.js 选择 **24.x**。
4. 配置文件会提供：Build Command `npm run build`，Output Directory `public`。
5. 在本地 `lite/` 执行 `npm run keygen`。复制生成的随机串。
6. 添加环境变量 `RADIKALL_SESSION_SECRET`，值填写这个随机串；用于 Production（需要预览部署时也添加 Preview）。
7. 点击 Deploy。后续 push 到绑定分支会自动触发重新部署。
8. 打开 `https://你的域名/api/health`，应看到 `status: "ok"` 和 `configured: true`。
9. 打开首页，选择电台并播放。用 Safari 测试后再添加到主屏幕。

`api/index.ts` 是 Vercel Function；`vercel.json` 将 `/api/*` 转发到它。它使用标准 Web Request/Response，不需要 Next.js。

## 3. Railway

1. New Project → Deploy from GitHub repo，选择 fork。
2. Settings → Root Directory 填 `/lite`。
3. 环境变量添加 `RADIKALL_SESSION_SECRET`。
4. 仓库带有 Dockerfile，可选择 Docker 构建；普通 Node 构建也可用：Build `npm run build`，Start `npm start`，Node 24.x。
5. Networking → Generate Domain。服务监听 `0.0.0.0:$PORT`，无需自己写死端口。
6. 验证 `/api/health` 和真实播放。

## 4. Render

1. New → Web Service → 连接 GitHub 仓库。
2. Root Directory `lite`。选择 Node runtime（Node 24.x），或 Docker。
3. Node 路线：Build `npm ci && npm run build`，Start `npm start`。
4. 设置 `RADIKALL_SESSION_SECRET`，创建服务。
5. 免费实例会在闲置后休眠，首次打开可能等待。用生成的 HTTPS URL 验证播放。

## 5. Netlify

1. Add new project → Import an existing project → GitHub。
2. Base directory `lite`。Build `npm run build`，Publish `public`，Functions `netlify/functions`。
3. 使用 `lite/netlify.toml`，Node 24。将密钥环境变量的作用域包含 **Functions**，不只设置成 Build-only。
4. 部署并测试 `/api/health`。函数通过 `config.path` 映射 `/api/*`。
5. 音频是逐个 HLS 分片转发；检查套餐的流量、函数时长与响应大小限制。

## 6. Cloudflare Workers

GitHub 集成：导入 fork，Root Directory `lite`，Build `npm run build`，Deploy `npx wrangler deploy`。Node 24。Worker 名称来自 `wrangler.jsonc`，可改成自己的。

也可以首次在本地执行：

```bash
cd lite
npx wrangler login
npx wrangler secret put RADIKALL_SESSION_SECRET
npx wrangler deploy
```

在平台控制台配置同名 secret 后，后续由 GitHub 自动部署即可。原生静态资源绑定负责网页，只有 API 和 health 路径运行 Worker。

## 7. Docker / VPS

在 `lite/`：

```bash
docker build -t radikall-lite .
docker run --rm --env-file .env -p 3000:3000 radikall-lite
```

对外使用 HTTPS，可由已有 Caddy、Nginx 或托管平台终止 TLS。不要把 `.env` 放进镜像；`.dockerignore` 已排除它。

## 8. 第一次上线的检查顺序

1. `/api/health` 的 `configured` 为 true。
2. `/api/bootstrap` 返回 JSON 电台列表。
3. 首页正常显示，切换主题并刷新后保持。
4. 搜索一个电台、收藏、切换地区；收藏页应显示全部已收藏电台。
5. iPhone Safari 点击播放。如果提示“再点一下播放”，再点一次。
6. 验证暂停、快速切台、锁屏再解锁、网络切换后的重新播放。
7. 持续播放超过 55 分钟，检查会话续期；后台续期可能受系统冻结影响。
8. 到 Host 面板查看真实请求量与传输量，再决定免费套餐是否足够。

### 常见问题

| 现象 | 先检查 |
|---|---|
| 构建原 Android/Kotlin 项目 | Root Directory 必须是 `lite` |
| Unknown file extension `.ts` 或不认识 `stripTypeScriptTypes` | Node 必须为 24.x |
| `configured: false` | 密钥缺失、长度不足 32，或未应用到当前部署环境；修改后重新部署 |
| 首页正常、API 404 | 确认部署的是完整项目，保留平台配置和对应适配器；不是只上传 `public/` |
| API 返回 HTML | 可能是 Host 登录保护、额度错误页或路由配置错误；前端会显示简短错误 |
| 有节目但无法播放 | 检查 `/api/playback/live-session` 的 JSON 状态、部署区域和上游可用性 |
| 桌面 Chrome 无法播放 | 检查 `/vendor/hls.min.js` 是否能加载；Safari 通常不需要它 |
| 长时间锁屏后停止 | 系统可能冻结了续期计时器；解锁后重新播放 |

## 官方文档

- https://vercel.com/docs/functions/runtimes/node-js
- https://vercel.com/docs/plans/hobby
- https://docs.netlify.com/build/functions/api/
- https://docs.railway.com/guides/monorepo
- https://render.com/docs/web-services
- https://developers.cloudflare.com/workers/static-assets/

平台界面和套餐会变化；本教程提供的是代码需要的配置值。套餐额度以部署时控制台为准。
