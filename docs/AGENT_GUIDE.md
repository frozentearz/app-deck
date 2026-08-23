# AI 接入指南与 API 文档

> **文档版本 (Document Version)**: `v2.4.0` (2026-08-24)
> 
> **设计初衷与核心价值：**
> 
> App-Deck 是项目运维与快捷脚本的**唯一定义中心**，人类与 AI 共同使用这一套资产：
> 
> 1. **用户通过 Web 界面统一查看**：用户可以直接在 Web 上查看各个项目的快捷功能与运行状态，并享受 JSON 语法树、Markdown 与 Mermaid 架构图的自动渲染；
> 2. **AI 代为执行与跨 Agent 运维**：
>    - 用户可以让 AI 代为执行某个按钮；
>    - **跨 Agent 一键接管**：就算跨不同的 Agent（比如 Claude、Cursor 等），也只要一键复制界面顶部的AI接入文档发给 Agent，任何新 Agent 都能立刻通过 API 接管运维工作；
>    - **统一管理，避免脚本散落**：实现跨 Agent 运维，彻底避免不同的 Agent 把脚本随地写在各个地方、难以管理和维护的混乱局面。


## 目录

1. [接入流程](#1-接入流程)
2. [基础信息](#2-基础信息)
3. [API 约定](#3-api-约定)
4. [数据模型](#4-数据模型)
5. [接口清单](#5-接口清单)
6. [AI 工作流示例](#6-ai-工作流示例)
7. [幂等与并发](#7-幂等与并发)
8. [最佳实践](#8-最佳实践)
9. [按钮输出多模态格式化规范](#9-按钮输出多模态格式化规范)

---

## 1. 接入流程

AI 接入 App-Deck 的标准流程：

1. **读取项目说明**：获得目标项目的使用文档（接口、启动方式、依赖、部署细节）
2. **生成配置**：根据文档为该项目设计按钮（启动 / 停止 / 重启 / 进入浏览器 / 项目定制脚本）
3. **调用 API 登记**：`PUT /api/apps/:name` 幂等写入项目与按钮配置
4. **验证**：调用 `GET /api/apps` 确认配置生效
5. **后续维护**：任何脚本调整均可再次 PUT 覆盖（幂等），或调用按钮执行接口测试

用户启动 App-Deck 后，该项目的所有按钮立即可用，无需任何手动 UI 操作。

## 2. 基础信息

| 项目 | 值 |
|---|---|
| 服务地址 | `http://localhost:6969` |
| 数据文件 | `~/.app-deck/apps.json`（本地持久化） |
| 认证 | 默认无认证（本地工具，后续版本可配置 Token） |

## 3. API 约定

- 全部接口以 JSON 返回，`Content-Type: application/json`
- 成功返回 HTTP `2xx`；失败返回 `4xx/5xx`，错误体为 `{ "error": "描述" }`
- **所有写接口均为幂等**：按 `appId` / `buttonId` 覆盖写入，重复调用不会报错、不会产生重复数据
- 端口固定 `6969`，修改需调整源码常量

## 4. 数据模型

### App（项目）

```json
{
  "id": "blog",
  "name": "博客系统",
  "description": "个人博客 web 应用",
  "dir": "/path/to/blog",
  "url": "http://localhost:3000",
  "port": 3000,
  "pinned": false,
  "buttons": []
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 唯一标识，URL 安全字符（`a-z0-9-`），不可变 |
| `name` | string | ✅ | 展示名称 |
| `description` | string | ❌ | 备注 |
| `dir` | string | ❌ | 项目目录（按钮命令的相对基准目录） |
| `url` | string | ❌ | 项目访问地址（用于「进入/打开」类按钮） |
| `port` | number | ❌ | 服务端口（用于运行状态探活） |
| `pinned` | boolean | ❌ | 是否置顶（置顶项目排在前面） |
| `buttons` | Button[] | ✅ | 按钮列表 |

### Button（按钮）

```json
{
  "id": "start",
  "label": "启动",
  "type": "managed",
  "command": "npm run dev",
  "cwd": "/path/to/blog",
  "shell": true,
  "outputFormat": "text"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 按钮唯一标识（app 内唯一），不可变 |
| `label` | string | ✅ | 显示名称 |
| `type` | string | ✅ | `managed` = pm2 托管（守护/自启/崩溃重启）；`exec` = 一次性执行 |
| `command` | string | ❌ | 执行的 shell 命令（可先留空，未配置时点击按钮返回 400 提示） |
| `cwd` | string | ❌ | 工作目录，缺省继承 `app.dir` |
| `shell` | boolean | ❌ | 是否经 shell 执行（默认 `true`） |
| `outputFormat` | string | ❌ | 输出渲染格式：`text`（默认文本/ANSI）、`json`（JSON 语法树）、`markdown`（Markdown 与 Mermaid 图表） |

**type 选择规则**

| 场景 | type | 示例 |
|---|---|---|
| 常驻服务 / dev server，需要守护与自启 | `managed` | `npm run dev`、`python app.py` |
| 一次性任务：备份 / 部署 / 数据同步 / 构建 | `exec` | `bash backup.sh`、`rsync -a ...` |

> 注意：**不要**把一次性命令设为 `managed`（pm2 会把正常退出当作崩溃而反复拉起）。

### 4.1 按钮命令 (command) 支持的脚本形态

按钮底层直接由操作系统的 Shell 环境执行，AI 可以灵活生成以下多种脚本形态：

1. **直接调用独立脚本文件**：
   - 依赖项目工作目录（`dir` / `cwd`），支持相对路径：
   - `python3 scripts/backup.py`
   - `./deploy.sh`
2. **多命令串联与管道控制 (复合脚本)**：
   - 顺序依赖执行（`&&`）：
     `git pull && npm install && npm run build`
   - 条件分支检测（`||`）：
     `test -d .venv || python3 -m venv .venv`
   - 管道与过滤（`|`）：
     `ps aux | grep node | grep -v grep`
3. **内联解释器脚本 (无需在磁盘创建脚本文件)**：
   - **内联 Python**（通过 `-c` 参数嵌入完整代码）：
     `python3 -c "import time; print('准备备份...'); time.sleep(1); print('完成')"`
   - **内联 Bash**（通过 `-c` 参数嵌入多语句与循环）：
     `bash -c 'for i in 1 2 3 4 5; do echo "进度: $i"; sleep 1; done'`

## 5. 接口清单

### 5.1 项目 CRUD

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/apps` | 列出全部项目 |
| GET | `/api/apps/:appId` | 获取单个项目 |
| PUT | `/api/apps/:appId` | **创建 / 覆盖**项目（幂等 upsert，AI 主用） |
| POST | `/api/apps` | 创建项目（`id` 由服务端生成，UI 用） |
| PATCH | `/api/apps/:appId` | 局部更新（支持修改置顶状态 `{ "pinned": true }`） |
| DELETE | `/api/apps/:appId` | 删除项目（同时停止托管进程） |

### 5.2 按钮 CRUD

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/apps/:appId/buttons` | 按钮列表 |
| PUT | `/api/apps/:appId/buttons/:buttonId` | **创建 / 覆盖**按钮（幂等 upsert，AI 推荐用） |
| PATCH | `/api/apps/:appId/buttons/:buttonId` | 局部更新按钮 |
| DELETE | `/api/apps/:appId/buttons/:buttonId` | 删除按钮 |

### 5.3 执行、流式与执行记录

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/apps/:appId/buttons/:buttonId/run` | 执行按钮（managed 交给 pm2；exec 直接运行） |
| POST | `/api/apps/:appId/buttons/:buttonId/cancel` | 停止正在执行的命令（进程树清理） |
| GET | `/api/apps/:appId/buttons/:buttonId/stream` | **SSE 实时流式日志推流**（`data: chunk`，结束推 `event: end`） |
| POST | `/api/apps/:appId/open-terminal` | 一键唤醒宿主系统本地终端并自动进入项目工作目录 |
| GET | `/api/apps/:appId/buttons/:buttonId/status` | 按钮/进程状态 |
| GET | `/api/apps/:appId/buttons/:buttonId/logs` | 按钮执行记录（时间、退出码、输出摘要、成败） |
| DELETE | `/api/apps/:appId/buttons/:buttonId/logs` | **清空指定按钮的所有执行记录** |
| DELETE | `/api/apps/:appId/buttons/:buttonId/logs/:runId` | **删除某条特定的执行记录** |
| GET | `/api/apps/:appId/status` | 项目运行状态探活（TCP 端口探测，无缓存） |
| GET | `/api/apps/:appId/logs` | 项目级执行记录（合并所有按钮历史，带按钮 label） |
| DELETE | `/api/apps/:appId/logs` | **清空项目的所有执行记录** |
| DELETE | `/api/apps/:appId/logs/:runId` | **删除某条特定的执行记录** |

**项目探活响应**：`{ "online": true|false|null }`。有 `port` 时真实 TCP 连接探测；无 port 返回 `null`。

**项目级执行记录响应**：`{ "entries": [ { ...历史条目, "label": "按钮名" } ] }`，按时间倒序（最新在前）。

**run 响应**：`202 { "state": "running", "runId": 1 }`。执行结果不在此响应中，通过 `logs` 接口查询（历史记录持久化，刷新不丢）。

**status 响应**：`{ "state": "idle|running", "startedAt": 时间戳|null, "lastResult": { "exitCode", "success", "killed", "finishedAt" }|null }`

**logs 响应**：历史记录数组（最新 50 条，倒序返回），每条：

```json
{
  "id": "r1",
  "startedAt": 1720000000000,
  "finishedAt": 1720000001000,
  "exitCode": 0,
  "success": true,
  "killed": false,
  "summary": "输出摘要（末尾 200 字）",
  "output": "完整输出（截断 64KB）"
}
```

### 5.4 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/export` | 导出全部配置（备份 / 迁移） |
| POST | `/api/import` | 导入配置（覆盖） |
| GET | `/api/system/status` | 守护/自启状态：`{ daemon, startup, pm2Installed }` |
| POST | `/api/system/daemon` | 开关 app-deck 自身守护（body `{ "enabled": true|false }`） |
| POST | `/api/system/startup` | 开关开机自启（body `{ "enabled": true|false }`） |

**守护/自启说明**：

- `POST /api/system/daemon` 开启时：pm2 拉起 app-deck 后，当前进程自动退出（避免端口冲突）；关闭时：先返回响应，稍后停止 pm2 进程
- `POST /api/system/startup` 在 macOS/Linux 上 `pm2 startup` 需要 sudo，接口返回 `{ "enabled": true, "manual": "sudo env PATH=... pm2 startup ..." }`，需人工在终端执行该命令；Windows 走 `pm2-windows-startup`
- pm2 未安装时守护/自启接口返回 503，`pm2Installed` 为 false

## 6. AI 工作流示例

### 6.1 登记一个新项目（幂等 PUT）

```bash
curl -X PUT http://localhost:6969/api/apps/tomcat \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "tomcat",
    "description": "Tomcat 服务器",
    "dir": "/path/to/apache-tomcat-9.0.100",
    "url": "http://localhost:8080",
    "port": 8080,
    "buttons": [
      { "id": "start",   "label": "启动",   "type": "exec", "outputFormat": "text", "command": "bin/catalina.sh start" },
      { "id": "stop",    "label": "停止",   "type": "exec", "outputFormat": "text", "command": "bin/catalina.sh stop" },
      { "id": "restart", "label": "重启",   "type": "exec", "outputFormat": "text", "command": "bin/catalina.sh restart" },
      { "id": "logs",    "label": "查看日志", "type": "exec", "outputFormat": "text", "command": "tail -10 logs/catalina.out" }
    ]
  }'
```

> 未安装或未配置：`dir` 和 `command` 可留空先登记占位，点击按钮时返回 `400 { "error": "请先配置项目路径与项目按钮的脚本" }`，在 UI 编辑表单里补全即可。

### 6.2 追加指定输出格式的维护按钮（JSON 与 Markdown 示例）

```bash
# 注册 JSON 语法树解析按钮
curl -X PUT http://localhost:6969/api/apps/tomcat/buttons/api-status \
  -H 'Content-Type: application/json' \
  -d '{
    "label": "健康探测 (JSON)",
    "type": "exec",
    "outputFormat": "json",
    "command": "curl -s http://localhost:8080/api/health"
  }'

# 注册 Markdown / Mermaid 架构图生成按钮
curl -X PUT http://localhost:6969/api/apps/tomcat/buttons/arch-diagram \
  -H 'Content-Type: application/json' \
  -d '{
    "label": "查看微服务架构",
    "type": "exec",
    "outputFormat": "markdown",
    "command": "echo \"# 微服务拓扑\n\n\`\`\`mermaid\nflowchart LR\n  Gateway --> Auth\n  Gateway --> Order\n\`\`\`\""
  }'
```

### 6.3 执行按钮

```bash
curl -X POST http://localhost:6969/api/apps/tomcat/buttons/start/run
```

### 6.4 查看执行结果

```bash
curl http://localhost:6969/api/apps/tomcat/buttons/start/logs
```

## 7. 幂等与并发

- **幂等**：`PUT /api/apps/:appId` 与 `PUT .../buttons/:buttonId` 均为覆盖语义。AI 多次补发配置不会产生重复数据
- **并发**：同一按钮的 `run` 请求在**执行期间重复调用将返回 `409`**（防并发点击）。等待执行完成后才可再次触发
- **托管按钮**：已在线时再次 `run` 返回 `409`，避免重复拉起
- **取消**：执行中的命令可 `POST .../cancel` 停止（跨平台进程树清理），历史记录标记 `killed: true`

## 8. 最佳实践

1. **AI 登记后必须验证**：`GET /api/apps/:appId` 确认写入成功
2. **识别一次性 vs 常驻**：把握不定时优先 `exec`，避免 pm2 反复拉起
3. **显式声明 outputFormat**：当脚本产物为结构化 JSON 或含 Mermaid 图表的 Markdown 时，在按钮上显式声明 `"outputFormat": "json"` 或 `"outputFormat": "markdown"`，App-Deck Dock 底部控制台将直接精准渲染，用户无需手动切换
4. **巧用内联解释器脚本**：临时小工具、探测或轻量数据统计无需在磁盘创建独立脚本文件，直接在 `command` 字段中写 `python3 -c "..."` 或 `bash -c "..."`
5. **命令写相对路径**：cwd 单独用 `dir`/`cwd` 字段表达，不要拼在 command 里，便于维护
6. **按钮 id 稳定**：id 是程序标识，label 才是展示文案；后续文案变化只改 label
7. **敏感信息**：API 未带认证，请不要写入密钥；如需，将凭证放入 cwd 目录下的独立配置文件（.env 类）

## 9. 按钮输出多模态格式化规范

App-Deck 控制台内置了多模态渲染器，根据按钮的 `outputFormat` 属性（或内容特征）进行渲染：

| outputFormat | 展现与渲染机制 | 推荐应用场景 | 示例命令 |
|---|---|---|---|
| **`text`** (默认) | 标准 stdout 文本输出。支持 ANSI 彩色控制符与 `INFO`（蓝）、`WARN`（黄）、`ERROR`（红）日志级别高亮 | 普通文本、构建日志、服务输出、系统探测 | `echo -e "\033[32m[INFO]\033[0m 服务启动成功"` |
| **`json`** | 自动解析 JSON 并呈现为可交互折叠的语法树，高亮键值与类型（解析异常时平滑降级展示文本） | 接口健康探活、配置读取、统计数据提取 | `curl -s http://localhost:6969/api/health` |
| **`markdown`** | 完整支持 Markdown 语法（标题、表格、加粗、列表）以及嵌入的 ````mermaid` 高清矢量 SVG 流程图/时序图渲染 | 系统分析报告、指标矩阵、环境快照、架构拓扑 | 包含 ````mermaid\nflowchart LR\n  A --> B\n```` |



