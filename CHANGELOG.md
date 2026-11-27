# 更新日志

## 0.6.0

右键菜单只剩三块：**余额与峰谷 → 主题 → 重启 DSH**。「眼神跟随光标」和
「常驻加速（约 15MB）」两个开关删掉了，行为固定开启。

删的理由是这两个开关没有真正需要关的场景：

- **眼神跟随**：关掉之后球就变成死的，反而看不出它在响应 DSH；真正想让球安静的场合
  （全屏游戏、录屏）关掉跟随也没用，球还在那儿。
- **常驻加速**：它原本是给「不想多花 80MB」的人留的后路，那时常驻的是 PowerShell。
  换成 csc 编的小 exe 之后只有约 3MB，而关掉它的代价是**第一次双击多等一秒**——
  省 3MB 赔一秒不划算。焦点轮询每秒还要问它一次，按空闲退出反而会制造冷启动竞态。

连带清理：`settings` 只剩 `{ theme, lastFocus }`；`broadcastSettings()` 只发主题
（原来整个对象发过去会把 `lastFocus` 一起漏给页面）；`pushGaze()` 不再看设置；
启动预热（编译小 exe、拉起常驻进程、开始焦点轮询）改为无条件执行。

顺带修一个视觉撞车：菜单变短后「重启 DSH」的悬停底色和确认态底色是同一个
`--eb-danger-soft`，分不清「只是悬停」还是「已经进入确认态」。现在悬停只提亮字，
只有确认态才铺红底。

## 0.5.1

修好 0.5.0 的「重启 DSH」：那一版点下去只有球消失，DSH 一动不动，连日志都不生成。

三个独立的坑，全是实测出来的：

- **球不能用 `detached` 起 PowerShell。** Windows 上 `detached` 等于 `DETACHED_PROCESS`
  ——没有控制台，而 `powershell.exe` 在没有控制台时会立刻静默退出（退出码 0，一行都不
  执行），所以 `restart.log` 根本不存在。改回普通 spawn 后脚本立刻正常。
- **球一退出，它的子进程就跟着死。** 实验：A(electron) → B(electron) → PS 写 tick，
  `Stop-Process -Id <A>` 之后 3 秒 B 也没了——Electron 用 Job Object 收子进程。而流程里
  DSH 被杀的那一刻球恰好也被带走，脚本半路夭折。所以「谁去执行重启」必须跳出这棵树。
- **WMI 创建的 `powershell.exe` 跑不了脚本。** `-File`、`-EncodedCommand`、
  `-Command "& 'x.ps1'"` 三种写法全部「返回 0、进程在、脚本一行不执行」；短内联
  `-Command "Add-Content ..."` 和 `cmd.exe /c echo` 反而正常。csc 编出来的小 exe 经 WMI
  启动完全正常。

现在的结构（两段都是没有控制台的 C#）：

```
球 ──spawn──> dsh-restart-launcher.exe ──WMI──> dsh-restart-helper.exe ──> 新的 DSH
                （winexe，0.1 秒）              （winexe，杀进程 + 拉起）
```

- **没有 PowerShell 窗口了。** 两段都按 `/target:winexe` 编译（GUI 子系统）。控制台程序
  被 WMI 创建时，Windows 会给它分配一个控制台窗口——那正是「点了重启，屏幕上闪一个黑框」
  的来源。`winexe` 没有控制台可闪。顺带把 launcher 的启动时间从 ~500 ms 降到 ~100 ms。
- 新增 `helper/restart-launcher.cs`（约 100 行）：只做一次
  `ManagementClass("Win32_Process").InvokeMethod("Create", …)`，把执行体交给 WMI 服务
  （`WmiPrvSE`）创建，然后带着 WMI 的返回码退出。用 `System.Management.dll`，系统自带。
- 新增 `helper/restart-helper.cs`（约 143 行，编译后约 5.5 KB）：等 600 ms → 按镜像名杀掉
  所有 DSH 进程 → 轮询最多 15 秒等它们真的消失（没死再补一刀）→ 等 400 ms → 用同一个 exe
  重新启动。日志写 `%APPDATA%\dsh-emotion-ball-helper\restart.log`（UTF-8 追加，写日志失败
  不影响重启）。
