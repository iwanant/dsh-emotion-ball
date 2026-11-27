/**
 * 「重启 DSH」的两段式启动器（纯函数，方便单独测试）。
 *
 * 为什么不能一步到位——进程树关系决定了谁能活下来（都是实测出来的）：
 *
 *   球 ──(spawn)──> restart-launcher.exe ──(WMI)──> restart-helper.exe ──> 新的 DSH
 *
 * 1. **执行体必须由 WMI 创建**：Windows 上 Electron 把子进程挂在 Job Object 里，
 *    父进程一死整段树都被收掉（实测：杀掉外层 Electron，被它 spawn 的 Electron 立刻消失）。
 *    球杀掉 DSH 之后自己也会被带走，所以执行体不能是球的子进程。
 * 2. **两段都是 winexe（GUI 子系统）**：控制台程序被 WMI 创建时，Windows 会分配一个
 *    控制台窗口 —— 用户看到的就是「点了重启，屏幕上闪一个黑框」。`/target:winexe` 后
 *    根本没有控制台可闪。编辑 `helper/*.cs` 时注意别把这条丢掉。
 * 3. **不用 powershell.exe 做第一段**：它自己就是控制台程序（会闪），而且实测被 WMI
 *    创建后跑不了脚本（`-File` / `-EncodedCommand` / `-Command "& 'x.ps1'"` 都返回 0
 *    却一行不执行）。自己写 30 行 C# 既没窗口也没这个坑，还快 300 多毫秒。
 * 4. **launcher 很薄**：它只做一次 WMI 调用，把执行体交出去，然后立刻退出。
 *    球等它退出（约 0.1 秒）再 quit，这样 WMI 调用不会被打断。
 *
 * 执行体自己的顺序见 helper/restart-helper.cs。
 */

/**
 * launcher 的命令行参数：`--helper <exe> --image <名字> --exe <路径> --log <路径> --delay 600`
 *
 * 值一律不加引号 —— spawn 传数组，Windows 的 CommandLineToArgvW 会按需处理；
 * 真正要拼成一行（交给 WMI）的是 launcher 里的 C#，那里才加引号（见 restart-launcher.cs）。
 */
function buildLauncherArgs({ helperExe, image, exe, log, delay = 600 }) {
  return [
    '--helper', helperExe,
    '--image', image,
    '--exe', exe,
    '--log', log,
    '--delay', String(delay),
  ];
}

/** 「C:\...\DeepSeek Harness.exe」→「DeepSeek Harness」 */
function imageNameOf(exe) {
  const base = String(exe).split(/[\\/]/).pop() || '';
  return base.replace(/\.exe$/i, '');
}

module.exports = { buildLauncherArgs, imageNameOf };
