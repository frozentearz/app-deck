# App-Deck

跨平台「项目台账 + 脚本按钮控制台」。一个网页管理你所有的 web 应用与脚本：项目分组、按钮执行、pm2 托管、AI 自动接入。

## 为什么

Web 应用太多时，启动、停止、维护都要进目录敲命令，还要记着有哪些项目要维护。App-Deck 把这一切收敛到一个网页：

- 打开 `http://localhost:6969` 即见所有项目与按钮
- 点按钮即执行：**托管按钮**交给 pm2 守护，**执行按钮**直接跑一次并展示结果
- 项目、按钮全部支持在面板上新增 / 编辑 / 删除
- AI 或脚本可通过 HTTP API 自动登记项目，无需手动点 UI

## 核心特性

| 特性 | 说明 |
|---|---|
| 项目台账 | 项目分组 + 按钮组，一屏 list，无侧边栏 |
| 双类按钮 | 托管（pm2：守护 / 自启 / 崩溃重启）与执行（一次性命令 + 输出 / 退出码 / 日志）|
| 全 CRUD | 项目与按钮均可在面板上增删改，实时持久化 |
| 跨平台 | macOS / Linux / Windows（pm2 托管层 + 自研执行器）|
| 开机自启 | pm2 startup 三平台注册 |
| AI 接入 | 幂等 HTTP API，AI 读文档后 curl 自动登记项目 |
| 多语言 | i18n（默认中文，可切换英文）|
| 响应式 | WebUI 一屏流，适配桌面与移动端 |
| 自身托管开关 | 面板右上角：守护进程、开机自启一键开关（免敲命令）|

## 技术架构

```
┌─────────────────────────────────────────────┐
│  Web UI（单页，一屏流，i18n，响应式）          │
└──────────────────────┬──────────────────────┘
                       │ HTTP :6969
┌──────────────────────▼──────────────────────┐
│  App-Deck API（Node.js）                      │
│   · 项目 / 按钮 CRUD（apps.json 持久化）       │
│   · 执行器：一次性命令（subprocess 跨平台）     │
│   · 托管：对接 pm2 守护进程                    │
└───────┬──────────────────────┬──────────────┘
        │                      │
   ┌────▼─────┐          ┌────▼─────┐
   │  pm2     │          │ subprocess│
   │ (托管层) │          │ (执行层)  │
   └──────────┘          └──────────┘
```

- 后端：Node.js（>= 18），HTTP API 为第一等公民，UI 只是 API 的客户端
- 数据：`~/.app-deck/apps.json`（项目配置）+ `~/.app-deck/history.json`（执行历史，全局工具语义，不含业务密钥）
- 端口：固定 `6969`

## 快速开始

```bash
cd app-deck                # 进入 app-deck 项目目录
npm install pm2 -g         # 托管层（一次性）
npm install                # 安装依赖
npm start                  # 手动启动，浏览器打开 http://localhost:6969
```

## 安装本应用（三步）

1. **准备 Node.js**：>= 18（https://nodejs.org）
2. **安装 pm2 托管层**（全局一次性）：
   ```bash
   npm install pm2 -g
   ```
3. **下载本项目代码**（克隆或拷贝到任意目录），进入目录安装依赖：
   ```bash
   cd app-deck
   npm install
   ```

## 启动本应用

**日常使用（推荐，有守护 + 开机自启）**：

```bash
cd app-deck
pm2 start src/index.js --name app-deck   # 启动并守护（终端关了也不影响）
pm2 save                                  # 固化进程配置
```

浏览器打开 `http://localhost:6969`。

**启动后，在 App-Deck 界面右上角可开关「守护进程」与「开机自启」**——推荐直接在 UI 上操作，无需记命令。

**开发/临时使用**（不装 pm2 时）：

```bash
cd app-deck          # 进入 app-deck 项目目录
npm start            # 前台运行，关掉终端即停
npm run dev          # 开发模式（热重载）
```

**平时管理 app-deck 自身**：

```bash
pm2 status app-deck            # 查看状态
pm2 logs app-deck              # 查看日志
pm2 restart app-deck           # 重启
pm2 stop app-deck              # 停止（不删配置）
```

## 守护进程与开机自启（命令速查，UI 故障时兜底）

> 面板右上角的开关对应以下命令。UI 正常时直接用开关即可，无需敲命令。

**安装守护 / 开机自启**：

```bash
pm2 start src/index.js --name app-deck
pm2 save                 # 固化当前进程列表（开机后 pm2 按此恢复）
pm2 startup              # 生成系统自启服务，按提示复制执行输出中那条 `sudo ...` 命令
```

**卸载守护 / 关闭开机自启**：

```bash
pm2 delete app-deck          # 停止并移除进程
pm2 unstartup                # 移除系统自启服务（同样按提示执行输出命令）
pm2 save                     # 保存空列表，避免重启后自动恢复
```

### Windows 差异（pm2 无 startup 命令）

```bash
npm install pm2-windows-startup -g   # 安装自启插件（一次性）
pm2-startup install                  # 注册开机自启
pm2 save                             # 保存进程配置
# 卸载：
pm2 unstartup                         # 移除开机自启
pm2 delete app-deck                   # 停止并移除 app-deck
```

## 目录结构

```
app-deck/
├── src/            # 后端源码
│   ├── index.js    # 入口：HTTP 服务
│   ├── store.js    # apps.json 持久化
│   ├── executor.js # 一次性命令执行器（跨平台）
│   └── pm2.js      # 托管层封装
├── public/         # 前端单页（HTML/CSS/JS）
├── test/           # 测试（node:test）
├── docs/
│   └── AIUsage.md  # AI 接入指南 + API 文档
└── package.json
```

## 测试

```bash
npm test            # 运行全部测试（node --test）
```

## 文档

- [AI 接入指南与 API 文档](docs/AIUsage.md)
- 在线文档站点（规划中）：`https://frozentearz.github.io/app-deck/AIUsage`

## License

MIT
