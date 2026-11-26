/**
 * 「重启 DSH」的 PowerShell 脚本生成器（纯函数，方便单独测试）。
 *
 * 为什么要把步骤写成脚本、而不是球自己一步步做：球杀掉 DSH 之后宿主就没了，
 * 球本身也该退场，没人能接着做「等进程死透 → 再拉起」这后半段。把整段交给一个
 * detached 的 PowerShell 进程，球点完就走，重启照样能走完。
 *
 * 顺序不能改：
 *   1. 先等 600ms —— 让球把「正在重启」的画面画完、把自己的 IPC 回完；
 *   2. 杀掉所有同名进程 —— 卡死时往往是一整窝（主进程 + 渲染 + GPU），只杀一个
 *      剩下的会接管窗口，看起来像没重启；
 *   3. 等进程真的消失（最多 15s），再兜底强杀一次 —— DSH 有单实例锁，旧进程没死透
 *      时拉起新的，新进程只会去「聚焦」那个正在咽气的窗口，用户会以为没反应；
 *   4. 最后才 Start-Process 同一个 exe。
 *
 * 脚本内容保持纯 ASCII：PowerShell 5.1 的 -File 对 UTF-8 无 BOM 的中文会乱码，
 * 日志里出现乱码反而干扰排查。
 */

/** PowerShell 单引号字符串里的 ' 要写成 '' */
function quote(text) {
  return String(text).replace(/'/g, "''");
}

function buildRestartScript({ exe, image, log }) {
  const lines = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$exe = '${quote(exe)}'`,
    `$name = '${quote(image)}'`,
    `$log = '${quote(log)}'`,
    'function Note($m) {',
    '  try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("s") + " " + $m) } catch {}',
    '}',
    'Note "restart requested"',
    'Start-Sleep -Milliseconds 600',
    '$before = @(Get-Process -Name $name)',
    'Note ("running before kill: " + $before.Count)',
    'foreach ($p in $before) { try { $p.Kill() } catch { Note ("kill failed: " + $p.Id) } }',
    '$gone = $false',
    'for ($i = 0; $i -lt 150; $i++) {',
    '  Start-Sleep -Milliseconds 100',
    '  if (-not (Get-Process -Name $name)) { $gone = $true; break }',
    '}',
    'if (-not $gone) {',
    '  Note "still alive after 15s, sweeping again"',
    '  foreach ($p in @(Get-Process -Name $name)) { try { $p.Kill() } catch {} }',
    '  Start-Sleep -Milliseconds 800',
    '}',
    'Note "killed"',
    'Start-Sleep -Milliseconds 500',
    'try {',
    '  Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)',
    '  Note ("relaunched " + $exe)',
    '} catch {',
    '  Note ("relaunch failed: " + $_.Exception.Message)',
    '}',
  ];
  return lines.join('\n');
}

/** 「C:\...\DeepSeek Harness.exe」→「DeepSeek Harness」 */
function imageNameOf(exe) {
  const base = String(exe).split(/[\\/]/).pop() || '';
  return base.replace(/\.exe$/i, '');
}

module.exports = { buildRestartScript, imageNameOf };
