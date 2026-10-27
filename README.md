# dsh-cua-pill

> 屏幕顶部的玻璃胶囊，实时告诉你「AI 现在正在操控电脑做什么」。

一个 **MCP stdio 代理 + Electron 悬浮层**。它插在 MCP 客户端和 Computer Use 服务端之间，
监听 `tools/call` 流量，把每一次点击/输入/读屏映射成中文动作文案，用一个磨砂玻璃胶囊显示在屏幕顶部中央。
一旦工具调用全部返回，胶囊在 6 秒后自动淡出。

```
        ┌──────────────────────────────────────────────────────────┐
        │  ● AI 正在操控电脑  │  正在点击 · 微信 - 主窗口            │
        └──────────────────────────────────────────────────────────┘
```

## 特性

- **零侵入**：纯 stdio 转发，不改动 MCP 客户端和服务端的任何一行
- **按需唤醒**：Electron 只在第一次工具调用时才启动，空闲时完全不驻留
- **点击穿透**：`setIgnoreMouseEvents` + `focusable: false`，鼠标直接穿过去点到下面，也不抢焦点
- **本地回环通道**：胶囊与代理通过 `127.0.0.1` 随机端口 + 一次性 token 通信，不用全局 socket
- **崩溃隔离**：胶囊崩了不影响后续工具调用；代理退出会带走胶囊进程
- **14 种动作文案**：参考后端 `tools/list` 返回 14 个工具，翻译表与它逐个对应，无遗漏无冗余

## 工作原理

```
MCP 客户端 ──stdio JSON-RPC──▶ proxy.mjs ──stdio JSON-RPC──▶ Computer Use 服务端
                                    │
                                    │ 解析 tools/call / 响应 id
                                    ▼
                            127.0.0.1:<随机端口>  (一行 token 鉴权)
                                    ▼
                            pill/main.mjs  (Electron)
                                    ▼
                            pill/index.html (玻璃胶囊)
```

`proxy.mjs` **绝不向 stdout 写任何日志**——stdout 是 JSON-RPC 通道，一个多余字节就会让客户端解析失败。
所有诊断信息走 stderr。

## 目录结构

```
proxy.mjs                  MCP 代理 + 胶囊生命周期管理
pill/
  main.mjs                 Electron 主进程：窗口 / 多显示器 / IPC
  preload.mjs              contextBridge，只暴露 on() 和 hidden()
  index.html               胶囊 UI（纯 CSS，无框架）
bin/                       你自己的服务端二进制放这里（不入库）
cordis.patch.yml.example   插件挂载模板
```

## 安装

```bash
git clone <本仓库地址>      # 用 GitHub 页面上 Code 按钮给的地址
cd dsh-cua-pill
npm install          # 拉 Electron 运行时，约 370 MB
```

> 只想要代理、不要胶囊的话，**可以跳过 `npm install`**——`proxy.mjs` 零依赖，
> 缺 Electron 时只是不弹胶囊，MCP 转发照常工作（配 `CUA_PILL=0` 更干脆）。

然后：

```bash
cp cordis.patch.yml.example cordis.patch.yml
```

编辑 `cordis.patch.yml`，替换三个占位符：

| 占位符 | 填什么 |
|---|---|
| `<PATH_TO_DSH_EXE>` | 一个**能当 Node 跑**的可执行文件绝对路径。它是启动 `proxy.mjs` 的解释器，不是 MCP 宿主——通常是 Electron 应用的 `.exe`（配 `ELECTRON_RUN_AS_NODE=1` 后行为等同 node），也可以直接填系统的 `node.exe` |
| `<PLUGIN_DIR>` | 本仓库克隆到的绝对路径 |
| `<CUA_SERVER_EXE>` | 你的 Computer Use 服务端可执行文件绝对路径 |

挂载并重启宿主：

```bash
dsh plugin --profile desktop add file:<PLUGIN_DIR>
```

