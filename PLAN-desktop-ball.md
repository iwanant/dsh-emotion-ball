# 桌面球（Desktop Ball）

> 状态：**已完成并收尾**（2026-10-26 开工，当天完成）。本文件是事实记录，不再是计划。

## 它现在是什么

DSH 插件 `dsh-emotion-ball`：一颗 44×44 的桌面小球（Electron 独立窗口），跟随 DSH 的
真实工作状态换表情；单击开选择盘、右键出设置菜单、拖到哪记住哪。**页面里不再有球**。

```
DSH Host 进程（Node / 插件宿主半侧 index.js）
├── 状态机 lib/state.js
│     订阅 session/event（turn/start、turn/end、tool/call、tool/result）、agent/status
│     「等你回答」从 ask_user_question 的 tool/call ↔ tool/result 推导
│     （宿主的 user-questions/request 是 agent 作用域 waterfall，根级插件收不到）
│     → 推出 emotionId（31 接收 / 30 思考 / 32 忙碌 / 40 检索 / 36 联网 /
│       33 完成 / 34 出错 / 35 等待 / 41 停止 / 38 拒绝 + 空闲轮换）
├── 静态服务 127.0.0.1:8766（ball.html、js、/state、/manual、/theme、/focus、
│                            /badge、/emotions.json、/health、/runtime/retry）
└── apply() spawn helper ／ dispose() kill

运行时（lib/runtime.js）
└── 自备 Electron：首次启用下载 v43.3.0（npmmirror → GitHub 官方，sha256 校验，
    tar.exe 解压）到 ~/.dsh/emotion-ball-runtime/。**不借用 dsh-pet**——
    删掉 pet 球也不会报废。进度经 /state 暴露，DSH 右下角显示进度条，失败可重试。

Electron helper（helper/main.js + preload.js）
├── 透明、无边框、置顶、skipTaskbar；内容比球大 4px（透明边缘），
│   球的坐标一律按右下角推导，展开/拖动都不让球移动
├── 载入 ball.html（同一份素材，不复制）
├── 命中检测：40ms 读光标，只在球/面板上解除 setIgnoreMouseEvents
├── 单击 → 展开面板（窗口 = 面板 + 8px + 球，自动决定朝上/朝下、靠左/靠右）
├── 双击 → 用「上一次轮询到的焦点」决定：在 DSH 前台 → 最小化；否则 → 拉到最前
│   （点球本身会抢走焦点，所以不能用「此刻的前台窗口」判断）
└── 轮询 /state：平时 400ms，角标亮着时 120ms → 换表情 + 角标
```

## 行为清单

| 操作 | 结果 |
|---|---|
| 单击小球 | 展开 16 个常用表情；「全部」可切到 32 个 |
| 悬停格子 | 实时预览；面板里固定两行说明区，高度不跳 |
| 点格子 | 固定该表情（手动模式），调 `/manual?id=` |
| 「恢复自动」 | 退出手动模式 |
| 拖动小球 | 移动窗口、记住位置；压到屏幕边缘时面板会翻转/夹取，不会被挡住 |
| 双击小球 | 最小化 / 还原 / 拉起 DSH |
| 右键小球 | 眼神跟随开关、主题（跟随系统 / 深色 / 浅色） |
| 鼠标离开球和面板 | 约 0.5s 后自动收起 |
| 任务完成 / 出错 | 亮紫色「!」；只在你不看 DSH 时亮。清掉条件：在 DSH 里点/滚/打字、连续聚焦 8 秒、或开始新一轮 |
| 有问题等你回答 | 亮紫色「?」；一直亮到你回答（或回到 DSH 待满 8 秒） |

主题是双向同步的：球的菜单切主题会通过 `/theme` 请求让整个 DSH 一起切（`ctx.theme.setTheme`，
持久化到 Host 用户设置）；DSH 在别处改了主题，球也会跟着变（`/theme?report=`）。

## 结构

