# Niconico 站内播放：登录方式与流量评估

核查日期：2026-10-10。本文区分官方公开资料、匿名实测、用户反馈和方案推断。研究没有访问用户浏览器资料、读取真实登录 cookie、登录账号、申请 OAuth 客户端或部署任何服务。

## 目前能够确认什么

用户确认：更改 UA 后成功播放发生在 **Niconico 原站且已登录**。这项证据成立，但包含「原站页面、登录会话、UA」三个条件，不能只把 UA 复制到匿名 iframe 就推断同样成功。

同一视频 `sm36735375` 的匿名对照结果如下；这是本次本地出口的观察，未覆盖已登录请求或所有地区：

| 请求 | 结果 | 可以得出的结论 |
| --- | --- | --- |
| 官方 embed，普通 Chrome UA | 403，地区不可显示 | 与用户截图一致 |
| 官方 embed，`Googlebot/2.1` | 403，提示仅能在 Niconico 观看 | UA 改变了拒绝原因，仍未获得嵌入播放 |
| 官方 watch 页面，`Googlebot/2.1`，匿名 | 400，`HARMFUL_VIDEO`，提示登录 | 原站还要求账号/显示设置，匿名测试没有满足 |

一手请求入口：[官方 embed](https://embed.nicovideo.jp/watch/sm36735375)、[官方 watch 页面](https://www.nicovideo.jp/watch/sm36735375)。官方当前 embed 脚本也明确把 `sensitive_video` 映射为「この動画はニコニコ動画でのみ視聴できます」。这是官方播放器定义的失败状态，不是 Lite 的 HLS 编码错误。[官方播放器脚本](https://assets.embed.res.nimg.jp/js/watch_ja_9a8d0148b1f4e2cf146c.js)

Niconico 官方于 2025-01-31 宣布：从 2025 年 2 月开始逐步调整敏感内容的观看方式，需要账号的相关显示设置开启后才可观看。现行帮助明确说明，该设置需要注册并登录，在 PC 或手机浏览器的账号设置中修改。它解释了为何「原站已登录」与「本站匿名嵌入」不能等同；本次没有验证用户具体的设置值。[官方变更公告](https://blog.nicovideo.jp/niconews/240767.html)、[官方显示设置帮助](https://qa.nicovideo.jp/faq/show/18064?site_domain=default)

## 官方 OAuth 存在，但尚未确认 Lite 能获准接入

匿名读取 [官方 OIDC Discovery](https://oauth.nicovideo.jp/.well-known/openid-configuration) 返回 200 JSON，包含：

| 项目 | 官方公布内容 |
| --- | --- |
| 授权端点 | `https://oauth.nicovideo.jp/oauth2/authorize` |
| token 端点 | `https://oauth.nicovideo.jp/oauth2/token` |
| 用户信息端点 | `https://oauth.nicovideo.jp/open_id/userinfo` |
| grant | `authorization_code`、`client_credentials`、`refresh_token` |
| 身份相关 scope | `openid`、`profile`、`email`、`offline_access` |
| 视频相关 scope | 包括 `user.authorities.videos.play`、`user.authorities.videos.watch` |
| PKCE | 公布 `S256`，也列出 `plain`；方案应选择 `S256` |
| token 端点客户端鉴权 | `client_secret_post`、`client_secret_basic` |

因此不能说「Niconico 没有 OAuth」或「没有视频播放 scope」。但 discovery 描述的是授权服务器能力，**不是给任意第三方的客户端注册许可，也不保证获批 scope 就能播放每种视频**。它没有公布 `registration_endpoint`；该字段本身是可选项，因此缺少字段也不能证明不能申请。[OIDC Discovery 规范](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata)

本次检索官方帮助、官方公告及公开服务端点后，仍未找到可核实的现行公开自助注册流程、个人项目准入条件，以及上述播放 scope 的第三方使用文档。旧的 2014 年官方 SDK 公告描述的是当时的企业注册与视频投稿，观看功能列为计划；它不能证明 2026 年仍适用。[2014 年官方 SDK 公告](https://dwango.co.jp/news/6043514517042570254/)

可实施的 OAuth 方案需要先获得 Lite 自己的客户端注册和允许的 scope，并确认对应视频播放 API/地区/敏感内容规则。若获准，交互可以保持轻量：跳转 Niconico 官方页面登录与授权，返回本站 callback，服务端交换 code；浏览器仅持有本站的 HttpOnly 会话。令牌刷新、注销和撤销也需要设计。当前 discovery 只公布带 client secret 的 token 鉴权方式，不能先假定纯前端 SPA 就足够。没有借用、提取或测试官方应用或其他项目的 client secret。

## 为什么添加「登录」按钮不能自动修复 iframe

打开 Niconico 登录页，会在 Niconico 自己的站点建立会话；Lite 的页面脚本和 Vercel 服务不会因此自动拿到该 cookie。跨源窗口只能进行标准允许的有限交互，不能读取其 DOM 或 cookie。跨源读取需要对方支持的协议，例如 OAuth 回调或明确的消息接口。[HTML 跨源对象规范](https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-objects)

官方 iframe 是否能使用已有登录 cookie，还受 cookie 属性和浏览器第三方存储策略影响。Safari 对第三方 cookie 默认阻止；需要嵌入方自身参与 Storage Access 等机制，本站无法单方面解除。即使 cookie 传递成功，上游的「仅限原站观看」规则仍是另一层限制。因此不能向用户承诺「先登录，再刷新 iframe 就一定能播」。[WebKit 关于第三方 cookie 与嵌入登录的说明](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)

官方 embed 当前代码存在 `hasUserSession` 分支，所以也不能把所有官方 iframe 统称为「永远匿名」。准确表述是：当前集成没有自己的 Niconico 授权链，本次测试使用匿名上下文，受限视频的已登录 embed 行为尚未验证。[官方播放器脚本](https://assets.embed.res.nimg.jp/js/watch_ja_9a8d0148b1f4e2cf146c.js)

## 方案取舍

以下为基于上述证据的工程判断，不代表官方承诺。

| 方案 | 登录在哪发生 / 凭据在哪 | 手机体验 | 流量与维护 | 对当前受限视频的把握 |
| --- | --- | --- | --- | --- |
| 现有官方 iframe | Niconico 自己处理；Lite 不持有账号 | 最轻，官方控件与弹幕 | 视频走 Nico；Lite 仅搜索与静态资源 | 已确认当前匿名 iframe 失败 |
| 官方 OAuth + 自建站内播放器 | 官方登录授权；Lite 服务端保管令牌 | 可做成正常响应式网页，无需扩展 | 需播放 API、会话、弹幕渲染；媒体是否代理须另测 | OAuth 存在；客户端准入与目标视频权限未确认 |
| 用户浏览器扩展 | 用户在原站登录；扩展在本机处理授权允许的域名请求 | 桌面可行，不能作为通用手机网页前提 | 可把媒体请求留在用户设备，免服务器转发；另有扩展维护 | 技术原型值得评估，仍不保证改变 embed 的服务端规则 |
| 用户自托管的本地桥 | 用户控制的设备持有会话；页面只连配对后的桥 | 手机需连接电脑/家庭服务，离家与休眠会影响体验 | 流量走自有设备；增加安装、运行与连接步骤 | 可以隔离实验，需用户本人完成登录并验证 |
| 网站服务器托管账号 cookie | 每个用户的登录会话保存在服务器；共享站主账号是另一种更差的模型 | 表面简单，首次接入/会话过期难处理 | 要增加账号隔离、凭据存储、失效重登及可能的媒体中转 | 尚未实测，不适合作为 Lite 默认方案 |

扩展确实具有普通网页没有的能力：经授权的 host permissions 可允许扩展后台跨源请求；cookie API 另需 cookie 权限。Chrome 官方文档同时要求限制外部请求入口，不应把任意 URL 代理暴露给网页。实际设计应只接受合法视频 ID，限定 Nico 域名，账号 cookie 留在扩展/本地环境中，不回传页面或 Vercel。[Chrome 扩展跨源请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[Chrome cookie API](https://developer.chrome.com/docs/extensions/reference/api/cookies)

手机不能假定可安装与桌面相同的 Chrome 扩展；Chrome 官方手机安装说明实际是「Add to Desktop」，下次在电脑上启用。iOS Safari 扩展又是独立分发与测试工作，不能拿桌面 Chrome 原型当作已覆盖手机。[Chrome 官方扩展安装帮助](https://support.google.com/chrome_webstore/answer/2664769?hl=en)

自托管桥也不应把「读取本机现成浏览器 cookie」当作默认登录流程；需要用户明确建立连接和授予会话访问。如果以后获得官方 OAuth 客户端，原生/本地工具应使用系统浏览器授权，遵循外部 user-agent 模式，而非在自制密码表单里收集 Niconico 密码。[RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)

## 建议的下一步

1. 将当前问题拆成「登录/内容权限」与「媒体传输」两个验证点。公共匿名视频的成功只能证明传输通道，不代表已解决 `sm36735375` 的登录与嵌入限制。
2. 面向手机和普通访客，优先评估官方 OAuth 接入资格；拿到属于 Lite 的合法客户端后，再做一个视频的授权、播放、弹幕和退出闭环。官方支持入口在 [Niconico 帮助](https://qa.nicovideo.jp/faq/show/76?site_domain=default)。本次没有发送任何咨询或申请。
3. 若官方授权接入不可获得，而目标主要是站主自用，优先单独做本地桥/扩展的小原型；凭据留在用户设备，保留现有网站的轻量默认路径。桌面与实体手机分别验证后再决定是否合并。
4. 现阶段不把站主个人 cookie 加进 Vercel 环境变量供所有访客共用，也不先建设多用户账号托管系统。它会把一次播放器扩展变成长期账号系统，且没有证据证明能满足全部受限视频。

## 视频流量与成本实测

### 传输链路

匿名样本使用 `sm1097445` 和 `sm38833751`，没有使用受限视频的账号凭据。请求元数据、创建临时播放会话、读取列表与有限分片；会话与 URL 只保留在测试进程内，不写入本文或代码仓库。

`sm1097445` 的同一播放会话，以本站 production Origin 做 HTTP 对照：

| 资源 | 不带会话 cookie | 带临时播放会话 cookie | 对本站的 CORS |
| --- | --- | --- | --- |
| HLS 列表 | 200 | 200 | 无 `Access-Control-Allow-Origin` |
| init / 音视频分片 | 200 | 200 | 无 `Access-Control-Allow-Origin` |
| AES 播放密钥 | 403 | 200 | 无 `Access-Control-Allow-Origin` |

这说明有些媒体 URL 在本次测试中不要求 cookie，但 **HTTP 客户端拿到 200，不等于网页里的 hls.js 能读取它**。还必须满足 CORS、密钥和播放器支持。302 跳转也不会替最终 CDN 响应补上 CORS。

在隔离的本地原型中，对 `sm38833751` 选择最低 360p 视频与低码率音频，以 Chrome 154 实测：

| 播放方式 | 结果 |
| --- | --- |
| 原生 HLS，只代理列表/密钥，init/分片直连 | 桌面与 Android UA/触控模拟均未起播，媒体错误 4 |
| 原生 HLS，全部资源通过本地代理 | 仍未起播，媒体错误 4；不能把上一行的失败单独归因于 CORS |
| hls.js，只代理列表/密钥，init/分片直连 | 5 条 CORS 错误，未加载可播放缓冲 |
| hls.js，全部资源通过本地代理 | 正常起播，观察到 6.76 秒，`readyState=4`、无媒体错误、缓冲到 23.96 秒 |

最后一项观察窗口为 8 秒，代理 15 次请求、响应约 1.12 MB，其中媒体约 1.118 MB；包含预缓冲，不能直接按 8 秒外推每小时费用。未做 60 秒稳定性测试、真实手机或 Safari 测试。原生 HLS 的失败尚未进一步定位；`canPlayType` 返回 `maybe` 不能作为成功证据。

因此目前可证明的是「公共视频可以经自建播放器和全量代理起播」。**目标受限视频的授权未完成，跨浏览器音视频直连也未证明可行**。这不是已实现的 Lite 产品功能；原型在临时目录运行并已停止，正式入口仍用官方 iframe。

### 弹幕

同一公共样本的官方 `public.nvcomment.nicovideo.jp/v1/threads` 接口，携带本站 Origin 的预检和读取请求均返回 200，`Access-Control-Allow-Origin: *`；一次返回 593 条弹幕，未压缩 JSON 174,279 bytes。这里只读取弹幕，没有发表评论。

因此公共弹幕可单独考虑浏览器直连：取得该视频的临时 thread key 后，一次获取、只留内存、切站释放，并限制条数与当前屏幕绘制数量。受限视频是否授予同样的评论权限仍需在授权闭环中验证，不能从公共样本直接推断。

### 每小时流量

以下按 `sm38833751` 的官方媒体元数据返回码率估算，使用十进制 MB/GB：`GB/h = (视频码率 + 音频码率) × 3600 ÷ 8 ÷ 10^9`。这是样本估算，画面复杂度、预缓冲、拖动、重试和其他视频都会改变实际值。

| 档位 | 样本总码率 | 每小时媒体 | 每 100 小时媒体 |
| --- | ---: | ---: | ---: |
| 仅音频，低码率档 | 98,854 bit/s | 44.5 MB | 4.45 GB |
| 最低 360p + 低码率音频 | 402,216 bit/s | 181 MB | 18.10 GB |
| 480p + 低码率音频 | 986,717 bit/s | 444 MB | 44.40 GB |
| 720p + 高码率音频 | 1,783,657 bit/s | 803 MB | 80.26 GB |

音频档名分别含 `64kbps` / `192kbps`，但这个样本 API 报告 98,854 / 226,928 bit/s；表中按返回值计算，没有把档位名称当作精确传输码率。1080p 在此次匿名会话中不可用，未计入。

### Vercel 费用口径

当前官方 iframe 的媒体流量不经过 Vercel。若改为 Vercel Function 全量代理，通常既产生 Function → CDN 的 Fast Origin Transfer，也产生 CDN → 用户的 Fast Data Transfer，另有请求和计算费用。不能只看浏览器侧流量。[官方计量说明](https://vercel.com/docs/manage-cdn-usage)

截至核查日，Hobby 文档列出 Fast Data Transfer 100 GB、Fast Origin Transfer 10 GB。若其他用量为零，按上表的全量无缓存代理估计，10 GB Origin 额度约支持最低 360p **55 小时**、480p **23 小时**、720p **12 小时**；已有电台和其他项目还会消耗额度。额度不是可以自动付费延长的保证，Hobby 超限行为以具体资源和后台为准。[官方 CDN 额度](https://vercel.com/docs/manage-cdn-usage)、[Hobby 说明](https://vercel.com/docs/plans/hobby)

按量费率示例：Washington D.C. 的 Data / Origin 分别为 $0.15 / $0.06 每 GB，Tokyo 分别为 $0.16 / $0.27 每 GB。下面仅为两个链路都按对应示例地区计费、没有免费额度抵扣时的传输费，**不是用户当前项目账单**。[美国费率](https://vercel.com/docs/pricing/regional-pricing/iad1)、[东京费率](https://vercel.com/docs/pricing/regional-pricing/hnd1)

| 档位，100 小时 | 美国示例传输费 | 东京示例传输费 |
| --- | ---: | ---: |
| 仅音频 | $0.93 | $1.91 |
| 最低 360p | $3.80 | $7.78 |
| 480p | $9.32 | $19.09 |
| 720p | $16.86 | $34.51 |

实际 Function 与访客 CDN 可能在不同地区，套餐也可能启用 Flat Rate CDN；需按后台配置重新计算。表中不含订阅、CPU、驻留内存、CDN/Function 请求、重试及税费。Fluid Compute 的 I/O 等待不计 Active CPU，但仍可能计入内存使用时间。[Fluid Compute 计价](https://vercel.com/docs/functions/usage-and-pricing)

### 适合 Lite 的继续方式

建议先解决 **正式授权来源**，再选择媒体通道。可保留现有 TypeScript、原生 `<video>` 与按需 hls.js；自建轻量弹幕层，无需换前端框架。当前不应为了未验证的直连假设建设完整登录系统。

1. 获得自己的 OAuth 客户端与对应播放接口说明；用目标视频确认用户授权确实可取流。没有这些条件时，将个人扩展/本地桥作为独立实验，不把原站 cookie 上传公共服务。
2. 把已证明可起播的全量代理作为受控原型基线，继续在实体 Safari/Android 上测试能否只代理必要资源。直连不通时，要明确给出转发成本，不能悄悄用高画质代理兜底。
3. 若决定使用代理，默认最低画质或仅音频，限制预缓冲和后台播放，暂停/关闭时释放请求。不持久保存视频或弹幕；这能控制本应用存储，但不能承诺浏览器和 Nico 自己的 HTTP 缓存为空。
4. 对长时间观看，单独评估用户自托管媒体网关；它能把视频流量移出 Vercel，但仍有网关流量、运行维护和账号授权成本。当前没有部署网关、增加付费资源或发布登录功能。
