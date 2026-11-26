# HelloTodo 0.1.0-dev — 开发预览（未通过最终验收）

目标：以 Microsoft To Do 的三栏布局和操作习惯为参考，使用独立 HelloTodo 品牌及原创代码，支持本地待办、微软只读迁移、Cloudflare 多端同步。**本压缩包不是承诺的 1:1 完成版。** 没有微软原版完整截图、行为基线和真实账号，没有 .NET SDK / NuGet 网络、Cloudflare 账户授权；Chromium 被环境管理策略阻止访问本地站点。未验证的源码不应投入生产或作为唯一数据备份。

## 目录

- `web/`：原生 HTML/CSS/JavaScript PWA，三栏任务 UI、IndexedDB 离线保存、Graph PKCE 导入、增量同步。浏览器端不使用 SQLite，而用 IndexedDB。
- `server/worker.mjs`：Cloudflare Workers HTTPS API；`server/migrations/0001.sql`：D1 SQL、增量游标、原子触发器、操作去重；可选 R2 文件接口。
- `server/local.mjs`：同一 Worker 代码通过 Node 22 + 实际 SQLite 本地运行，文件保存到磁盘；不是 Cloudflare 正式运行时。
- `native/HelloTodo/`：Avalonia 11.2.3 + .NET 8 共享原生 UI 和 Microsoft.Data.Sqlite 数据层（尚未编译；直接使用 SQLite ADO.NET，未集成 SqlSugar/CommunityToolkit）。
- `native/HelloTodo.Desktop/`、`native/HelloTodo.Android/`、`native/HelloTodo.iOS/`：原生入口，未验证。
- `tests/`：本轮 98 项 Node 自动化测试通过（包括 3 项源码布局/跨端接线检查），原生 C# 与浏览器真机尚未验收。
- `.github/workflows/ci.yml`：可提交到 GitHub 的 CI 配置，未运行；iOS 真机签名/构建需单独配置。
- `ACCEPTANCE.md`：逐项 26 项验收状态及限制。

## 1. 不需要 Cloudflare 即可在自己电脑试运行

安装 Node.js 22（建议最新 22 LTS），解压后打开 PowerShell：

```powershell
cd HelloTodo
node server/keygen.mjs
$env:HELLOTODO_KEY="这里填生成的 CLIENT KEY"
npm test
npm start
```

打开 `http://127.0.0.1:8787`。不登录也能添加任务并保存在浏览器。点设置 -> 连接工作区 -> 填相同 CLIENT KEY，可以测试云同步（这时实际连的是本机 SQLite 后端）。用不同浏览器或隐私窗口模拟两台设备。默认绑定 127.0.0.1，不直接暴露到公网。保管固定密钥，否则下一次随机密钥对应不同的工作区。`local.sqlite` 与 `local-files/` 不是生产数据，别提交到 Git。

浏览器端自测（需可运行 Chromium 的环境）：

```bash
python -m pip install playwright
python -m playwright install chromium
python tests/browser.py
```

## 2. 部署到自己 Cloudflare 账号

在有网络、已安装 Node 的电脑操作；先测试，不要用于存放唯一一份真实任务。D1、Workers、R2 的免费额度及计费以 Cloudflare 控制台为准；R2 可能要求启用计费方式，超免费额度收费。

```bash
npm install
npx wrangler login
npx wrangler d1 create hellotodo
```

把命令返回的 database_id 写进 `wrangler.toml` 对应位置。若需要附件，创建 `npx wrangler r2 bucket create hellotodo-files` 并取消 R2 binding 的注释。不开 R2 时不要上传需要跨端同步的附件；否则上传会失败并留在待同步队列。

```bash
node server/keygen.mjs
npx wrangler secret put WORKSPACE_KEYS
# 粘贴输出的 SHA-256 值，而不是 CLIENT KEY。多工作区可以逗号分隔多个哈希。
npx wrangler d1 migrations apply hellotodo --remote
npx wrangler deploy
```

