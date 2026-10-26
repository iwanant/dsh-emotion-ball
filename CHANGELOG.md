# 更新日志

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