```
dsh-emotion-ball/
├── index.js            宿主半侧：静态服务、状态机接线、set_emotion 工具、spawn helper
├── client.js           浏览器半侧（221 行）：只剩 toolview 标记 + 主题/焦点上报
├── lib/state.js        状态机（纯逻辑，可单测）
├── helper/             Electron：main.js / preload.js
├── assets/emotion-ball/ ball.html + 引擎（来自 aora-bot，带 LICENSE/NOTICE）
├── locale/             中英文案
└── test/host-state.mjs 状态机断言（ALL PASS）
```

## 收尾时做的两件事（2026-10-26 晚）

1. **删掉客户端死代码**：`client.js` 从 1305 行降到 221 行。删掉了 store 信号机、
   选择盘、拖动、眼神跟随、`WIDGET_CSS`、`makeWidget`、`SignalsBridge`、`PickerPanel`，
   以及那个"读不到消费者却一直跑"的 250ms `setInterval`。
   顺手删掉 `test/state-machine.mjs`——它切的是这些已迁移到 `lib/state.js` 的纯函数，
   而那份逻辑由 `test/host-state.mjs` 覆盖。
2. **开发期开关收进 `--dev=1`**：`--selftest` / `--paneltest` / `--menutest` / `--probe`
   和 `input.log` 诊断写盘，只有 `--dev=1`（或 `DSH_EMOTION_BALL_DEV=1`）才生效，
   正式运行不写任何诊断文件。

## 已知取舍（写下来是为了以后别再踩）

1. **运行时要自备**：首次启用下载 138 MB 的 Electron（解压后 ≈350 MB，放在
   `~/.dsh/emotion-ball-runtime/`）。这是「删掉 dsh-pet 也不影响小球」的代价；
   不想下载可以设 `DSH_EMOTION_BALL_ELECTRON` 复用已有 Electron。
2. **常驻 PowerShell ≈ 80MB**：双击要 26ms 而不是 400ms，代价是常驻一个 PowerShell
   （默认按需启动、空闲 3 分钟退出；开了「低延迟模式」才常驻）。
   想省内存就退回按需启动，代价是首次双击慢 ~400ms。
3. **轮询架构**：400ms 轮询 `/state`、1s 轮询主题、双击借用 PowerShell 调 Win32。
   单个挂件够用，但要做多窗口/多平台就得换通道。
3. **角标「已读」的三条判定**（任一成立即清）：
   - **你在 DSH 页面里操作过**（点击 / 滚轮 / 按键）——最可靠，不依赖焦点
   - 连续聚焦 8 秒（走 Win32：helper 每秒比一次 `GetForegroundWindow()`）
   - 新一轮开始（`turns` 前进）

   注意焦点这条路在某些环境里认不出来（窗口没被判定为前台），所以不能只靠它——
   早期只按聚焦 + 重复判断，结果就是「角标得等你打字才消失」。
4. **等待回答用「?」**：由 `ask_user_question` 的 `tool/call` 触发、`tool/result` 结束；
   角标是「持续状态」而不是一次性事件（问题出现后你才关窗口，它也会亮）。
5. **`set_emotion` 工具仍在**：每次请求约 228 输入 token；不用就删，能省。

## 踩过的坑（保留备查）

- 环境里 `ELECTRON_RUN_AS_NODE=1`：spawn 前必须删掉，否则 electron.exe 退化成纯 node。
- 透明无边框窗的 `ready-to-show` 会迟到甚至不触发 → 加 `setTimeout(showInactive, 900)` 兜底。
- 根元素的背景会提升成视口画布，不吃 `border-radius` → 背景画到 `#wash` 上。
- `setPosition` 在透明无边框窗上会重套 DWM 边框，窗口越拖越大 → 尺寸钉死在一个 `targetSize` 常量。
- 拖完手时浏览器仍会补发一次 `click`，被当成单击把面板关掉 → 拖动后抑制 350ms。
- 严格模式下 `if` 块里的函数声明是块级作用域，`renderMarks` 因此 `is not defined` 打断初始化。
- 用 PowerShell 生成 JS 源码时，外层 shell 会把 `$p` / `$_` 提前展开 → 改用文件编辑工具写。