打开部署返回的 HTTPS workers.dev 地址（或自行配置自定义域名）。设置中输入 **CLIENT KEY**，另一设备使用同样的密钥。不要将任何密钥写入源代码、GitHub 或聊天公开信息。不同密钥对应不同工作区，服务端不会信任客户端传来的 user_id。本版没有注册、找回密码、MFA、单设备吊销或 Microsoft 账号作为 HelloTodo 自身认证；只适用于管理员发放密钥的个人工作区。密钥保存在客户端本地存储，发布前应换成平台安全凭据存储和成熟的身份认证；服务端需补充速率限制、配额、加密及恢复策略。

## 3. 导入 Microsoft To Do（只读）

**开发者一次配置，用户直接登录；不要为每个用户创建 Entra 应用。**

1. 登录 https://entra.microsoft.com/ → 应用注册 → 新注册，名称 HelloTodo，支持账户类型选择“任何组织目录中的账户和个人 Microsoft 账户”。如果仅支持个人账户，可选仅个人账户。
2. 身份验证 → 添加平台 → 移动和桌面应用程序，添加 `http://localhost`；再添加单页应用 SPA 平台，填写 `http://localhost:8787/index.html` 及正式站点 `https://<你的域名>/index.html`（逐一填入实际地址，不能用通配符）。使用不同路径区分桌面和 SPA 回调。网页本地用 `http://localhost:8787/` 访问，不用 127.0.0.1，除非另行注册该回调。
3. API 权限：Microsoft Graph → 委派权限 `Tasks.Read`（任务导入）；另需 Office 365 Exchange Online → 委派权限 `Tasks.Read`（Outlook 原始附件批量补齐）。两种 `Tasks.Read` 属于不同资源，HelloTodo 分别申请 Graph 和 Outlook access token，不会混用。OAuth 同时申请标准 `offline_access`，用于静默续期。不要添加客户端密钥或 `Tasks.ReadWrite`。组织管理员可能限制用户授权。若发布给公众，建议完成发布者验证并添加隐私政策。
4. 复制“应用程序(客户端) ID”，写入 `web/microsoft-config.json` 的 `clientId`。该文件是公开配置，并非密码。桌面编译时嵌入同一文件；网页重新部署到 Cloudflare。未配置时显示发布者配置提示，不要求终端用户自己注册。
5. 桌面：设置 → 迁移 Microsoft To Do → Microsoft 登录并授权导入，MSAL 使用系统浏览器、授权码 + PKCE，直接导入当前 SQLite 工作区。网页：设置 → Microsoft 登录并授权导入，授权后自动导入当前 IndexedDB 工作区。网页会在当前浏览器 localStorage 缓存 Graph / Outlook access token 与 refresh token，优先静默续期，不再每次强制选择账户或重复同意；令牌不写入 HelloTodo 任务数据库，也不上传到任务同步 API。清除浏览器站点数据、撤销 Microsoft 同意或刷新令牌失效后，需要重新授权。浏览器同源脚本可访问 localStorage，需保护站点免受 XSS。Android/iOS 暂未接入原生授权，仍需通过网页导入到同一云工作区。
6. 分页读取任务和清单、备注、步骤、完成历史、日期、重复规则、关联资源及可访问附件；重复导入以来源 ID 去重，不覆盖现有编辑。这是迁移，不是持续与微软双向同步。先检查数量和错误，导出备份。Graph 未公开字段不能保证完全还原。
7. `native/HelloTodo.slnx` 包含四个原生项目。新版 Visual Studio 可直接打开；仅编译桌面可单独打开 Desktop 项目，或者运行 `dotnet build native/HelloTodo.Desktop/HelloTodo.Desktop.csproj`。Android/iOS 需相应 workload，iOS 构建还需 Mac/Xcode。当前环境没有 .NET SDK，原生改动未编译，真实 Microsoft 账户登录未验收。

Microsoft Graph 文档：
- https://learn.microsoft.com/en-us/graph/api/resources/todotask?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/resources/todotasklist?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/api/taskfileattachment-get?view=graph-rest-1.0

## 4. Outlook 原始附件批量补齐

设置 → 迁移 Microsoft To Do 只保留两个入口：

