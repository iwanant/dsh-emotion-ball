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
├── 双击 → 用「窗口中心点被谁占住」决定：还是 DSH → 最小化；被别的窗口占住 → 拉到最前
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
| 右键小球 | 剩余用量 + 峰/谷时段、主题（跟随系统 / 深色 / 浅色）、重启 DSH |
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
- 判「窗口在不在前台」不能用来决定双击方向：dsh-pet 这类置顶挂件会一直抢走前台，
  DSH 明明在你眼前也会被判成「不在前台」，于是双击只置前不最小化（表现为标题栏闪一下）。
  改用 WindowFromPoint 命中 DSH 窗口中心点来判断「看不看得见」。
- 窗口坐标是**整数 DIP**：150% 缩放下 657 DIP = 985.5 物理像素，系统进位成 986，读回来变 658。
  所以「面板 → 菜单」切换会让球挪 1px；吸附坐标治不了（反而变成 2px）。
  正解是设完窗口**读回实测球的位置、差多少补多少**，并记住球的基准位置（`ballAnchor`），
  反复开合不累积。自检：`--ctxmenutest=1` 应输出 `cycleStable: true`。

## 双击延迟：把 PowerShell 换成系统自带 csc 编译的小 exe（0.4.0）

问题：双击球之后 DSH 要愣一下才动。实测冷启动 3966ms、热启动 247ms。

拆开看，慢的不是 Win32 调用，是「起一个 PowerShell 进程」这件事本身：

| 环节 | 耗时 |
|---|---|
| PowerShell 空启动 | 594ms |
| 里面再 `Add-Type` 编译 C# | +891ms |
| `GetProcessesByName` 找 DSH 窗口 | 200–400ms |
| 真正的 ShowWindow / SetForegroundWindow | 个位数 ms |

三个决定：

