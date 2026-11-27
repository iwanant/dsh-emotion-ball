/**
 * 桌面球 —— Electron 主进程
 * 由 DSH 宿主侧的插件拉起（apply 时 spawn、dispose 时 kill），所以：
 *   插件在 → 球在；插件禁用 / DSH 托盘退出 → 球消失。没有开机自启，也没有孤儿进程。
 * 窗口形态：无边框、透明、置顶、不进任务栏，44×44；内容直接加载宿主静态服务上的 ball.html；状态轮询 /state（400ms）。
 * 为什么轮询而不是 IPC：Electron 主进程读不到 piped stdin（electron#4218），
 * 而 DSH 宿主和这个 helper 是两个进程。轮询一个本地 400ms 的接口最省事、也最好排错。 */
const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildLauncherArgs, imageNameOf } = require('./restart-launch.js');

const PORT = 8766;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BALL_SIZE = 44;
const POLL_MS = 400;
/** 角标亮着时用的快速轮询间隔：让「回答完就消失」几乎是即时的。 */
const BADGE_POLL_MS = 120;

/* 透明窗口 + 软件渲染最稳：某些会话（远程桌面、无独显、被注入的渲染进程）
   下开 GPU 合成会抛 UnknownVizError，透明窗口直接变黑块。 */
app.disableHardwareAcceleration();

/** --key=value 形式的参数 */
const args = new Map(
  process.argv
    .filter((item) => item.startsWith('--') && item.includes('='))
    .map((item) => {
      const index = item.indexOf('=');
      return [item.slice(2, index), item.slice(index + 1)];
    }),
);

/**
 * 开发期开关：只有显式 --dev=1（或环境变量 DSH_EMOTION_BALL_DEV=1）才启用
 * 自检模式、探针截图和 input.log 诊断写盘。正常运行时这些一律不生效，免得把调试用的东西留在正式运行里。 */
const DEV_MODE = args.get('dev') === '1' || process.env.DSH_EMOTION_BALL_DEV === '1';

const probePath = DEV_MODE ? args.get('probe') || null : null;
const forcedTheme = args.get('theme') || null;
const dshExe = args.get('dsh-exe') || null;

let win = null;
let pollTimer = null;
/** 轮询代次：重启轮询时让旧的 tick 自行退出。 */
let pollGeneration = 0;
let lastEmotion = null;
let positionFile = null;
let dragState = null;
/** 展开状态与面板尺寸（CSS px），窗口 = 球 + 面板 的并集。 */
let expanded = false;
let panelSize = { width: 268, height: 380 };
let ignoringMouse = null;
let hitTimer = null;
let leaveTimer = null;
/** 目标窗口尺寸（CSS/DIP）：展开和拖动都写这个常量，避免 DPI 换算来回漂移。 */
let targetSize = { width: BALL_SIZE, height: BALL_SIZE };
/** 展开方向：球在下方时内容朝上（up），球在上方时内容朝下（down）。 */
let layout = 'up';
/** 球的基准位置（DIP）。所有展开/收起都从它算，避免反复推导时逐次漂移。 */
let ballAnchor = null;
/** 水平锚点：right = 球在窗口右边（面板朝左展开），left = 翻到另一侧。 */
let panelAlign = 'right';

/** 用户设置：只剩主题偏好（眼神跟随和常驻加速已经固定开启）。存 userData/settings.json。 */
let settings = { theme: 'auto', lastFocus: null };
let settingsFile = null;
const GAZE_RADIUS = 260;

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      settings = {
        theme: parsed.theme === 'dark' || parsed.theme === 'light' ? parsed.theme : 'auto',
        lastFocus: typeof parsed.lastFocus === 'boolean' ? parsed.lastFocus : null,
      };
    }
  } catch {
    /* 首次运行没有文件 */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
  } catch {
    /* 忽略 */
  }
}

function broadcastSettings() {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('ball:settings', { theme: settings.theme });
    } catch {
      /* 忽略 */
    }
  }
}

function themeName() {
  if (forcedTheme === 'dark' || forcedTheme === 'light') return forcedTheme;
  if (settings.theme === 'dark' || settings.theme === 'light') return settings.theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function ballUrl() {
  return `${ORIGIN}/ball.html?surface=desktop&theme=${themeName()}&v=11`;
}

function readPosition() {
  try {
    const raw = fs.readFileSync(positionFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return { x: parsed.x, y: parsed.y };
  } catch {
    /* 首次运行没有文件 */
  }
  return null;
}

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - BALL_SIZE - 14),
    y: Math.round(area.y + area.height - BALL_SIZE - 96),
  };
}

function clampToDisplays(point, size) {
  const box = size || { width: BALL_SIZE, height: BALL_SIZE };
  const displays = screen.getAllDisplays();
  const inside = displays.some((display) => {
    const area = display.workArea;
    return (
      point.x + box.width > area.x &&
      point.x < area.x + area.width &&
      point.y + box.height > area.y &&
      point.y < area.y + area.height
    );
  });
  if (inside) return point;
  /* 整个窗口跑到显示器之外：夹回主屏，别瞬移回默认点 */
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(Math.min(Math.max(area.x, point.x), area.x + area.width - box.width)),
    y: Math.round(Math.min(Math.max(area.y, point.y), area.y + area.height - box.height)),
  };
}

/**
 * 把窗口坐标对齐到「乘缩放比之后是整数」的网格。
 *
 * Electron 的 content bounds 是整数 DIP：150% 缩放下 657 DIP = 985.5 物理像素，
 * 系统会进位成 986 → 读回来变成 658 DIP，于是球每次切换面板都挪 1px。
 * 做法：把缩放比写成分数 p/q（1.5 = 3/2），要求坐标是 q 的整数倍，物理像素就一定是整数。
 */
/**
 * 把窗口放到「球正好落在 ball（球左上角）」的位置。
 *
 * 不跟 DPI 取整硬碰：设完窗读回一次，量出球实际落在哪，差多少补多少。
 * 150% 缩放下 657 DIP 会被系统进位成 986 物理像素（= 658 DIP），
 * 这种偏差补一次就归位，而且是幂等的——反复展开/收起不会累积。
 */
function placeWindowForBall(ball, width, height, vertical, align) {
  if (!win || win.isDestroyed() || !ball) return;
  const boxWidth = Math.max(BALL_SIZE, width);
  const boxHeight = Math.max(BALL_SIZE, height);
  const compute = (anchor, w, h) => {
    const x = align === 'left' ? anchor.x : anchor.x + BALL_SIZE - w;
    const y = vertical === 'up' ? anchor.y + BALL_SIZE - h : anchor.y;
    return { x: Math.round(x), y: Math.round(y) };
  };
  const actual = () => {
    const b = win.getContentBounds();
    return {
      x: panelAlign === 'left' ? b.x : b.x + b.width - BALL_SIZE,
      y: layout === 'up' ? b.y + b.height - BALL_SIZE : b.y,
    };
  };

  const first = compute(ball, boxWidth, boxHeight);
  win.setContentBounds({ x: first.x, y: first.y, width: boxWidth, height: boxHeight });

  const got = actual();
  const dx = got.x - ball.x;
  const dy = got.y - ball.y;
  if (dx || dy) {
    const second = compute(
      { x: ball.x, y: ball.y },
      boxWidth,
      boxHeight,
    );
    win.setContentBounds({ x: second.x - dx, y: second.y - dy, width: boxWidth, height: boxHeight });
  }
}