1. **Microsoft 登录并授权导入**：使用 Graph `Tasks.Read` 导入任务、清单和附件信息；重复导入按来源 ID 去重。
2. **仅重试待补齐附件**：使用 Exchange Online `Tasks.Read` 直接访问 Outlook / Substrate 原始附件接口。它只处理当前标记为待补齐的任务，不重新导入任务正文。

第二个入口先读取每个待补齐任务的原始附件清单，再按附件 ID 逐个下载所有文件，不再只取第一个附件。已保存的相同 Outlook 附件 ID 会跳过；单个附件失败不会中断其他任务，失败/未验证任务继续保持待补齐状态。单次最多处理 200 个任务，每个任务最多读取 200 个附件。缺少原始清单 ID 的旧任务会尝试用本机已有的 Graph token 定位；没有可用 Graph token 时会报告该任务需要先重新导入任务信息，不会额外强制弹出第二次 Graph 授权。

- Graph 与 Outlook token 属于不同资源，不能互换。Outlook scope 为 `https://outlook.office.com/Tasks.Read`。
- `Preview.Size` 只作为预览元数据记录；HTTP `Content-Length` 与实际接收字节数不一致、响应体读取失败、HTML/JSON 错误页、空文件或超过 25 MiB 仍然拒绝保存。
- 图片会进行文件容器结构检查和浏览器解码。通过验证的图片即使 Preview.Size 不一致，也可以保存并将大小差异记为警告。ZIP、PDF、Office 等非图片格式不会套用图片解码规则；若大小元数据不一致或缺失，会保存为待核对并保留任务待补齐状态。
- Outlook access token 会通过 HTTPS 发送给用户自己配置的 HelloTodo Worker / 本机服务执行只读代理请求；服务端不保存 token、不记录 token，也不将 token 放入任务同步数据。Graph token 不发送给 HelloTodo Worker。
- 本机 `npm start` 服务仅允许 loopback 来源调用诊断接口。Cloudflare 部署则要求先连接 HelloTodo 工作区密钥。
- 该功能依赖 Outlook/Exchange 内部接口，微软未承诺其稳定性；账户类型、服务端策略或接口变化可能导致 401/403/404。失败时保留已下载附件和错误阶段，重试时跳过已存在文件。

首次使用 Graph 和 Outlook 两种权限时，Microsoft 可能各显示一次授权页面。授权成功后，应用会缓存刷新令牌并静默续期；不再每次显式传入 `prompt=select_account` 或 `prompt=consent`。如果清除浏览器站点数据、撤销授权或 refresh token 失效，才需要重新登录/授权。

## 5. 原生端构建（待本地/CI验证）

```powershell
dotnet build native/HelloTodo.Desktop/HelloTodo.Desktop.csproj -c Release
dotnet run --project native/HelloTodo.Desktop/HelloTodo.Desktop.csproj
# Android 安装 Android SDK、JDK 以及 .NET Android workload 后：
dotnet workload install android
dotnet build native/HelloTodo.Android/HelloTodo.Android.csproj -c Release
```

macOS 桌面使用同一个 Desktop 项目。iOS 需要 macOS + 匹配的 Xcode / .NET iOS workload、签名和设备；`dotnet build native/HelloTodo.iOS/HelloTodo.iOS.csproj` 尚未验证。桌面 UI 使用共享 C# 控件构造方式，移动端布局仍需专门适配；当前不是已打包的 APK、EXE、IPA。桌面端已添加 MSAL 原生 Graph 导入源码（未编译），Android/iOS 仍依赖网页工作区；原生 JSON 导出仅含元数据，完整附件备份请用网页版；本地记录不自动上传至新连接工作区，避免误合并账户。

## 6. 同步协议与已知边界