> `dsh` 是 DeepSeek Harness 的 CLI。这个插件是为它写的，但 `proxy.mjs` 本身对任何
> 能启动 stdio MCP server 的宿主都通用——只要宿主肯给这个进程一对 stdin/stdout。

## 验证

重启后让宿主随便执行一个 CUA 动作（例如「读一下当前窗口」），屏幕顶部中央应该出现胶囊，
并在最后一个调用返回 6 秒后淡出。

没出现就按顺序排查：

1. 宿主日志里搜 `[cua-pill]` 开头的 stderr 行
2. 用 `CUA_PILL_DEBUG=1` 重挂载，看胶囊进程自己的日志
3. 确认找得到 Electron：先看 `node_modules/electron/dist/electron.exe`，找不到会退到
   `~/.dsh/plugin-packages/dsh-cua-pill/node_modules/electron/...`；两处都没有就只跑代理、不弹胶囊
4. 想确认纯代理链路，先 `CUA_PILL=0` 关掉胶囊排除干扰

## Backend（必读）

**本仓库不包含任何服务端二进制。**

`bin/` 里没有任何二进制（只有占位文件和一份说明）。代理需要一个说 **stdio JSON-RPC 2.0** 的 Computer Use 服务端，
实现以下工具即可被完整驱动：

```
list_apps  list_windows  get_window  launch_app  activate_window
get_window_state  click  drag  scroll  press_key  type_text
set_value  perform_secondary_action  run_steps
```

服务端查找顺序：

1. `CUA_SERVER` 环境变量
2. `bin/<CUA_SERVER_NAME>`（默认 `cua-server.exe`）
3. 已装在某款 IDE 安装目录下的自带后端（互操作性探测）

> **关于第三方后端**
>
> 参考实现来自某款商业 IDE 自带的 Computer Use 组件，闭源且由该厂商独立授权。
> 本项目**不打包、不分发、不镜像**该组件，仓库里只有我自己写的代理和胶囊。
> 你要么使用自己合法持有的副本，要么用 UI Automation / pyautogui 写一个
> （协议要求见 `bin/README.md`）——`proxy.mjs` 不关心后端是谁写的。

## 配置项

全部通过环境变量覆盖，都有默认值：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CUA_LABEL` | `AI 正在操控电脑` | 胶囊左侧文案，随便改 |
| `CUA_SERVER` | — | 服务端可执行文件绝对路径 |
| `CUA_SERVER_NAME` | `cua-server.exe` | `bin/` 下查找的文件名 |
| `CUA_PILL` | `1` | 设为 `0` 关掉胶囊，只留纯代理 |
| `CUA_GRACE_MS` | `6000` | 最后一个调用返回后，胶囊停留多久再淡出 |
| `CUA_WATCHDOG_MS` | `180000` | 单次调用超时兜底，防止胶囊永久卡住 |
| `CUA_PILL_DEBUG` | `0` | 设为 `1` 输出胶囊进程的 stderr |

## 改文案

动作文案在 `proxy.mjs` 的 `TOOL_TEXT` 表里，直接改中文即可（搜索这个常量名定位）。
胶囊外观全部在 `pill/index.html` 的 `<style>` 里，无外部依赖、无框架；配色集中在 `#pill`
及其伪元素那几组 `rgba()`，改透明度/色相就是改那几个值。

## 已知限制

- **只在 Windows 上验证过**：代码里 `windowsHide` 等选项在别的平台会被忽略，但没人测过；
  后端二进制本身也是 Windows 的，macOS/Linux 要自己解决后端
- `screen-saver` 层级的置顶在部分全屏独占游戏里会被覆盖
- 胶囊固定在主显示器顶部中央，多屏不同缩放比时可能偏移一两像素

## License

[MIT](LICENSE) © 2026 AT0

仅覆盖本仓库自有的源码。任何第三方服务端、IDE 或组件都不在其中，
它们各自适用自己的许可条款。