function coordinateStep(scale) {
  const value = scale && scale > 1 ? scale : 1;
  for (let q = 1; q <= 8; q += 1) {
    if (Math.abs(value * q - Math.round(value * q)) < 1e-6) return q;
  }
  return 1;
}

/** 把坐标吸附到最近的合法网格点（保持整数 DIP）。 */
function snapToPixels(value, scale) {
  const q = coordinateStep(scale);
  if (q <= 1) return Math.round(value);
  return Math.round(value / q) * q;
}

/** 指定位置所在显示器的缩放比。 */
function displayScale(x, y) {
  try {
    return screen.getDisplayNearestPoint({ x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) }).scaleFactor || 1;
  } catch {
    return 1;
  }
}

function ballPosition() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getContentBounds();
  /* 窗口内容比球大出一点（透明窗的边缘），球在页面里是靠右下角对齐的，
     所以收起时也不能直接拿窗口原点当球的位置，否则展开会偏几个像素。 */
  return {
    x: Math.round(panelAlign === 'left' ? bounds.x : bounds.x + bounds.width - BALL_SIZE),
    y: Math.round(layout === 'up' ? bounds.y + bounds.height - BALL_SIZE : bounds.y),
  };
}

function savePosition(point) {
  try {
    fs.writeFileSync(positionFile, JSON.stringify({ x: point.x, y: point.y }));
  } catch {
    /* 写不了就只在本次会话里记着 */
  }
}

async function applyEmotion(emotionId) {
  if (!win || win.isDestroyed() || !emotionId) return;
  if (emotionId === lastEmotion) return;
  lastEmotion = emotionId;
  try {
    await win.webContents.executeJavaScript(
      `window.__EB_SET && window.__EB_SET(${JSON.stringify(String(emotionId))})`,
      true,
    );
  } catch {
    /* 页面还没就绪，下一次轮询会补上 */
  }
}

function fetchState() {
  return new Promise((resolve) => {
    const request = require('node:http').get(
      `${ORIGIN}/state`,
      { timeout: 900 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
  });
}

function startPolling() {
  stopPolling();
  const generation = pollGeneration;
  const startedAt = Date.now();
  let failures = 0;
  let seenOk = false;

  /*
   * 自适应节奏：平时 400ms 够用；角标亮着时降到 120ms。
   * 你回答完问题，helper 要等下一拍才知道 pending 结束——
   * 之前那 400ms 的一拍就是「角标消失有点延迟」的来源。
   */
  const tick = async () => {
    if (generation !== pollGeneration) return;
    const state = await fetchState();
    if (generation !== pollGeneration) return;
    if (state) {
      failures = 0;
      seenOk = true;
      await applyEmotion(state.emotion);
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send('ball:state', state);
        } catch {
          /* 忽略 */
        }
      }
      lastState = state;
  handleEmotionEdge(state);
      syncThemeFromDsh();
      pollTimer = setTimeout(tick, badgeOn ? BADGE_POLL_MS : POLL_MS);
      return;
    }
    /* 守护：宿主没了（插件停用 / DSH 退出）就自己退，绝不留孤儿进程。 */
    if (seenOk) {
      failures += 1;
      if (failures > 8) app.quit();
    } else if (Date.now() - startedAt > 15000) {
      app.quit();
    }
    pollTimer = setTimeout(tick, POLL_MS);
  };

  tick();
}

function stopPolling() {
  pollGeneration += 1;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/* ---------------- 完成 / 出错提醒 ---------------- */

/** 上一次轮询到的表情：用来抓「跳过 33/34/35」的那一下。 */
let lastPollEmotion = null;
let badgeOn = false;
/** 亮角标的那一轮；用 epoch 判断「新一轮任务开始了」，比 running 抖动可靠。 */
let badgeTurn = 0;
/** 角标出现的时刻：用来判断「之后你有没有在 DSH 里操作过」。 */
let badgeSetAt = 0;
/** 当前角标的类型：wait 需要在「已回答」时自动清掉。 */
let lastBadgeKind = '';
/** DSH 连续聚焦起始时间：短暂的焦点切换不算「已读」。 */
let focusedSince = 0;
const FOCUS_ACK_MS = 8000;

/** 角标文案：等你回答用「?」，完成/出错用「!」。 */
function badgeText(kind) {
  return kind === 'wait' ? '?' : '!';
}

const HINTS = {
  33: { kind: 'done' },
  34: { kind: 'error' },
  35: { kind: 'wait' },
};

/**
 * 状态跳进「完成 / 出错 / 等待确认」时亮角标（不弹系统 toast，dsh-pet 已经在做）。
 * 清除规则刻意保守——之前「DSH 一获得焦点就清」会让你回来点窗口的瞬间被清掉，等于没提醒。现在只有两件事算「已读」：
 *   1. 新一轮任务开始（epoch 前进）；2. DSH 连续聚焦 ≥8 秒（说明你真的在看，不是切窗口路过）
 */
function handleEmotionEdge(state) {
  const emotion = String(state.emotion || '');
  const before = lastPollEmotion;
  lastPollEmotion = emotion;

  /* 已读条件：新一轮任务开始，或者 DSH 连续聚焦足够久 */
  if (badgeOn) {
    const turnMoved = typeof state.turns === 'number' && state.turns > badgeTurn;
    if (isDshFocused(state)) {
      if (!focusedSince) focusedSince = Date.now();
    } else {
      focusedSince = 0;
    }
    const focusedLongEnough = focusedSince !== 0 && Date.now() - focusedSince >= FOCUS_ACK_MS;
    /* 角标出现之后，你在 DSH 页面里点过 / 滚过 / 打过字 = 你已经回来了 */
    const touchedAfter =
      typeof state.lastActivityAt === 'number' && badgeSetAt > 0 && state.lastActivityAt > badgeSetAt;
    if (turnMoved) clearBadge('new-turn');
    else if (touchedAfter) clearBadge('activity');
    else if (focusedLongEnough) clearBadge('focused');
  } else {
    focusedSince = 0;
  }

  /*
   * 「等我回答」是持续状态，不是一次边沿：
   * 只要 DSH 还有待回答的交互、而你不在窗口前，角标就该一直亮着（之前只按边沿判断，你在问题出现后才关窗口，就永远不提醒）。
   */
  if (state.pending === true && !isDshFocused(state)) {
    if (!badgeOn) {
      badgeOn = true;
      badgeTurn = typeof state.turns === 'number' ? state.turns : 0;
      badgeSetAt = Date.now();
      focusedSince = 0;
      sendBadge({ kind: 'wait', text: badgeText('wait') });
      reportBadge(true, 'wait', 'pending');
      lastBadgeKind = 'wait';
    }
    return;
  }
  /* 待回答结束（你回答了）：wait 角标算已读 */
  if (lastBadgeKind === 'wait' && state.pending !== true) {
    clearBadge('answered');
    lastBadgeKind = '';
  }

  /* 完成 / 出错仍然是一次性事件：不在跟前才提醒 */
  if (!before || before === emotion) return;
  const hint = HINTS[emotion];
  if (!hint || hint.kind === 'wait') return;
  if (isDshFocused(state)) return;
  if (badgeOn) return;

  badgeOn = true;
  lastBadgeKind = hint.kind;
  badgeTurn = typeof state.turns === 'number' ? state.turns : 0;
  badgeSetAt = Date.now();
  focusedSince = 0;
  sendBadge({ kind: hint.kind, text: badgeText(hint.kind) });
  reportBadge(true, hint.kind, 'edge');
}
/** 清角标并上报原因（上报进 /state，方便排查「为什么没提醒 / 为什么没清」）。 */
function clearBadge(why) {
  if (!badgeOn) return;
  badgeOn = false;
  focusedSince = 0;
    badgeSetAt = 0;
  lastBadgeKind = '';
  sendBadge(null);
  reportBadge(false, '', why);
}

/** 把角标状态告诉宿主，挂在 /state 上。 */
/** 最近一次轮询到的 state：角标日志要记「当时的上下文」。 */
let lastState = null;
/** 角标变化日志（最多 10 条），随 /badge 一起上报，便于远程排查。 */
const badgeLog = [];

function rememberBadge(on, why) {
  badgeLog.push({
    at: Date.now(),
    on,
    why,
    focused: isDshFocused(lastState),
    fg: dshForeground,
    pending: Boolean(lastState && lastState.pending),
    turns: lastState && typeof lastState.turns === 'number' ? lastState.turns : null,
  });
  if (badgeLog.length > 10) badgeLog.shift();
}

function reportBadge(on, kind, why) {
  try {
    rememberBadge(on, why);
    const query =
      'on=' + (on ? '1' : '0') +
      '&kind=' + encodeURIComponent(kind || '') +
      '&why=' + encodeURIComponent(why || '') +
      '&log=' + encodeURIComponent(JSON.stringify(badgeLog));
    require('node:http')
      .get(ORIGIN + '/badge?' + query, (response) => response.resume())
      .on('error', () => {});
  } catch {
    /* 忽略 */
  }
}
function sendBadge(payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('ball:badge', payload);
  } catch {
    /* 忽略 */
  }
}