- 新增 `helper/restart-launch.js` 取代 `helper/restart-script.js`（已删除）：纯函数
  `buildLauncherArgs()` 拼参数数组、`imageNameOf()` 推进程名。
- `helper/main.js`：把 `ensureToggleExe()` 抽成通用的
  `compileHelper(sourceName, prefix, { winexe, refs })`，`toggle-helper.cs`（控制台，要
  stdin/stdout）、`restart-launcher.cs`、`restart-helper.cs` 共用同一套「csc 编译 + 按 mtime
  换文件名 + 清理旧版本」逻辑。
- 测试换成 `test/restart-launch.mjs`（9 条断言：参数形状、C# 里确实用 WMI、两段都是
  winexe、重启路径不再出现 powershell、执行体的 枚举→杀→拉起 顺序）。
- 启动 4 秒后就把这两段 exe 预编译好（csc 约 1 秒），点「重启 DSH」时不再卡在编译上。
- 编译产物的文件名带上了子系统标记（`*-w-<mtime>.exe`）：只按源码 mtime 缓存会让早先
  编出来的**控制台版本**一直被复用，改完代码照样闪黑框。顺带编译完成后会把旧产物的
  两种命名一起清掉。
- 新增 `test/helper-subsystem.mjs`：真的用 csc 编一遍三段 C#，再读 PE 头断言
  `restart-helper` / `restart-launcher` 是 Subsystem 2（GUI）、`toggle-helper` 是 3（控制台）。
  这条测试就是为了防止「源码改了、缓存没换、黑框照旧」再次发生。
- 真机验证：假 DSH（csc 编的 `Sleep 180` 进程）+ 真 launcher / helper，
  日志 `launcher start / wmi return=0 pid=66156 / restart requested / running before kill: 1 /
  killed / relaunched pid 69928`，约 2.2 秒完成；球退出后新进程仍存活。
  两个 exe 的 PE 头 Subsystem 字段实测为 **2（GUI）**，即不可能弹出控制台窗口。

## 0.5.0

右键菜单顶部多了一块「还剩多少钱 + 现在是峰时段还是谷时段」。

- **剩余用量**：读本机 `~/.dsh/.credentials.yaml` 里的账号令牌，向 Platform 的
  `get_user_summary` 要一次余额（和 DSH 设置里「账号」那页同一个数）。令牌只在本机读、
  只发给令牌自己记录的 issuer，不经过任何第三方，也不会回传给页面。
- **峰谷时段**：按官方口径判定——北京时间周一至周五 09:00–12:00、14:00–18:00 是高峰，
  其余时间（含周末和法定节假日全天）都是空闲，空闲价是高峰价的一半。内置 2026 年
  法定节假日表；缺年份时按「只认周末」降级，不会报错。
- 两个时段用不同颜色标出：**峰 = 琥珀色**，**谷 = 青绿色**，当前时段实心高亮，
  下一行写「明天 09:00 后转峰时」这类切换提示。深浅两个主题各有一套配色。
- 点「剩余」那一行强制刷新；宿主缓存 60 秒，撞上网关抖动会退避 2 分钟再试。
  读不到就显示「—」和「点一下重试」，不影响其它功能。
- 新增 `test/pricing.mjs`（10 条时间点断言，不读本机时钟）。

右键菜单底部多了一项「重启 DSH」——DSH 卡死的时候，桌面上唯一还能动的东西就是这个小球。

- 点一下变红并变成「再点一次，确认重启」，四秒内不点第二下就自动退回；杀掉整进程不能靠误触。
- 点第二下：杀掉所有 DSH 进程 → 等进程真的消失（最多 15 秒，没死再补一刀）→ 用同一个 exe
  重新启动。杀完不立刻拉起是故意的：DSH 有单实例锁，旧进程还半死不活时启动新进程，
  新进程只会去聚焦那个正在咽气的窗口，看起来像什么都没发生。
- 这条路径不依赖宿主，所以宿主真的无响应（`/state` 都取不到）时它照样能用。
- ⚠️ 这一版的实际执行路径有缺陷，点下去只会让球消失、DSH 不动，见 0.5.1。

## 0.4.0

双击从「能感觉到的延迟」变成「按下就动」。