1. **不再用 PowerShell**。新增 `helper/toggle-helper.cs`，首次运行时调用系统自带的
   `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 现场编译成约 12KB 的
   `toggle-helper.exe`（带版本号命名，重新编译不会撞上正在运行的旧文件），之后常驻。
   内存约 3MB，比 PowerShell 的 73MB 更省。协议不变：stdin 发 `focus` / `toggle` / `show`，
   stdout 回 `focus=0|1` / `ok minimize|raise|none`，所以 main.js 那侧的改动很小。
2. **缓存窗口句柄**。`GetProcessesByName("DeepSeek Harness")` 在这台机器上枚举不全
   （6 个进程只返回 2 个、`MainWindowHandle` 全是 0），改用 `EnumWindows` + 
   `GetWindowThreadProcessId` 一次找出真正的 DSH 窗口，然后缓存句柄；子进程重启时
   句柄自动失效重取，窗口关闭也能识别。
3. **双击的占位角标删了**。原来冷启动要 300–400ms，怕用户以为没点上，会先闪一个「…」。
   现在 60ms 就完成，那个占位反而变成噪音。

结果：最小化 60–70ms，被遮挡时置顶唤醒约 140ms，托盘恢复约 215ms。

教训：**先测再优化**。一开始猜是 `SetForegroundWindow` 被 Windows 前台锁拦住，
差点去写 `AttachThreadInput` 那套偏方；实际掐完时间发现真正的大头是「起进程」，
换掉进程模型就一步到位了。
## 右键菜单加余额 + 峰谷时段（0.5.0）

需求：右键菜单里想知道「还剩多少钱」，以及现在算高峰还是空闲（价格差一倍）。

1. **数据从哪来**。先试了 API key 那条路（`api.deepseek.com/user/balance` + `Bearer sk-...`），
   直接 401——DSH 默认是账号登录，本地没有能查余额的 key 权限。翻 asar 发现 DSH 自己走的是
   Platform 的 `/api/v0/users/get_user_summary`，请求头 `x-dsh-auth-token`，令牌就存在
   `~/.dsh/.credentials.yaml` 的 `deepseek-account-platform/default` 记录里。
   于是插件直接读这个令牌、直接请求同一个接口，取 `normal_wallets` + `bonus_wallets`。
   令牌只发给记录里自己的 `issuer`，不回传页面、不发第三方。
2. **峰谷口径**（官方定价页，2026-11）：北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，
   其余时段（含周末、法定节假日全天）为空闲，空闲价 = 高峰价 × 0.5。
   注意「调休上班的周末」不用特殊处理——官方口径就是周末全天空闲。
3. **不依赖本机时区**。用固定 `+08:00` 偏移换算北京时间，不走 `Intl`（这台机器的 Node 可能是
   small-icu，`toLocaleString` 会直接抛错）。节假日表按国务院 2025-11-04 的 2026 年通知录入，
   缺年份时降级成「只认周末」。
4. **界面**：菜单顶部一行「剩余 ¥9.83」（点一下强制刷新），下面两枚药丸——琥珀色「峰·全价」
   与青绿色「谷·5折」，当前时段实心高亮，第三行写「明天 09:00 后转峰时」。
   颜色不共用别处的令牌，浅色主题单独压暗一档。
5. **缓存**：宿主 60 秒缓存 + 失败退避 2 分钟；菜单打开时才拉，不常驻轮询。

坑：`.credentials.yaml` 是缩进 YAML，没有依赖可用的解析器，只能按「记录块缩进回到 2 格即结束」
手写扫描；另外 `total_costs` 里用的是 `amount` 字段而不是 `balance`，一开始读错了值，累计消费
一直是 0。

## 右键菜单加「重启 DSH」（0.5.0）

需求来源很具体：**DSH 会卡死，而卡死的时候球还活着**。界面里的按钮、快捷键、托盘图标全在
DSH 进程里，一起死了；球是独立进程，宿主不响应它照样在桌面上转。那它就该是那个能动手的人。

1. **两步确认**。杀进程不能靠误触：第一下只把这一项变红、改成「再点一次，确认重启」并起
   4 秒计时，第二下才真执行。
2. **顺序是核心**：等 600ms → 杀掉所有同名进程 → 轮询等它们真的消失（最多 15s，没死再补一刀）
   → 再启动同一个 exe。中间那步不能省：DSH 有单实例锁，旧进程没死透时拉起新的，新进程只会
   去聚焦那个正在咽气的窗口，用户看到的是"没反应"——和 0.3.1 踩过的双击判错方向是同一类错觉。
3. **按镜像名杀，不按 PID**。卡死时通常是一整窝（主进程 + 渲染 + GPU 都是同一个 exe），
   只杀一个，剩下的会接管窗口。名字从 `--dsh-exe` 的 basename 推出来，不写死。
4. **不依赖宿主**。菜单是本地页面 + IPC 到球自己的主进程，宿主挂了这条路径照样通——
   这正是它存在的理由。

### 第一版为什么"点了没反应"（三个坑，全是实测）

第一版是「球 `detached` 起一个 PowerShell 脚本，150ms 后自己退出」。用户点下去的实际表现是
**球消失了、DSH 一动不动、连日志文件都没生成**。逐条排除后得到三个独立的坑：

1. **`detached: true` 在 Windows 上等于 `DETACHED_PROCESS`（没有控制台）**，而
   `powershell.exe` 在没有控制台时会立刻静默退出——退出码 0，一行都不执行。所以
   `restart.log` 根本不存在。去掉 `detached` 后脚本立刻正常跑。
2. **球一退出，它的子进程就跟着死**。实验：A(electron) → B(electron) → PS 写 tick，
   `Stop-Process -Id <A>` 之后 3 秒，B 也没了，tick 停在第 27 行——Electron 用 Job Object
   收子进程。而重启流程里 DSH 被杀时，球恰好也在这一刻被带走，于是脚本半路夭折。
3. **WMI 创建的 `powershell.exe` 跑不了脚本**。`-File`、`-EncodedCommand`、
   `-Command "& 'x.ps1'"` 三种写法全部「返回 0、进程在、脚本一行不执行」；
   但极短的内联 `-Command "Add-Content ..."`、`cmd.exe /c echo` 反而正常。
   csc 编出来的小 exe 经 WMI 启动则完全正常。

### 第二版为什么"屏幕上闪一个黑框"（winexe）

第一版修好之后功能是通的，但用户立刻反馈：**重启的时候会跳出一个 PowerShell 窗口**。原因
不是 `-WindowStyle Hidden` 没写，而是两段进程本身都是控制台程序：

1. **被 WMI 创建的控制台程序一定会拿到一个控制台窗口。** `Win32_Process.Create` 没有
   `CREATE_NO_WINDOW` 这类启动标志可传，所以只要 PE 头的 Subsystem 是 3（console），
   Windows 就替它 new 一个控制台 —— 用户看到的就是一闪而过的黑框。
2. 解决办法是 `/target:winexe`（Subsystem 2 = GUI）。`winexe` 进程没有控制台可用，
   不打印、不闪；用 `Process.Start` 或 `spawn` 拉起它也不会带出窗口。
   两个 exe 的 PE 头实测都是 2，可以写进断言。
3. **顺手把 PowerShell 整个换掉**：第一段原先靠 `powershell.exe -Command` 做一次 WMI 调用。
   它自己就是控制台程序（会闪），也不能省掉那层。改成一个 100 行的
   `restart-launcher.cs`（`ManagementClass("Win32_Process").InvokeMethod("Create", …)`），
   启动从 ~500ms 掉到 ~100ms，链路上再没有任何解释器。
4. 为什么 `toggle-helper.cs` 还是控制台程序？因为它要跟球走 stdin/stdout 管道通信，
   而球 spawn 它时带了 `windowsHide: true`（Node 会传 `CREATE_NO_WINDOW`），所以不闪。
   **重启这两段不同**：它们由 WMI 创建，拿不到这个标志，只能靠 winexe。

### 最终结构

```
球 ──spawn──> dsh-restart-launcher.exe ──WMI──> dsh-restart-helper.exe ──> 新的 DSH
               （winexe，约 100ms）              （winexe）
