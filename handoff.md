# Handoff: app-deck（交接文档）

> 本交接文档面向下一个接手的 Agent。已产出的规格/文档请直接引用，不重复内容。

## 项目定位

app-deck 是一个跨平台「项目台账 + 脚本按钮控制台」：一个网页管理所有 web 应用与脚本（项目分组、按钮执行、pm2 托管、AI 自动接入）。

- 项目路径：`/Users/frazier/Project/Personal/app-deck`
- 状态：**仅初始化，尚未编写任何代码，git 无提交**（main 分支，4 个未跟踪文件）

## 已定决策（不可随意推翻）

1. **引擎选型：pm2 托管层 + 自研执行器**。pm2 负责常驻进程的守护/开机自启/崩溃重启/日志；一次性命令（备份、部署等）走自研 `subprocess` 执行器（pm2 会把一次性命令的正常退出误判为崩溃反复拉起，所以必须双轨）
2. **API-first**：HTTP API 是第一等公民，UI 只是 API 的客户端。AI 接入零成本，走同一套 API
3. **幂等 upsert**：`PUT /api/apps/:appId` 与 `PUT /api/apps/:appId/buttons/:buttonId` 均为覆盖语义（AI 重复 curl 不报错、不产生重复数据）
4. **端口固定 6969**；数据文件 `~/.app-deck/apps.json`（全局语义，已 gitignore）
5. **名字 app-deck**（已查证 GitHub 无同名仓库占用）
6. 后端 Node（>=18，ESM），pm2 与 app-deck 均不安装在本机，开发前需 `npm install pm2 -g`

## 功能需求（完整清单）

- 项目列表一屏流，**无侧边栏**，顶部状态栏；新增/编辑项目与按钮用**半屏弹窗**
- 每个项目一组按钮，按钮两种类型：`managed`（pm2 托管）+ `exec`（一次性执行，展示输出/退出码）
- 项目、按钮全部支持面板上增删改，实时持久化
- 按钮执行后可**查看日志**、显示**失败原因/成功状态**
- 状态栏上有「守护进程」「开机自启」**UI 开关**（用户不想输 pm2 命令）
- 跨平台 Mac/Linux/Windows（Windows 自启用 pm2-windows-startup）
- i18n（默认中文，可切换英文）、响应式布局
- AI 接入：AI 读 AIUsage.md → 幂等 PUT 登记项目/按钮 → 用户启动后直接可用，无需手动点 UI

## MVP 必须包含的能力（讨论确定的缺口）

1. 执行中状态（running）+ 可取消（长任务）
2. 历史记录（时间、退出码、输出摘要、成败）持久化，刷新不丢
3. 进程树清理（Windows 用 `taskkill /T /F`，Unix 用进程组）

## 延后项（P2）

端口占用提示、数据导出/导入、防并发点击（执行中重复 run 返回 409）、启动后健康检查（进程活着≠服务起来了）。

## 已产出产物（勿重复写，直接引用）

| 文件 | 内容 |
|---|---|
| `/Users/frazier/Project/Personal/app-deck/package.json` | app-deck 0.1.0，ESM，Node>=18，`npm start` / `npm run dev` |
| `/Users/frazier/Project/Personal/app-deck/.gitignore` | node_modules、`data/apps.json`、日志、OS 文件 |
| `/Users/frazier/Project/Personal/app-deck/README.md` | 特性表、架构图、安装三步、启动方式、pm2 守护/自启命令速查（含 Win 差异） |
| `/Users/frazier/Project/Personal/app-deck/docs/AIUsage.md` | AI 接入指南 + 完整 API 文档（数据模型、接口清单、curl 示例、幂等/并发约定）：**API 实现以此文档为规格** |

**AIUsage.md 中 API 已设计但未实现**，接口清单：项目 CRUD（GET/PUT/POST/PATCH/DELETE）、按钮 CRUD、run/status/logs、system 类（health/export/import）。注意：**「守护进程/开机自启」开关对应的 system API 在 AIUsage.md 中尚未设计，需新 Agent 补充**（如 `POST /api/system/daemon`、`POST /api/system/startup`）。

## 待办（下一步工作，按序）

1. **先出 Markdown 实现方案**（用户全局规范：大改动必须先方案确认）: 数据模型/API/前端布局/i18n 结构
2. **TDD 实现核心代码**（用户全局规范：先写失败测试再实现，一次一测，只测公开接口）
   - `src/store.js`：apps.json 持久化（`~/.app-deck/apps.json`）
   - `src/executor.js`：一次性命令执行器（跨平台，进程树清理，输出采集）
   - `src/pm2.js`：pm2 封装（托管启停、status、startup/unstartup）
   - `src/index.js`：HTTP 服务 :6969，路由按 AIUsage.md
   - `public/`：单页前端（一屏 list、顶部状态栏含守护/自启开关、半屏弹窗、i18n、响应式）
   - 状态栏守护/自启开关的 API 需补充设计
3. 跑测试验证：补 README 使用说明
4. 提交 git（**中文提交信息**，格式「feat: xxx」）

## 环境事实

- 用户机器：macOS（darwin）
- **pm2 未安装**（`pm2 not found`），node 全局路径 `/opt/homebrew/lib/node_modules`
- pm2 体积：解包约 1.2 MB，可忽略
- Git 分支 main，尚无 commit

## 敏感信息

无密钥/凭证涉及。注意：API 当前设计无认证（本地工具），文档已约定不入密钥；将来做认证需用户确认。

## Suggested Skills（下一 Agent 应调用）

- `matt·tdd` : 用户全局规范强制 TDD（红-绿-重构，一次一测，只测公开接口，禁 Mock 私有逻辑）
- `matt·implement` : 依据 AIUsage.md 规格实现后端 API 与执行器
- `design-taste-frontend` : 前端单页（一屏流、状态栏、半屏弹窗、i18n、响应式），避免模板化
- `matt·plan-mode` : 用户全局规范：大改动前先出 Markdown 方案等确认（此项目尚未实施，开工必走）

## 交接提醒（用户全局规范红线）

- 删除文件、git 回滚、修改密钥/系统配置等操作必须先询问授权
- 每次交付前自检：改动是否追溯请求、验证是否跑过、有无偷偷加功能
- 沟通默认中文，git 提交信息「英文类型前缀 + 中文描述」