- **窗口操作不再经过 PowerShell**：新增 `helper/toggle-helper.cs`，首次运行时用系统自带的
  `csc.exe` 编译成约 12 KB 的小 exe 常驻（内存约 3 MB）。原来的做法是起一个 PowerShell
  进程发 `Add-Type` 命令，冷启动要 1.3 秒；现在**约 60–70 ms** 就最小化。
- 实测三种情况：可见且在前台 → 最小化 60–70 ms；被别的窗口盖住 → 置顶唤醒约 140 ms；
  最小化/托盘里 → 恢复约 215 ms（改之前同场景是 247 ms，首次甚至 3.9 秒）。
- 双击判定改为**缓存窗口句柄 + `GetWindowRect`**：不再每次调 `GetProcessesByName`——
  那个 API 在这台机器上枚举不全（6 个进程只返回 2 个、句柄全是 0），还得花 200–400 ms。
  句柄在子进程重启时自动失效重取，窗口关闭也能识别。
- 挂件进程不再因「空闲 10 分钟」被杀掉，双击永远是热的。
- PowerShell 版本保留，仅在系统没有 .NET Framework（编译失败）时回退使用；右键菜单里的
  「低延迟模式（常驻）」现在只影响这条回退路径。

## 0.3.1

修两个「知道有、但不好复现」的桌面端问题：

- **双击只闪一下、不最小化**：原来的判据是「DSH 是不是前台窗口」，但 dsh-pet 这类置顶挂件
  会一直抢走前台，DSH 明明在眼前也被判成"不在前台"，于是只做了置顶。改成用
  `WindowFromPoint` 命中 DSH 窗口中心点来判断「看不看得见」，与谁抢焦点无关。
- **面板打开时右击，球会挪 1px**：窗口坐标是整数 DIP，150% 缩放下 `657 × 1.5 = 985.5`
  被系统进位成 986，读回来就成了 658。现在设完窗口读回实测球的位置、差多少补多少，
  并记住球的基准位置，反复开合不再累积漂移。
- 内部：页面加了 `__EB_COLLAPSE` 钩子，新增 `--ctxmenutest=1` 自检模式（验证整圈零位移）。

## 0.3.0

**不再依赖 dsh-pet。** 之前球借用 `~/.dsh/electron/electron.exe`（那是 dsh-pet 装的），
删掉 dsh-pet 球就报废。现在插件**自己下载并持有**运行时：

- 首次启用从 npmmirror（失败切官方 GitHub）下载 Electron v43.3.0（约 138 MB）
- 下载后比对 `SHASUMS256.txt` 的 sha256，再用系统自带 `tar.exe` 解压
- 存在 `~/.dsh/emotion-ball-runtime/`，此后只认自己这份
- 下载进度显示在 DSH 窗口右下角，失败可点重试
- 想复用已有 Electron 可设 `DSH_EMOTION_BALL_ELECTRON`

其它改动：

- **双击语义修正**：DSH 看得见（在前台）→ 最小化；看不见（被盖住 / 最小化 / 在托盘）
  → 拉到最前面。之前"可见但被遮住"也会被最小化，得点两次
- 拉到前台时用 `AttachThreadInput` + ALT 键 + `SwitchToThisWindow` 绕过 Windows 前台锁
- PowerShell 改为**按需启动**（默认不常驻），3 分钟空闲退出；右键可开「低延迟模式」常驻
- 修复页面"防闪烁"逻辑：双击的第二下会取消待定的单击，面板不再闪一下
- 修复 `lib/state.js` 注入的 `random` 未被使用（测试此前是碰运气通过）
- 新增 `test/html-scripts.mjs`：改页面后先检查内联脚本语法

## 0.2.0

- 桌面球（Electron 独立窗口）：透明置顶、拖动记忆位置、鼠标穿透 + 命中检测
- 情绪选择盘搬进桌面球（16 常用 / 32 全量），面板自动选展开方向，贴边不裁切
- 状态机搬到宿主侧（`lib/state.js`），从 `session/event` 推出真实工作状态
- 主题双向同步（球 ↔ 整个 DSH）
- 任务完成 / 出错 / 等待回答时右上角亮角标（`!` / `?`），你回到 DSH 就自动消失
- 页面里的球撤掉，只保留对话里的极轻 toolview 标记