```

- launcher 只做一件事：用 `ManagementClass("Win32_Process").InvokeMethod("Create", …)` 把
  执行体交给 WMI 创建，然后带 WMI 的返回码退出。球在 launcher 退出后 `app.quit()`。
- 执行体是 C#（`helper/restart-helper.cs`，编译后约 5.5 KB）：
  等 600ms → `Process.GetProcessesByName(image)` 逐个 `Kill()` → 轮询 15s 等消失 →
  再补一刀 → 等 400ms → `ProcessStartInfo` 重新拉起同一个 exe。日志 UTF-8 追加到
  `%APPDATA%\dsh-emotion-ball-helper\restart.log`，写日志失败不影响重启本身。
- WMI 创建出来的进程不属于球的进程树，所以球（以及 DSH）怎么死都不牵连它。

坑：参数拼装如果内联在 `main.js` 里就没法单独验证，于是拆成 `helper/restart-launch.js`
（纯函数 `buildLauncherArgs()` / `imageNameOf()`）。`test/restart-launch.mjs` 顺手把
「两段都必须是 winexe」「重启路径不许再出现 powershell」也钉成断言——这类回归不会报错，
只会让黑框悄悄回来。

### 第三个坑：改了代码，黑框还在（编译缓存）

改成 winexe 之后用户仍然报「重启还是会闪一个 PowerShell 窗口」。查 PE 头才看清：
`dsh-restart-launcher.exe` 已经是 Subsystem 2，但 `dsh-restart-helper.exe` 还是 **3**——
那一份是加 `winexe` 之前编出来的，而 `compileHelper` 的文件名只带源码 mtime：

```js
const target = path.join(app.getPath('userData'), `${prefix}-${stamp}.exe`);
if (fs.existsSync(target)) return target;   // ← 源码没改就一直复用旧产物
```

`restart-helper.cs` 的内容没变，mtime 没变，于是旧的控制台产物永远是「缓存命中」，
`/target:winexe` 根本没机会生效。黑框是**执行体自己**弹出来的，不是 launcher。

改法两件：
1. 文件名带上子系统标记 `${prefix}${opts.winexe ? '-w' : ''}-${stamp}.exe`，清理旧产物的
   正则同时匹配两种命名（`^prefix(-w)?-\d+\.exe$`）。缓存键必须覆盖「所有会改变产物的输入」，
   编译选项也算输入。
2. 加 `test/helper-subsystem.mjs`：真的调一次 csc 编出三段 exe，读 PE 头的 Subsystem 字段
   断言 2/2/3。这条测试的意义是——「源码里写了 `/target:winexe`」这种自证毫无价值，
   只有产物才能证明没有控制台窗口。

## 删掉两个开关，改成固定常开（0.6.0）

用户说：「把右键菜单栏里面的眼神跟随光标和常驻加速选项删掉吧，改成一直这样的」。

删理由不是嫌多，是**这两个开关没有真正需要关的场景**：

- **眼神跟随**：只有一种情况会关它——嫌烦。但关掉之后球变成死的，反而更难看出它在响应；
  而真正想让球安静的场合（全屏游戏、录屏），关掉跟随并不会让球消失，意义不大。
- **常驻加速**：这个开关原本是给「不想多花 80MB 内存」的人留的后路（那时常驻的是 PowerShell）。
  换成 `csc` 编的小 exe 之后只有约 3MB，而**关掉它的代价是第一次双击要多等一秒**——
  一个「省 3MB、赔一秒」的选项本身就是坏选项。更何况焦点轮询每秒都要问它一次，
  真按空闲退出反而会制造冷启动竞态。

代码上的连带清理（开关一词渗透得比想象中深）：

1. `ball.html`：删两个 `<button class="mi" data-act="gaze|lowlatency">`，`renderMarks()`
   少两个勾选分支，click 处理只剩 `theme` / `restart`。
2. `helper/main.js`：`settings` 只剩 `{ theme, lastFocus }`；`broadcastSettings()` 只发主题
   （原来整个对象发过去，会把 `lastFocus` 一起漏给页面）；`pushGaze()` 去掉 `settings.gaze` 判断；
   启动预热块去掉 `if (!settings.lowLatency) return;`，改成无条件执行。
3. `preload.js` / `client.js` 不用动：它们只转发键值，不校验存在哪些开关。

顺带撞出一个视觉 bug：菜单变短后截图时鼠标正好停在「重启 DSH」上，`.mi.danger:hover`
和 `.mi.danger[data-step="confirm"]` 用的是同一个 `--eb-danger-soft` 底色，截图里根本分不清
「只是悬停」还是「已经进入确认态」。改成 hover 只 `filter: brightness(1.25)` 提亮字，
只有确认态才铺红底——悬停和已武装必须是两种造型。