/**
 * 双击小球：DSH 窗口开着 → 最小化；最小化着 → 还原；隐藏到托盘 / 没启动 → 拉起。
 * Node 没有原生 Win32，所以借 PowerShell 调 user32。但每次双击冷启动一次要 300~400ms（还要现场编译 C#），手感很差；
 * 所以改成：第一次用到时起一个常驻 PowerShell，之后双击只往它 stdin 写一行 "toggle"，延迟降到几十毫秒。 */
const DSH_TOGGLE_PS = [
  /* ASCII comments only: PowerShell 5 reads BOM-less .ps1 as ANSI and mangles Chinese,
     which has silently eaten newlines and broken this script twice. */
  '$ErrorActionPreference = "SilentlyContinue"',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  '[StructLayout(LayoutKind.Sequential)] public struct EBRECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '[StructLayout(LayoutKind.Sequential)] public struct EBPOINT { public int X; public int Y; }',
  'public class EBW32 {',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr extra);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out EBRECT r);',
  '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(EBPOINT p);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);',
  '}',
  '"@',
  '# Cache the window handle: enumerating processes on every poll costs 100-300ms,',
  '# and the focus poll runs a few times per second, so it used to dominate the lag.',
  '$script:winH = [IntPtr]::Zero',
  'function Resolve-DshWindow {',
  '  if ($script:winH -ne [IntPtr]::Zero -and [EBW32]::IsWindow($script:winH)) { return $script:winH }',
  '  $proc = [System.Diagnostics.Process]::GetProcessesByName("DeepSeek Harness") | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1',
  '  if ($null -eq $proc) { $script:winH = [IntPtr]::Zero } else { $script:winH = $proc.MainWindowHandle }',
  '  return $script:winH',
  '}',
  '# ready as early as possible: everything slow happens after this line',
  '[Console]::Out.WriteLine("ready")',
  '[Console]::Out.Flush()',
  '# kill stale instances left behind by a force-killed helper (slow, so keep it off the start path)',
  `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*dsh-toggle-loop.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $cmd = $line.Trim()',
  '  if ($cmd -ne "toggle" -and $cmd -ne "focus") { continue }',
  '  $h = Resolve-DshWindow',
  '  if ($cmd -eq "focus") {',
  '    $isFg = ($h -ne [IntPtr]::Zero) -and ($h -eq [EBW32]::GetForegroundWindow())',
  '    [Console]::Out.WriteLine("focus=" + [int]$isFg)',
  '    [Console]::Out.Flush()',
  '    continue',
  '  }',
  '  if ($h -eq [IntPtr]::Zero) {',
  '    if ($env:EB_DSH_EXE) { Start-Process $env:EB_DSH_EXE }',
  '    [Console]::Out.WriteLine("ok none")',
  '    [Console]::Out.Flush()',
  '    continue',
  '  }',
  '  # Decide by occlusion, not by foreground: overlay widgets (dsh-pet) keep stealing',
  '  # the foreground, so "is DSH foreground" is false even while you look at it.',
  '  $visible = $false',
  '  if ([EBW32]::IsWindowVisible($h) -and -not [EBW32]::IsIconic($h)) {',
  '    $rc = New-Object EBRECT',
  '    [EBW32]::GetWindowRect($h, [ref]$rc) | Out-Null',
  '    if ($rc.Right -gt $rc.Left -and $rc.Bottom -gt $rc.Top) {',
  '      $pt = New-Object EBPOINT',
  '      $pt.X = [int](($rc.Left + $rc.Right) / 2)',
  '      $pt.Y = [int](($rc.Top + $rc.Bottom) / 2)',
  '      $at = [EBW32]::GetAncestor([EBW32]::WindowFromPoint($pt), 2)',
  '      if ($at -eq $h) { $visible = $true }',
  '    }',
  '  }',
  '  if ($visible) {',
  '    [EBW32]::ShowWindow($h, 6) | Out-Null',
  '    [Console]::Out.WriteLine("ok minimize")',
  '  } else {',
  '    [EBW32]::ShowWindow($h, 9) | Out-Null',
  '    if ([EBW32]::GetForegroundWindow() -ne $h) {',
  '      $fgThread = [EBW32]::GetWindowThreadProcessId([EBW32]::GetForegroundWindow(), [IntPtr]::Zero)',
  '      $myThread = [EBW32]::GetCurrentThreadId()',
  '      if ($fgThread -ne 0) { [EBW32]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null }',
  '      [EBW32]::BringWindowToTop($h) | Out-Null',
  '      [EBW32]::SetForegroundWindow($h) | Out-Null',
  '      if ($fgThread -ne 0) { [EBW32]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null }',
  '    }',
  '    if ([EBW32]::GetForegroundWindow() -ne $h) {',
  '      [EBW32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)',
  '      [EBW32]::SetForegroundWindow($h) | Out-Null',
  '      [EBW32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)',
  '    }',
  '    [Console]::Out.WriteLine("ok raise")',
  '  }',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

let toggleProc = null;
/** PowerShell 打印 ready 的 promise：冷启动时要等它，否则命令发太早。 */
let procReady = null;
let procReadyResolve = null;
/** 等待 focus= 回答的回调队列。 */
const focusWaiters = [];

/** 主动问一次「现在 DSH 在前台吗」，最多等 timeoutMs。 */
function askFocus(proc, timeoutMs = 400) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    focusWaiters.push(finish);
    setTimeout(() => finish(null), timeoutMs);
    try {
      proc.stdin.write('focus\n');
    } catch {
      finish(null);
    }
  });
}
let toggleIdleTimer = null;
/**
 * 常驻：双击必须永远是热的。
 * 焦点轮询每秒都要问一次 PowerShell，本来就会把它一直拉起来；
 * 再按「空闲 10 分钟退出」去杀它，只会制造 1.3s 的冷启动竞态——杀了下一拍又要重启。
 * 所以这里不再自动退出，PowerShell 只随 helper 一起结束。
 */
function touchToggleIdle() {
  /* 有意留空：保留调用点，方便以后真的需要按需退出时改回来。 */
}
/** DSH 是否是前台窗口；常驻 PowerShell 每 1s 报一次（getForegroundWindow 比较）。 */
let dshForeground = null;
let focusPollTimer = null;

/** 判断「你此刻是否在 DSH 窗口前」：PowerShell 的答案优先，页面上报只作后备。 */
function isDshFocused(state) {
  if (typeof dshForeground === 'boolean') return dshForeground;
  return state && state.dshFocused === true;
}

/** 把 Win32 问到的焦点状态同步给宿主，挂在 /state 上（排查用，也让页面不必自己判断）。 */
function reportFocus(focused) {
  try {
    require('node:http')
      .get(ORIGIN + '/focus?src=helper&f=' + (focused ? '1' : '0'), (response) => response.resume())
      .on('error', () => {});
  } catch {
    /* 忽略 */
  }
}

/** 每秒问一次前台窗口。窗口隐藏到托盘时 PowerShell 找不到句柄 → 自然报 0。 */
function startFocusPolling() {
  if (focusPollTimer) return;
  focusPollTimer = setInterval(() => {
    const proc = ensureToggleProc();
    if (!proc) return;
    try {
      proc.stdin.write('focus\n');
    } catch {
      /* 管道断了，下次重试 */
    }
  }, 1000);
}
/**
  * 常驻：双击必须永远是热的。焦点轮询每秒都要问一次 PowerShell，
  * 本来就会把它一直拉起来；再按「空闲 10 分钟退出」去杀它，
  * 只会制造 1.3s 的冷启动竞态——杀了下一拍又要重启。这里不再自动退出。
  */
function touchToggleIdle() {
  /* 有意留空：保留调用点，方便以后真需要按需退出时改回来。 */
}

/** 懒启动常驻 PowerShell（第一次双击会慢一点，之后一直是热的）。 */
/**
 * 把 helper/<sourceName> 编译成一个小 exe（用系统自带的 csc.exe，不需要装 .NET SDK）。
 * 冷启动约 40ms；编不出来就返回 null，由调用方决定退路。
 */
function compileHelper(sourceName, prefix, options) {
  const opts = options || {};
  const sourceFile = path.join(__dirname, sourceName);
  if (!fs.existsSync(sourceFile)) return null;
  let stamp = 0;
  try {
    stamp = Math.round(fs.statSync(sourceFile).mtimeMs);
  } catch {
    return null;
  }
  /* 文件名带版本号：exe 正在运行时自己无法被覆盖，换个名字编译就不会撞锁。
     子系统也算进文件名里：winexe 和控制台是两次不同的编译，只按源码 mtime 缓存会让
     早先编出来的控制台版本一直被复用——那正是「改完了还是闪黑框」的原因。 */
  const flavor = opts.winexe ? '-w' : '';
  const target = path.join(app.getPath('userData'), `${prefix}${flavor}-${stamp}.exe`);
  if (fs.existsSync(target)) return target;
  const compiler = [
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ].find((item) => fs.existsSync(item));
  if (!compiler) return null;
  try {
    const argv = ['/nologo', '/optimize+'];
    /* winexe = GUI 子系统，没有控制台。重启那两段必须是它：控制台程序被 WMI 创建时
       Windows 会分配一个控制台窗口，用户看到的就是「点了重启屏幕上闪一个黑框」。 */
    argv.push(opts.winexe ? '/target:winexe' : '/target:exe');
    for (const ref of opts.refs || []) argv.push('/r:' + ref + '.dll');
    argv.push('/out:' + target, sourceFile);
    const result = spawnSync(compiler, argv, {
      windowsHide: true,
      timeout: 30000,
      encoding: 'utf8',
    });
    if (result.status !== 0 || !fs.existsSync(target)) {
      logInput(`${prefix} 编译失败: ` + String(result.stderr || result.stdout || '').slice(0, 160));
      return null;
    }
    /* 编好之后顺手清掉旧版本（含以前按别的子系统编出来的同名产物） */
    const current = path.basename(target);
    const pattern = new RegExp(`^${prefix}(-w)?-\\d+\\.exe$`);
    for (const name of fs.readdirSync(app.getPath('userData'))) {
      if (pattern.test(name) && name !== current) {
        try {
          fs.unlinkSync(path.join(app.getPath('userData'), name));
        } catch {
          /* 旧版本还在跑就下次再删 */
        }
      }
    }
    return target;
  } catch (error) {
    logInput(`${prefix} 编译异常: ` + error.message);
    return null;
  }
}

/** 窗口操作小 exe：双击最小化/还原/置顶都由它调 user32。需要 stdin/stdout，保持控制台子系统。 */
function ensureToggleExe() {
  return compileHelper('toggle-helper.cs', 'dsh-toggle-helper');
}

/** 「重启 DSH」第二段：由 WMI 创建，脱离球的进程树，负责杀进程再拉起。没有窗口。 */
function ensureRestartExe() {
  return compileHelper('restart-helper.cs', 'dsh-restart-helper', { winexe: true });
}

/** 「重启 DSH」第一段：只做一次 WMI 调用。winexe，所以没有控制台窗口。 */
function ensureRestartLauncherExe() {
  return compileHelper('restart-launcher.cs', 'dsh-restart-launcher', { winexe: true, refs: ['System.Management'] });
}

function ensureToggleProc() {
  if (toggleProc && toggleProc.exitCode === null) return toggleProc;
  /* 冷启动没有「刚才」，先用上次持久化的焦点状态，避免第一次双击判错方向 */
  if (typeof settings.lastFocus === 'boolean') dshForeground = settings.lastFocus;
  try {
    /* PowerShell 兜底时脚本必须落盘用 -File 跑：带 here-string 的多行脚本塞进 -Command，
       PowerShell 解析不了（Add-Type 静默失败，结果双击毫无反应）。 */
    const helperExe = ensureToggleExe();
    if (helperExe) {
      toggleProc = spawn(helperExe, [dshExe || args.get('dsh-exe') || ''], { windowsHide: true });
    } else {
      const scriptFile = path.join(app.getPath('userData'), 'dsh-toggle-loop.ps1');
      try {
        fs.writeFileSync(scriptFile, DSH_TOGGLE_PS);
      } catch {
        return null;
      }
      toggleProc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
        {
          windowsHide: true,
          env: { ...process.env, EB_DSH_EXE: dshExe || args.get('dsh-exe') || '' },
        },
      );
      }
    toggleProc.stdout.on('data', (chunk) => {
      const text = String(chunk);
      /* focus=1 / focus=0：常驻 PowerShell 报的「DSH 是不是前台窗口」 */
      if (text.includes('ready') && procReadyResolve) {
        procReadyResolve();
        procReadyResolve = null;
      }
      const match = /focus=(\d)/.exec(text);
      if (match) {
        const next = match[1] === '1';
        if (next !== dshForeground) {
          dshForeground = next;
          settings.lastFocus = next;
          saveSettings();
          reportFocus(next);
        }
        while (focusWaiters.length) {
          const finish = focusWaiters.shift();
          try {
            finish(next);
          } catch {
            /* 忽略 */
          }
        }
      }
      const trimmed = text.trim();
      if (trimmed) logInput('toggle-proc -> ' + trimmed);
    });
    toggleProc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) logInput('toggle-proc err: ' + text.slice(0, 120));
    });
    toggleProc.on('error', () => {
      toggleProc = null;
    });
    /* 一起动就开始每秒问一次焦点，toggle 时才有一秒内的「刚才在不在前台」 */
    procReady = new Promise((resolve) => { procReadyResolve = resolve; });
    startFocusPolling();
    toggleProc.on('exit', () => {
      toggleProc = null;
    });
    return toggleProc;
  } catch {
    toggleProc = null;
    return null;
  }
}

async function toggleDshWindow() {
  const proc = ensureToggleProc();
  touchToggleIdle();
  if (!proc) {
    openDsh();
    return;
  }
  /*
   * 发哪个命令？用「刚才 DSH 是不是在前台」判断，而不是此刻——
   * 点球本身会把焦点从 DSH 抢走，所以此刻永远是「不在前台」。
   * dshForeground 由常驻 PowerShell 每秒上报一次，最多差 1 秒，正好代表「你点球之前」。
   */
  /* 冷启动时 PowerShell 还没报过焦点：先等它 ready，再主动问一次。
     否则第一次双击永远按「不在前台」处理，只会把窗口拉到前面、不会最小化。 */
  /* 注意：这里不能再问一次「现在在前台吗」——点球已经把焦点抢走了，问了必然是否。
     冷启动靠 settings.lastFocus 的历史值，热启动靠 1s 轮询。 */
  /* 方向交给 PowerShell 判断（它看得到窗口是否被遮挡）；
     这里只发 toggle，避免依赖随时会被桌宠抢走的焦点状态。 */
  const command = 'toggle';
  try {
    proc.stdin.write(command + '\n');
    logInput('dsh-toggle sent');
  } catch {
    /* 管道断了就重来一次 */
    toggleProc = null;
    const retry = ensureToggleProc();
    try {
      if (retry) retry.stdin.write(command + '\n');
      else openDsh();
    } catch {
      openDsh();
    }
  }
}

/** 退出时把常驻 PowerShell 关掉，别留孤儿进程。 */
function stopToggleProc() {
  if (!toggleProc) return;
  const proc = toggleProc;
  toggleProc = null;
  try {
    proc.stdin.end();
  } catch {
    /* 忽略 */
  }
  setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* 忽略 */
    }
  }, 300);
}

function openDsh() {
  /* 复用 DSH 自己的单实例锁：已经在跑就只是聚焦，不会开第二个窗口 */
  const target = dshExe || args.get('dsh-exe');
  if (!target) return;
  try {
    const child = spawn(target, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* 启动失败就安静地算了 */
  }
}

/**
 * 重启 DSH。
 *
 * 为什么让小球干这件事：球是独立进程，DSH 卡死（主进程不响应）时球还活着，
 * 这时候它反而是唯一能动手的一方。页面上的按钮、快捷键、托盘图标全在 DSH 里，
 * 一起跟着死了。
 *
 * 不能球自己杀自己旁边的 DSH —— 杀掉之后球也会被一起收掉（Electron 把子进程挂在
 * Job Object 上），所以它必须先把手上的活交给一个「不在自己进程树里」的执行体。
 * 那个执行体由 launcher 经 WMI 创建（见 helper/restart-launch.js），顺序是：
 * 等一下 → 杀光 DSH 的所有进程 → 等进程真的没了 → 重新拉起同一个 exe。
 * 杀完不立刻拉起是必须的：DSH 有单实例锁，旧进程还没死透时启动新进程只会把
 * 那个正在咽气的窗口「聚焦」一下，看起来像什么都没发生。
 */
function restartDsh() {
  const target = dshExe || args.get('dsh-exe');
  if (!target) {
    logInput('restart: 找不到 DSH 的 exe');
    return false;
  }
  /* 进程名 = 镜像名去掉 .exe；用名字杀比用 PID 稳：DSH 的窗口进程、GPU 进程
     都是同一个镜像，卡死时往往是一整窝都要收掉。 */
  const image = imageNameOf(target);
  const helperExe = ensureRestartExe();
  if (!helperExe) {
    logInput('restart: 编译不出执行体（缺 .NET Framework？）');
    return false;
  }
  const launcherExe = ensureRestartLauncherExe();
  if (!launcherExe) {
    logInput('restart: 编译不出 launcher');
    return false;
  }
  const logFile = path.join(app.getPath('userData'), 'restart.log');
  const launcherArgs = buildLauncherArgs({ helperExe, image, exe: target, log: logFile });
  try {
    /* launcher 只是一次 WMI 调用（约 0.1 秒）。执行体不能是球的子进程：DSH 被杀时
       球会跟着消失，球的孩子也被收掉，那就走不到「重新拉起」了。
       launcher 本身是 winexe —— 控制台程序被 WMI 创建时会分配一个控制台窗口，
       那正是「点了重启屏幕上闪一个黑框」的来源。 */
    const child = spawn(launcherExe, launcherArgs, { stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => {
      logInput('restart: 起 launcher 失败 ' + error.message);
      app.quit();
    });
    /* 等 launcher 退出再退：它要先把执行体交给 WMI，中途被带走就白点了。 */
    child.on('exit', () => app.quit());
    /* 兜底：launcher 卡住也不能让球一直挂着 */
    setTimeout(() => app.quit(), 20000);
  } catch (error) {
    logInput('restart: 起 launcher 失败 ' + error.message);
    return false;
  }
  return true;
}

function createWindow() {
  const saved = readPosition() || defaultPosition();
  /* 记忆的是球的左上角；窗口内容比球大一点，先建在球的原点，创建后再按实测尺寸换算。 */
  const position = clampToDisplays(saved);
  win = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: BALL_SIZE,
    height: BALL_SIZE,
    frame: false,
    /* Windows 上默认还有一层不可见的 WS_THICKFRAME（4px），
       会让 outer/content 尺寸相差 4px，拖动时越拖越大。关掉它。 */
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);

  /* 窗口内容比球大出边缘（实测 4px）。按实测差值把窗口往回挪，让球正好落在记住的位置上——否则每次启动都会漂一点。 */
  try {
    const actual = win.getContentBounds();
    const padX = actual.width - BALL_SIZE;
    const padY = actual.height - BALL_SIZE;
    if (padX !== 0 || padY !== 0) {
      win.setContentBounds({
        x: Math.round(position.x - padX),
        y: Math.round(position.y - padY),
        width: actual.width,
        height: actual.height,
      });
    }
  } catch {
    /* 忽略 */
  }

  win.loadURL(ballUrl());

  const present = () => {
    if (!win || win.isDestroyed()) return;
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    savePosition(ballPosition());
  };
  win.once('ready-to-show', present);
  /* 透明无边框窗在部分环境里 ready-to-show 会迟到甚至不触发，兜一层定时。 */
  setTimeout(present, 900);

  win.on('closed', () => {
    win = null;
  });

  /* 页面里的 JS 错误也写进诊断日志，方便无界面排查 */
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) logInput('console[' + level + '] ' + String(message).slice(0, 160));
  });

  win.webContents.on('did-finish-load', () => {
    lastEmotion = null;
    /* 换主题会重载页面：新页面是收起的，窗口也得缩回球的尺寸，否则会留一块透明大窗 */
    if (expanded) {
      const ball = ballPosition();
      expanded = false;
      layout = 'up';
      targetSize = { width: BALL_SIZE, height: BALL_SIZE };
      if (ball) {
    const scale = displayScale(ball.x, ball.y);
    win.setContentBounds({
      x: snapToPixels(ball.x, scale),
      y: snapToPixels(ball.y, scale),
      width: snapToPixels(BALL_SIZE, scale),
      height: snapToPixels(BALL_SIZE, scale),
    });
  }
      if (badgeOn) sendBadge({ kind: lastBadgeKind || 'done', text: badgeText(lastBadgeKind) });
    }
    startPolling();
    broadcastSettings();
  });

  startHitTest();
  return win;
}

/* ---------------- 渲染进程发来的拖动动作 ---------------- */

ipcMain.on('ball:drag-start', () => {
  logInput('pointerdown');
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  /* 记 outer bounds：拖动只用 setPosition 改位置，绝不写尺寸——写尺寸会在 DPI 缩放下反复换算，越拖越大。 */
  dragState = { cursor, outer: win.getBounds() };
  clearLeaveTimer();
});

/** 诊断：把输入事件写到文件，便于在无界面环境下确认窗口是否收到鼠标。 */
function logInput(kind) {
  if (!DEV_MODE) return; // 正式运行不写诊断文件
  try {
    const file = path.join(app.getPath('userData'), 'input.log');
    fs.appendFileSync(file, `${new Date().toISOString()} ${kind}\n`);
  } catch {
    /* 忽略 */
  }
}

ipcMain.on('ball:drag-to', (_event, dx, dy) => {
  if (!win || win.isDestroyed() || !dragState) return;
  /* 只改位置、不改尺寸：setPosition 不会碰宽高，展开时窗口大小保持不变，
     球也就不会「跳」到面板左上角。 */
  const origin = dragState.outer;
  const next = clampToDisplays(
    {
      x: Math.round(origin.x + Number(dx || 0)),
      y: Math.round(origin.y + Number(dy || 0)),
    },
    targetSize,
  );
  /* 尺寸永远写 targetSize 这个常量：setPosition 会重算 DWM 边框，而从 getBounds 读回尺寸再写会在 DPI 缩放下漂移。 */
  const dragScale = displayScale(next.x, next.y);
  win.setContentBounds({
    x: snapToPixels(next.x, dragScale),
    y: snapToPixels(next.y, dragScale),
    width: targetSize.width,
    height: targetSize.height,
  });
});

ipcMain.on('ball:drag-end', () => {
  ballAnchor = null; // 位置变了：下次以实际窗口为准
  if (win && !win.isDestroyed()) savePosition(ballPosition());
  dragState = null;
});

ipcMain.on('ball:open-dsh', () => toggleDshWindow());

/** 右键菜单里的「重启 DSH」：写完脚本就退出，剩下的交给那个独立进程。 */
ipcMain.on('ball:restart', () => {
  restartDsh();
});

/** 右键菜单与设置（现在只剩主题；眼神跟随和常驻加速是固定的）。 */
ipcMain.on('ball:set-setting', (_event, key, value) => {
  if (key === 'theme' && (value === 'auto' || value === 'dark' || value === 'light')) {
    settings.theme = value;
    /* 同时请求把整个 DSH 也切过去：页面半侧轮询 /theme 再调 ctx.theme.setTheme */
    const mapped = value === 'auto' ? 'system' : value;
    try {
      const request = require('node:http').get(ORIGIN + '/theme?set=' + mapped, (response) => response.resume());
      request.on('error', () => {});
    } catch {
      /* 忽略 */
    }
    if (win && !win.isDestroyed()) win.loadURL(ballUrl());
  }
  saveSettings();
  broadcastSettings();
});

ipcMain.on('ball:reset-position', () => {
  if (!win || win.isDestroyed()) return;
  const target = defaultPosition();
  const size = targetSize;
  if (expanded) {
    win.setContentBounds({
      x: target.x - (size.width - BALL_SIZE),
      y: target.y - (size.height - BALL_SIZE),
      width: size.width,
      height: size.height,
    });
  } else {
    win.setContentBounds({ x: target.x, y: target.y, width: BALL_SIZE, height: BALL_SIZE });
  }
  savePosition(ballPosition());
});

/**
 * DSH 的主题偏好变了（用户在别处改的）→ 桌面球跟着换；'system' 对应球的 'auto'，相同就不动，避免来回重载。 */
function syncThemeFromDsh() {
  if (!win || win.isDestroyed()) return;
  const service = require('node:http');
  service
    .get(ORIGIN + '/theme', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          const reported = data && data.reported;
          const mapped = reported === 'system' ? 'auto' : reported;
          if (!mapped || (mapped !== 'light' && mapped !== 'dark' && mapped !== 'auto')) return;
          if (mapped === settings.theme) return;
          settings.theme = mapped;
          saveSettings();
          broadcastSettings();
          win.loadURL(ballUrl());
        } catch {
          /* 忽略 */
        }
      });
    })
    .on('error', () => {});
}

/** 眼神跟随：把「光标相对球心的方向」归一化后推给页面（30ms 一次，够顺滑也不费）。 */
function pushGaze(cursor) {
  if (!win || win.isDestroyed()) return;
  const rects = interactiveRects();
  const ball = rects[0];
  const cx = ball.x + ball.width / 2;
  const cy = ball.y + ball.height / 2;
  const nx = Math.max(-1, Math.min(1, (cursor.x - cx) / GAZE_RADIUS));
  const ny = Math.max(-1, Math.min(1, (cursor.y - cy) / GAZE_RADIUS));
  try {
    win.webContents.send('ball:gaze', { x: nx, y: ny });
  } catch {
    /* 忽略 */
  }
}

/**
 * 展开 / 收起：窗口 = 球 + 面板 的并集，并保证球的屏幕位置不动；窗口不能整块吃鼠标，由主进程按光标位置做命中检测，只在小球/面板上解除 setIgnoreMouseEvents。 */
/* 悬停/按下时提前把 PowerShell 拉起来：等用户真正双击时它已经就绪，
   冷启动那 0.6-1.3 秒就藏在了"手还没点下去"的时间里。 */
ipcMain.on('ball:warm', () => {
  if (!win || win.isDestroyed()) return;
  if (toggleProc && toggleProc.exitCode === null) return;
  ensureToggleProc();
});

ipcMain.on('ball:expand', (_event, size) => {
  if (!win || win.isDestroyed()) return;
  const width = Math.max(180, Math.round(Number(size && size.width) || panelSize.width));
  const height = Math.max(120, Math.round(Number(size && size.height) || panelSize.height));
  panelSize = { width, height };
  const bounds = win.getContentBounds();
  /* 有基准就用基准：反复「面板 ↔ 菜单」切换时位置才不会一圈一圈地挪。 */
  if (!ballAnchor) {
    ballAnchor = {
      x: panelAlign === 'left' ? bounds.x : bounds.x + bounds.width - BALL_SIZE,
      y: layout === 'up' ? bounds.y + bounds.height - BALL_SIZE : bounds.y,
    };
  }
  const rawRight = ballAnchor.x + BALL_SIZE;
  const rawTop = ballAnchor.y;
  /* 先把手里的球位置吸附到物理像素网格：当前窗口可能落在半像素上
     （比如 505 DIP = 757.5 物理像素），不吸附的话从它推出的新位置会偏 1 物理像素。 */
  const ballScale = displayScale(rawRight - BALL_SIZE, rawTop);
  const ballRight = snapToPixels(rawRight, ballScale);
  const ballLeft = ballRight - BALL_SIZE;
  const ballTop = snapToPixels(rawTop, ballScale);
  const area = screen.getDisplayNearestPoint({ x: ballLeft, y: ballTop }).workArea;
  const boxWidth = Math.max(BALL_SIZE, width);

  /* 竖直：优先朝上（球在底），上面不够就朝下；两边都不够就贴着上边 */
  const up = ballTop - 8 - height >= area.y;
  const downFits = ballTop + BALL_SIZE + 8 + height <= area.y + area.height;
  layout = up ? 'up' : 'down';
  let y = up ? Math.round(ballTop - 8 - height) : Math.round(ballTop);
  if (!up && !downFits) y = Math.round(Math.max(area.y, Math.min(y, area.y + area.height - BALL_SIZE)));

  /* 水平：优先向球左侧展开；左边不够就翻到右侧；都不够就夹在屏内 */
  let align = 'right';
  let x = Math.round(ballRight - boxWidth);
  if (x < area.x) {
    if (ballLeft + boxWidth <= area.x + area.width) {
      align = 'left';
      x = Math.round(ballLeft);
    } else {
      x = Math.round(Math.max(area.x, Math.min(x, area.x + area.width - boxWidth)));
    }
  }

  const nextWidth = boxWidth;
  const nextHeight = height + 8 + BALL_SIZE;
  if (!win.isDestroyed()) {
    try {
      win.webContents.send('ball:layout', { vertical: layout, align });
    } catch {
      /* 忽略 */
    }
  }
  expanded = true;
  panelAlign = align;
  targetSize = { width: nextWidth, height: nextHeight };
  clearLeaveTimer();
  logInput('expand to ' + nextWidth + 'x' + nextHeight + ' layout=' + layout + '/' + align);
  /* 以基准球位置为准放置窗口，多退少补（见 placeWindowForBall） */
  placeWindowForBall({ x: ballLeft, y: ballTop }, nextWidth, nextHeight, layout, align);
});

ipcMain.on('ball:collapse', () => {
  if (!win || win.isDestroyed()) return;
  const ball = ballPosition();
  expanded = false;
  layout = 'up';
  panelAlign = 'right';
  targetSize = { width: BALL_SIZE, height: BALL_SIZE };
  logInput('collapse');
  ballAnchor = null; // 收起后以真实位置为准
  if (ball) placeWindowForBall(ball, BALL_SIZE, BALL_SIZE, 'up', 'right');
});

/** 小球 / 面板的屏幕矩形，用于命中检测。 */
function interactiveRects() {
  const bounds = win.getContentBounds();
  if (!expanded) return [{ x: bounds.x, y: bounds.y, width: BALL_SIZE, height: BALL_SIZE }];
  /* 面板区域直接由当前窗口推导：窗口 = 面板 + 间隙 + 球，
     这样不会因为 panelSize 记的是旧值而让面板顶部点不到。 */
  const contentHeight = Math.max(0, bounds.height - 8 - BALL_SIZE);
  return [
    {
      x: panelAlign === 'left' ? bounds.x : bounds.x + bounds.width - BALL_SIZE,
      y: layout === 'up' ? bounds.y + bounds.height - BALL_SIZE : bounds.y,
      width: BALL_SIZE,
      height: BALL_SIZE,
    },
    {
      x: bounds.x,
      y: layout === 'up' ? bounds.y : bounds.y + BALL_SIZE + 8,
      width: bounds.width,
      height: contentHeight,
    },
  ];
}

function clearLeaveTimer() {
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
}

function inside(point, rect) {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

function startHitTest() {
  if (hitTimer) clearInterval(hitTimer);
  hitTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    pushGaze(cursor);
    const hit = interactiveRects().some((rect) => inside(cursor, rect));
    const ignore = !hit;
    if (ignore !== ignoringMouse) {
      ignoringMouse = ignore;
      try {
        /* forward:true —— 穿透时仍然把移动事件转给页面，鼠标进到球上能立刻恢复 */
        win.setIgnoreMouseEvents(ignore, { forward: true });
      } catch {
        /* 忽略 */
      }
    }
    /* 光标离开球和面板：等一小会儿就收面板（桌面窗口听不到「外面的点击」，
       只能用「离开」来近似点外部关闭）。 */
    if (expanded && !hit && !dragState) {
      if (!leaveTimer) {
        leaveTimer = setTimeout(() => {
          leaveTimer = null;
          if (win && !win.isDestroyed()) win.webContents.send('ball:leave');
        }, 500);
      }
    } else if (leaveTimer) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  }, 40);
}

ipcMain.on('ball:theme', (_event, theme) => {
  if (theme === 'dark' || theme === 'light') {
    /* 调色板是引擎注册前改的种子，只能重载页面；重载后 did-finish-load 会重新拉状态 */
    if (win && !win.isDestroyed()) win.loadURL(`${ORIGIN}/ball.html?surface=desktop&theme=${theme}&v=11`);
  }
});

/* ---------------- 生命周期 ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  app.whenReady().then(async () => {
    positionFile = path.join(app.getPath('userData'), 'ball-window.json');
    settingsFile = path.join(app.getPath('userData'), 'settings.json');
    readSettings();
    createWindow();

    /* 启动预热：编译小 exe、拉起常驻进程、开始焦点轮询——这些现在没有开关，一律执行。 */
    setTimeout(() => {
      try {
        /* 先把 exe 编出来（只需一次），免得第一次双击还要等编译 */
        ensureToggleExe();
        /* 重启要用的两段 exe 也预热掉：csc 大约 1 秒，别等到点了「重启 DSH」才卡这一下。 */
        setTimeout(() => {
          try {
            ensureRestartExe();
            ensureRestartLauncherExe();
          } catch {
            /* 编不出来就等真点的时候再试 */
          }
        }, 2500);
        /* 常驻加速现在是固定行为：小 exe 只占约 3MB，一直热着，双击零等待。 */
        ensureToggleProc();
        startFocusPolling();
        touchToggleIdle();
      } catch {
        /* 忽略 */
      }
    }, 1500);

    /* 自检模式：在页面里派发真实的 PointerEvent，走一遍「展开 → 拖动」，
       每步打印窗口 bounds。比外部合成鼠标事件可靠（不会撞到面板格子）。 */
    if (DEV_MODE && args.get('selftest') !== undefined) {
      /* 不用 did-finish-load：createWindow 里已经 loadURL，这个事件可能已经过去了 */
      setTimeout(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const report = (label) => {
          const b = win.getContentBounds();
          console.log(`${label} ${JSON.stringify(b)}`);
          return b;
        };
        await sleep(1200);
        const b0 = report('initial');

        await win.webContents.executeJavaScript(`(() => {
          const el = document.getElementById('ballWrap');
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const base = { bubbles: true, button: 0, clientX: cx, clientY: cy, screenX: cx + window.screenX, screenY: cy + window.screenY };
          el.dispatchEvent(new PointerEvent('pointerdown', base));
          window.dispatchEvent(new PointerEvent('pointerup', base));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        })()`, true);
        await sleep(700);
        const b1 = report('expanded');

        await win.webContents.executeJavaScript(`(() => {
          const el = document.getElementById('ballWrap');
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const sx = cx + window.screenX, sy = cy + window.screenY;
          window.__ebDrag = { cx: cx, cy: cy, sx: sx, sy: sy };
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: cx, clientY: cy, screenX: sx, screenY: sy }));
          for (let i = 1; i <= 5; i += 1) {
            window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx - 10 * i, clientY: cy - 8 * i, screenX: sx - 10 * i, screenY: sy - 8 * i }));
          }
        })()`, true);
        await sleep(120);
        const bMid = report('dragging');

        await win.webContents.executeJavaScript(`(() => {
          const d = window.__ebDrag;
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, screenX: d.sx - 50, screenY: d.sy - 40 }));
          document.getElementById('ballWrap').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        })()`, true);
        await sleep(600);
        const b2 = report('after-release');

        const result = {
          sizeKept: bMid.width === b1.width && bMid.height === b1.height,
          expandedWidth: b1.width - b0.width,
          dx: bMid.x - b1.x,
          dy: bMid.y - b1.y,
          expectDx: -50,
          expectDy: -40,
          afterRelease: { width: b2.width, height: b2.height },
        };
        console.log(JSON.stringify(result, null, 2));
        app.exit(0);
      }, 1500);
    }

    /* --paneltest=1：展开 → 切「全部」→ 看球有没有跑位 */
    /* --ctxmenutest=1：面板打开时右键，看球是否位移 */
    if (DEV_MODE && args.get('ctxmenutest') !== undefined) {
      setTimeout(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const snap = (label) => {
          const b = win.getContentBounds();
          const ball = ballPosition();
          console.log(label + ' window=' + JSON.stringify(b) + ' ball=' + JSON.stringify(ball) + ' layout=' + layout + '/' + panelAlign);
          return ball;
        };
        await sleep(700);
        await win.webContents.executeJavaScript('window.__EB_EXPAND()', true);
        await sleep(500);
        const a = snap('panel-open');
        await win.webContents.executeJavaScript('window.__EB_OPEN_MENU()', true);
        await sleep(600);
        const b = snap('menu-open');
        await win.webContents.executeJavaScript('window.__EB_EXPAND()', true);
        await sleep(500);
        const c = snap('back-to-panel');
        await win.webContents.executeJavaScript('window.__EB_COLLAPSE && window.__EB_COLLAPSE()', true);
        await sleep(500);
        const d = snap('collapsed');
        console.log(JSON.stringify({
          cycleStable: a.x === b.x && a.y === b.y && a.x === c.x && a.y === c.y,
          finalBall: d,
          startBall: a,
        }, null, 2));
        console.log(JSON.stringify({ movedOnMenu: a.x !== b.x || a.y !== b.y, dx: b.x - a.x, dy: b.y - a.y }, null, 2));
        app.exit(0);
      }, 1800);
    }

    if (DEV_MODE && args.get('paneltest') !== undefined) {
      setTimeout(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const snap = (label) => {
          const b = win.getContentBounds();
          const ball = ballPosition();
          console.log(label + ' window=' + JSON.stringify(b) + ' ball=' + JSON.stringify(ball) + ' layout=' + layout + '/' + panelAlign);
          return { b, ball };
        };
        await sleep(600);
        const a = snap('closed');
        await win.webContents.executeJavaScript('window.__EB_EXPAND()', true);
        await sleep(500);
        const b = snap('panel-open');
        await win.webContents.executeJavaScript('document.getElementById("toggleAll").click()', true);
        await sleep(700);
        const c = snap('after-all');
        if (args.get('shot')) {
          try {
            const image = await win.webContents.capturePage();
            fs.writeFileSync(args.get('shot'), image.toPNG());
            console.log('shot saved');
          } catch (error) {
            console.log('shot failed: ' + ((error && error.message) || error));
          }
        }
        console.log(JSON.stringify({
          ballMovedDuringOpen: a.ball.x !== b.ball.x || a.ball.y !== b.ball.y,
          ballMovedOnToggleAll: b.ball.x !== c.ball.x || b.ball.y !== c.ball.y,
          deltaOnToggle: { dx: c.ball.x - b.ball.x, dy: c.ball.y - b.ball.y },
        }, null, 2));
        app.exit(0);
      }, 1800);
    }

    /* --menutest=1：脚本直连页面，验证右键菜单与主题切换（不依赖合成鼠标） */
    if (DEV_MODE && args.get('menutest') !== undefined) {
      setTimeout(async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const box = (label) => {
          const b = win.getContentBounds();
          console.log(label + ' ' + JSON.stringify(b));
          return b;
        };
        await sleep(600);
        const before = box('collapsed');
        await win.webContents.executeJavaScript('window.__EB_OPEN_MENU()', true);
        /* 只等 250ms：桌面球有「光标离开 500ms 就收起」的启发式，合成测试里光标不在球上 */
        await sleep(250);
        const opened = box('menu-open');
        const marks = await win.webContents.executeJavaScript(
          'Array.from(document.querySelectorAll("[data-mark]")).map(function (n) { return n.dataset.mark + "=" + (n.textContent || ""); }).join("|")',
          true,
        );
        console.log('marks ' + marks);
        await win.webContents.executeJavaScript(
          'document.querySelector(\'[data-act="theme"][data-value="light"]\').click()',
          true,
        );
        await sleep(2500);
        const after = box('after-theme-click');
        let saved = null;
        try {
          saved = fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
        } catch (error) {
          saved = 'missing';
        }
        console.log(
          JSON.stringify(
            {
              menuWidth: opened.width - before.width,
              menuHeight: opened.height - before.height,
              afterWidth: after.width,
              afterUrl: win.webContents.getURL(),
              settings: saved,
            },
            null,
            2,
          ),
        );
        app.exit(0);
      }, 1800);
    }

    nativeTheme.on('updated', () => {
      if (!win || win.isDestroyed()) return;
      win.loadURL(`${ORIGIN}/ball.html?surface=desktop&theme=${themeName()}&v=11`);
    });

    if (probePath) {
      /* 自检模式：打印诊断（可选截图），然后退出。给不带界面的环境验证用。 */
      setTimeout(() => {
        console.log(JSON.stringify({ probe: 'timeout' }));
        app.exit(2);
      }, 20000);
      win.webContents.once('did-finish-load', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const state = await fetchState();
        if (state) await applyEmotion(state.emotion);
        /* --badge=done|error：把角标点亮，便于截图确认渲染 */
        /* --badgeipc=done：走真实的 ball:badge IPC（验证 preload → 页面这条路） */
        if (args.get('badgeipc')) {
          sendBadge({ kind: args.get('badgeipc'), text: badgeText(args.get('badgeipc')) });
          console.log('badgeipc sent');
        }
        if (args.get('badge')) {
          await win.webContents.executeJavaScript(
            'window.__EB_BADGE && window.__EB_BADGE({ kind: ' + JSON.stringify(args.get('badge')) + ', text: "!" })',
            true,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
        let captured = false;
        try {
          const image = await win.webContents.capturePage();
          fs.writeFileSync(probePath, image.toPNG());
          captured = true;
        } catch (error) {
          captured = String((error && error.message) || error);
        }
        const info = {
          electron: process.versions.electron,
          bounds: win.getBounds(),
          visible: win.isVisible(),
          alwaysOnTop: win.isAlwaysOnTop(),
          opacity: win.getOpacity(),
          theme: themeName(),
          url: win.webContents.getURL(),
          state,
          captured,
          hasSet: await win.webContents.executeJavaScript('typeof window.__EB_SET === "function"', true),
          hasBridge: await win.webContents.executeJavaScript('Boolean(window.dshBall)', true),
        };
        console.log(JSON.stringify(info, null, 2));
        app.exit(0);
      });
    }
  });

  app.on('window-all-closed', () => {
    stopPolling();
    stopToggleProc();
    app.quit();
  });

  app.on('will-quit', () => {
    stopToggleProc();
    if (hitTimer) clearInterval(hitTimer);
  });
}