- `POST /api/push`，每个操作包含 `opId/kind/id/patch/deleted`，单次最多 40，客户端每批 20；服务端 `changes` 的 UNIQUE 约束使重试幂等，触发器在同一 SQL 写操作中执行 RFC 7396 合并、更新版本和游标。
- `GET /api/pull?cursor=...` 按服务端序号分页，客户端应用远端结果并重放未确认本地操作；不依赖手机/电脑本地时钟确定冲突优先级。同字段以服务端接收顺序为准；删除优先且不可直接撤销，恢复需要新 ID。
- `PUT/GET/DELETE /api/attachments/:id`；最大 25 MiB，R2 前缀基于授权哈希。客户端先传附件再确认元数据。文件移除会删除元数据，R2 垃圾回收未实现；请勿无限累积历史。
- 浏览器采用前台 15 秒轮询、编辑后同步、网络恢复同步及 Service Worker 缓存；不保证锁屏/后台实时同步和通知。浏览器多标签并发写入同一 IndexedDB 快照尚未处理，建议每个浏览器工作区仅开一个标签页。
- 原生端 SQLite 存储工作区快照和待同步队列；记录修改与保存同步执行；原生提醒仅状态栏提示，未接入 OS 通知。原生主题、移动布局、排序、自定义重复、键盘/触屏交互均有未完成部分。
- 无端到端加密；JSON 备份与 SQLite 包含明文任务内容，请自行保管。生产发布前需要安全审计和负载测试，日志和 tombstone 需归档策略。未实现多人协作清单、共享邀请、智能建议算法、Outlook/Planner 集成、全量微软私有字段复刻。


Outlook 附件的 Substrate `Preview.Size` 仅作为预览元数据提示，不再作为原始附件的强制大小。实际 HTTP Content-Length 与接收字节数仍严格校验；图片还会检查容器标记并在浏览器中解码，验证通过后可正常保存。PDF、ZIP、Office 等非图片文件若大小不一致，只能明确保存为待核对状态，不能自动标记迁移完成。

### Outlook 附件通用下载（最新）

见 [OUTLOOK-RAW-DOWNLOAD.md](OUTLOOK-RAW-DOWNLOAD.md)。该说明替代旧版 DOCX 和图片格式校验策略；Outlook 附件恢复仅检查传输、保存收到的字节，不再因 Preview.Size 或后缀拦截。

## 桌面三栏宽度调整

将鼠标放在左侧清单与任务列表之间，或任务列表与右侧详情之间的分隔线上，按住左键横向拖动。右侧分隔线仅在任务详情打开时出现；左侧导航收起时也隐藏对应分隔线。双击分隔线恢复对应默认宽度（左 260px、右 345px）。也可用 Tab 聚焦分隔线并按左右方向键微调，Shift 加快调整，Home/End 移至边界。宽度按当前浏览器地址本地保存，不同步到其他设备。760px 及以下保留原有窄屏布局。桌面中间任务区至少保留 280px，窗口缩小时自动收缩侧栏。

## 莫奈色系与弹窗

全局色调及清单背景色使用独立设置，详见 [THEME-COLORS.md](THEME-COLORS.md)。


## 最新跨平台设置更新

见 [CROSS-PLATFORM-SETTINGS.md](CROSS-PLATFORM-SETTINGS.md)：Web 响应式设置、原生共享主题和附件视图、桌面原生 Outlook 批量恢复源码、移动端 Web 迁移入口与验收限制。


## 桌面界面与多系统分发

桌面导航透明背景、任务宽度修复、网页式详情布局，以及 Windows/macOS/Linux 六种架构的打包和回调配置，见 [DESKTOP.md](DESKTOP.md)。桌面端 Microsoft 回调统一为 `http://localhost`，登记在“移动和桌面应用程序”平台。


## 账号、图标与全局文字大小

新增首次运行登录提示、邮箱账号及 Microsoft/Google/Apple 登录接入、账号同步、随主题变色的图标，以及 80%～160% 字号滑块。部署和第三方凭据配置见 [ACCOUNT-SETUP.md](ACCOUNT-SETUP.md)。


## Cloudflare 逐步部署

从创建 D1、R2 到账号登录、三方回调、各端连接与桌面发布，按 [Cloudflare 部署详细教程](CLOUDFLARE-DEPLOYMENT.md) 操作。桌面项目已显式列出六种 RuntimeIdentifiers，并提供对应发布配置。
