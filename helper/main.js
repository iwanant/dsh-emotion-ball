/**
 * 妗岄潰鐞?鈥斺€?Electron 涓昏繘绋? *
 * 鐢?DSH 瀹夸富渚х殑鎻掍欢鎷夎捣锛坅pply 鏃?spawn銆乨ispose 鏃?kill锛夛紝鎵€浠ワ細
 *   鎻掍欢鍦?鈫?鐞冨湪锛涙彃浠跺仠鐢?/ DSH 鎵樼洏閫€鍑?鈫?鐞冩秷澶便€傛病鏈夊紑鏈鸿嚜鍚紝涔熸病鏈夊鍎胯繘绋嬨€? *
 * 绐楀彛褰㈡€侊細鏃犺竟妗嗐€侀€忔槑銆佺疆椤躲€佷笉杩涗换鍔℃爮銆?4脳44銆? * 鍐呭锛氱洿鎺ュ姞杞藉涓婚潤鎬佹湇鍔′笂鐨?ball.html锛堝拰缃戦〉閲岄偅棰楁槸鍚屼竴浠界礌鏉愶紝涓嶅鍒讹級銆? * 鐘舵€侊細杞 /state锛?00ms锛夛紝鎷垮埌 emotionId 鍚?executeJavaScript 璋?window.__EB_SET銆? *
 * 涓轰粈涔堣疆璇㈣€屼笉鏄?IPC锛欵lectron 涓昏繘绋嬭涓嶅埌 piped stdin锛坋lectron#4218锛夛紝
 * 鑰?DSH 瀹夸富鍜岃繖涓?helper 鏄袱涓繘绋嬨€傝疆璇竴涓湰鏈?400ms 鐨勬帴鍙ｆ渶鐪佷簨銆佷篃鏈€濂芥帓閿欍€? */
const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8766;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BALL_SIZE = 44;
const POLL_MS = 400;
/** 角标亮着时用的快速轮询间隔：让「回答完就消失」几乎是即时的。 */
const BADGE_POLL_MS = 120;

/* 閫忔槑绐楀彛 + 杞欢娓叉煋鏈€绋筹細鏌愪簺浼氳瘽锛堣繙绋嬫闈€佹棤鐙樉銆佽娉ㄥ叆鐨勬覆鏌撹繘绋嬶級
   涓嬪甫 GPU 鍚堟垚浼氭姏 UnknownVizError锛岄€忔槑绐楀彛鐩存帴鍙橀粦鍧椼€?*/
app.disableHardwareAcceleration();

/** --key=value 褰㈠紡鐨勫弬鏁?*/
const args = new Map(
  process.argv
    .filter((item) => item.startsWith('--') && item.includes('='))
    .map((item) => {
      const index = item.indexOf('=');
      return [item.slice(2, index), item.slice(index + 1)];
    }),
);

/**
 * 寮€鍙戞湡寮€鍏筹細鍙湁鏄惧紡 --dev=1锛堟垨鐜鍙橀噺 DSH_EMOTION_BALL_DEV=1锛夋墠鍚敤
 * 鑷妯″紡銆佹帰閽堟埅鍥惧拰 input.log 璇婃柇鍐欑洏銆傛甯歌繍琛屾椂杩欎簺涓€姒備笉鐢熸晥锛? * 鍏嶅緱鎶婅皟璇曠敤鐨勪笢瑗跨暀鍦ㄦ寮忚涓洪噷銆? */
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
/** 灞曞紑鐘舵€佷笌闈㈡澘灏哄锛圕SS px锛夛紝绐楀彛 = 鐞?+ 闈㈡澘 鐨勫苟闆嗐€?*/
let expanded = false;
let panelSize = { width: 268, height: 380 };
let ignoringMouse = null;
let hitTimer = null;
let leaveTimer = null;
/** 鐩爣绐楀彛灏哄锛圕SS/DIP锛夛細灞曞紑鍜屾嫋鍔ㄩ兘鍐欒繖涓父閲忥紝閬垮厤 DPI 鎹㈢畻鏉ュ洖婕傜Щ銆?*/
let targetSize = { width: BALL_SIZE, height: BALL_SIZE };
/** 灞曞紑鏂瑰悜锛氱悆鍦ㄤ笅鏂规椂鍐呭鏈濅笂锛坲p锛夛紝鐞冨湪涓婃柟鏃跺唴瀹规湞涓嬶紙down锛夈€?*/
let layout = 'up';
/** 姘村钩閿氱偣锛歳ight = 鐞冨湪绐楀彛鍙宠竟锛堥潰鏉挎湞宸﹀睍寮€锛夛紝left = 缈诲埌鍙︿竴渚с€?*/
let panelAlign = 'right';

/** 鐢ㄦ埛璁剧疆锛氱溂绁炶窡闅?+ 涓婚鍋忓ソ銆傚瓨 userData/settings.json銆?*/
let settings = { gaze: true, theme: 'auto', lowLatency: false, lastFocus: null };
let settingsFile = null;
const GAZE_RADIUS = 260;

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      settings = {
        gaze: parsed.gaze !== false,
        theme: parsed.theme === 'dark' || parsed.theme === 'light' ? parsed.theme : 'auto',
        lowLatency: parsed.lowLatency === true,
        lastFocus: typeof parsed.lastFocus === 'boolean' ? parsed.lastFocus : null,
      };
    }
  } catch {
    /* 棣栨杩愯娌℃湁鏂囦欢 */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
  } catch {
    /* 蹇界暐 */
  }
}

function broadcastSettings() {
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('ball:settings', settings);
    } catch {
      /* 蹇界暐 */
    }
  }
}

function themeName() {
  if (forcedTheme === 'dark' || forcedTheme === 'light') return forcedTheme;
  if (settings.theme === 'dark' || settings.theme === 'light') return settings.theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function ballUrl() {
  return `${ORIGIN}/ball.html?surface=desktop&theme=${themeName()}&v=9`;
}

function readPosition() {
  try {
    const raw = fs.readFileSync(positionFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return { x: parsed.x, y: parsed.y };
  } catch {
    /* 棣栨杩愯娌℃湁鏂囦欢 */
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
  /* 鏁翠釜绐楀彛璺戝埌鏄剧ず鍣ㄤ箣澶栵細澶瑰洖涓诲睆锛屽埆鐬Щ鍥為粯璁ょ偣 */
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(Math.min(Math.max(area.x, point.x), area.x + area.width - box.width)),
    y: Math.round(Math.min(Math.max(area.y, point.y), area.y + area.height - box.height)),
  };
}

/** 璁板繂鐨勬槸**鐞?*鐨勫乏涓婅锛屼笉鏄獥鍙ｅ師鐐光€斺€斿睍寮€鏃剁獥鍙ｅ師鐐规槸闈㈡澘宸︿笂瑙掋€?*/
function ballPosition() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getContentBounds();
  /* 绐楀彛鍐呭姣旂悆澶у嚭涓€鐐癸紙閫忔槑绐楃殑杈圭紭锛夛紝鐞冨湪椤甸潰閲屾槸闈犲彸涓嬭瀵归綈鐨勶紝
     鎵€浠ユ敹璧锋椂涔熶笉鑳界洿鎺ユ嬁绐楀彛鍘熺偣褰撶悆鐨勪綅缃紝鍚﹀垯灞曞紑浼氬亸鍑犱釜鍍忕礌銆?*/
  return {
    x: panelAlign === 'left' ? Math.round(bounds.x) : Math.round(bounds.x + bounds.width - BALL_SIZE),
    y: layout === 'up' ? Math.round(bounds.y + bounds.height - BALL_SIZE) : Math.round(bounds.y),
  };
}

function savePosition(point) {
  try {
    fs.writeFileSync(positionFile, JSON.stringify({ x: point.x, y: point.y }));
  } catch {
    /* 鍐欎笉浜嗗氨鍙湪鏈浼氳瘽閲岃浣?*/
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
    /* 椤甸潰杩樻病灏辩华锛屼笅涓€娆¤疆璇細琛ヤ笂 */
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

/* ---------------- 瀹屾垚 / 鍑洪敊鎻愰啋 ---------------- */

/** 涓婁竴娆¤疆璇㈠埌鐨勮〃鎯咃細鐢ㄦ潵鎵俱€岃烦杩?33/34/35銆嶇殑閭ｄ竴涓嬨€?*/
let lastPollEmotion = null;
let badgeOn = false;
/** 浜鏍囩殑閭ｄ竴杞紱鐢?epoch 鍒ゆ柇銆屾柊涓€杞换鍔″紑濮嬩簡銆嶏紝姣?running 鎶栧姩鍙潬銆?*/
let badgeTurn = 0;
/** 角标出现的时刻：用来判断「之后你有没有在 DSH 里操作过」。 */
let badgeSetAt = 0;
/** 褰撳墠瑙掓爣鐨勭被鍨嬶細wait 闇€瑕佸湪銆屽凡鍥炵瓟銆嶆椂鑷姩娓呮帀銆?*/
let lastBadgeKind = '';
/** DSH 杩炵画鑱氱劍璧峰鏃堕棿锛氱煭鏆傜殑鐒︾偣鍒囨崲涓嶇畻銆屽凡璇汇€嶃€?*/
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
 * 鐘舵€佽烦杩涖€屽畬鎴?/ 鍑洪敊 / 绛夊緟纭銆嶆椂浜鏍囷紙涓嶅脊绯荤粺 toast锛宒sh-pet 宸茬粡鍦ㄥ仛锛夈€? *
 * 娓呴櫎瑙勫垯鍒绘剰淇濆畧鈥斺€斾箣鍓嶃€孌SH 涓€鑾峰緱鐒︾偣灏辨竻銆嶄細璁╀綘鍥炴潵鐐圭獥鍙ｇ殑鐬棿琚竻鎺夈€? * 绛変簬娌℃彁閱掋€傜幇鍦ㄥ彧鏈夎繖涓や欢浜嬬畻銆屽凡璇汇€嶏細
 *   1. 鏂颁竴杞换鍔″紑濮嬶紙epoch 鍓嶈繘锛夆€斺€旇鏄庝綘宸茬粡鍥炴潵骞叉椿浜? *   2. DSH 杩炵画鑱氱劍 鈮?8 绉掆€斺€旇鏄庝綘鐪熺殑鍦ㄧ湅锛屼笉鏄垏绐楀彛璺繃
 */
function handleEmotionEdge(state) {
  const emotion = String(state.emotion || '');
  const before = lastPollEmotion;
  lastPollEmotion = emotion;

  /* 宸茶鏉′欢锛氭柊涓€杞换鍔″紑濮嬶紝鎴栬€?DSH 杩炵画鑱氱劍瓒冲涔?*/
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
   * 銆岀瓑鎴戝洖绛斻€嶆槸**鎸佺画鐘舵€?*锛屼笉鏄竴娆¤竟娌匡細
   * 鍙 DSH 杩樻湁寰呭洖绛旂殑浜や簰銆佽€屼綘涓嶅湪绐楀彛鍓嶏紝瑙掓爣灏辫涓€鐩翠寒鐫€銆?   * 锛堜箣鍓嶅彧鎸夎竟娌垮垽鏂紝浣犲湪闂鍑虹幇鍚庢墠鍏崇獥鍙ｏ紝灏辨案杩滀笉鎻愰啋銆傦級
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
  /* 寰呭洖绛旂粨鏉燂紙浣犲洖绛斾簡锛夛細wait 瑙掓爣绠楀凡璇?*/
  if (lastBadgeKind === 'wait' && state.pending !== true) {
    clearBadge('answered');
    lastBadgeKind = '';
  }

  /* 瀹屾垚 / 鍑洪敊浠嶇劧鏄竴娆℃€т簨浠讹細涓嶅湪璺熷墠鎵嶆彁閱?*/
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
/** 娓呰鏍囧苟涓婃姤鍘熷洜锛堜笂鎶ヨ繘 /state锛屾柟渚挎帓鏌ャ€屼负浠€涔堟病鎻愰啋 / 涓轰粈涔堟病娓呫€嶏級銆?*/
function clearBadge(why) {
  if (!badgeOn) return;
  badgeOn = false;
  focusedSince = 0;
    badgeSetAt = 0;
  lastBadgeKind = '';
  sendBadge(null);
  reportBadge(false, '', why);
}

/** 鎶婅鏍囩姸鎬佸憡璇夊涓伙紝鎸傚湪 /state 涓娿€?*/
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
    /* 蹇界暐 */
  }
}
function sendBadge(payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('ball:badge', payload);
  } catch {
    /* 蹇界暐 */
  }
}

/**
 * 鍙屽嚮灏忕悆锛欴SH 绐楀彛寮€鐫€ 鈫?鏈€灏忓寲锛涙渶灏忓寲鐫€ 鈫?杩樺師锛涢殣钘忓埌鎵樼洏/娌″惎鍔?鈫?鎷夎捣銆? *
 * Node 娌℃湁鍘熺敓 Win32锛屾墍浠ュ€?PowerShell 璋?user32銆備絾**姣忔鍙屽嚮鍐峰惎鍔ㄤ竴娆? * PowerShell锛堣繕瑕佺幇鍦虹紪璇?C#锛夎 300~400ms**锛屾墜鎰熷緢宸€? * 鎵€浠ヨ繖閲屾敼鎴愶細绗竴娆＄敤鍒版椂璧蜂竴涓?*甯搁┗**鐨?PowerShell锛屼箣鍚庡弻鍑诲彧寰€瀹?stdin
 * 鍐欎竴琛?"toggle"锛屽欢杩熼檷鍒板嚑鍗佹绉掋€? */
const DSH_TOGGLE_PS = [
  /* 注意：这个脚本里**不要写中文注释**。
     PowerShell 5 按 ANSI 读无 BOM 的 .ps1，中文会被解成乱码，
     甚至把换行吃掉、让下一行代码并进注释（踩过两次）。 */
  '$ErrorActionPreference = "SilentlyContinue"',
  '# kill stale instances left by a force-killed helper',
  `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*dsh-toggle-loop.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  '[StructLayout(LayoutKind.Sequential)] public struct EBRECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '[StructLayout(LayoutKind.Sequential)] public struct EBPOINT { public int X; public int Y; }',
  'public class EBW32 {',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
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
  '[Console]::Out.WriteLine("ready")',
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $cmd = $line.Trim()',
  '  if ($cmd -ne "toggle" -and $cmd -ne "focus") { continue }',
  '  $p = [System.Diagnostics.Process]::GetProcessesByName("DeepSeek Harness") | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1',
  '  if ($cmd -eq "focus") {',
  '    $isFg = ($null -ne $p) -and ($p.MainWindowHandle -eq [EBW32]::GetForegroundWindow())',
  '    [Console]::Out.WriteLine("focus=" + [int]$isFg)',
  '    [Console]::Out.Flush()',
  '    continue',
  '  }',
  '  if (-not $p) {',
  '    if ($env:EB_DSH_EXE) { Start-Process $env:EB_DSH_EXE }',
  '    [Console]::Out.WriteLine("ok none")',
  '    [Console]::Out.Flush()',
  '    continue',
  '  }',
  '  $h = $p.MainWindowHandle',
  '  # Decide by occlusion, not by foreground: overlays such as dsh-pet constantly',
  '  # steal the foreground, so "is DSH foreground" is false even while you look at it.',
  '  # Hit-test the centre of the DSH window:',
  '  #   centre belongs to DSH  -> you can see it -> minimise',
  '  #   centre belongs to another window, or window is minimised/hidden -> raise it',
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
/** 用完后保活 3 分钟：连续操作不用反复冷启动，闲着就把 73MB 还回去。 */
const TOGGLE_IDLE_MS = 3 * 60 * 1000;
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
 * 甯稿紑锛氫笉鍋氱┖闂查€€鍑猴紙鐢ㄦ埛瑕佹眰鍙屽嚮姘歌繙绉掑搷搴旓級銆? * 甯搁┗鐨?PowerShell 绾?80MB锛屽彧鍦?helper 鑷繁閫€鍑烘椂鐢?stopToggleProc 鏀舵帀锛? * 鑻ヤ笂娆¤寮烘潃鐣欎笅娈嬬暀锛屾柊瀹炰緥鍚姩鏃惰剼鏈紑澶寸殑鑷剤浼氭竻鎺夊悓鍚嶈繘绋嬨€? */
function touchToggleIdle() {
  if (settings.lowLatency) return; // 低延迟模式：常驻，不自动退出
  if (toggleIdleTimer) clearTimeout(toggleIdleTimer);
  toggleIdleTimer = setTimeout(() => {
    toggleIdleTimer = null;
    stopToggleProc();
  }, TOGGLE_IDLE_MS);
}

/** 鎳掑惎鍔ㄥ父椹?PowerShell锛堢涓€娆″弻鍑讳細鎱竴鐐癸紝涔嬪悗涓€鐩存槸鐑殑锛夈€?*/
function ensureToggleProc() {
  if (toggleProc && toggleProc.exitCode === null) return toggleProc;
  /* 冷启动没有「刚才」，先用上次持久化的焦点状态，避免第一次双击判错方向 */
  if (typeof settings.lastFocus === 'boolean') dshForeground = settings.lastFocus;
  try {
    /* 蹇呴』钀界洏鐢?-File 璺戯細鎶婂甫 here-string 鐨勫琛岃剼鏈杩?-Command锛?       PowerShell 瑙ｆ瀽涓嶄簡锛圓dd-Type 闈欓粯澶辫触锛岀粨鏋滃弻鍑绘鏃犲弽搴旓級銆?*/
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
  const cold = !toggleProc || toggleProc.exitCode !== null;
  const proc = ensureToggleProc();
  /* 冷启动要 300-400ms：先亮一个「…」给手反馈，1.2 秒后按真实状态收掉 */
  if (cold && proc) {
    sendBadge({ kind: 'pending', text: '…' });
    setTimeout(() => {
      if (badgeOn) sendBadge({ kind: lastBadgeKind || 'done', text: badgeText(lastBadgeKind) });
      else sendBadge(null);
    }, 1200);
  }
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
    /* 绠￠亾鏂簡灏遍噸鏉ヤ竴娆?*/
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

/** 閫€鍑烘椂鎶婂父椹?PowerShell 鍏虫帀锛屽埆鐣欏鍎胯繘绋嬨€?*/
function stopToggleProc() {
  if (!toggleProc) return;
  const proc = toggleProc;
  toggleProc = null;
  try {
    proc.stdin.end();
  } catch {
    /* 蹇界暐 */
  }
  setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* 蹇界暐 */
    }
  }, 300);
}

function openDsh() {
  /* 澶嶇敤 DSH 鑷繁鐨勫崟瀹炰緥閿侊細宸茬粡鍦ㄨ窇灏卞彧鏄仛鐒︼紝涓嶄細寮€绗簩涓獥鍙?*/
  const target = dshExe || args.get('dsh-exe');
  if (!target) return;
  try {
    const child = spawn(target, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* 鍚姩澶辫触灏卞畨闈欏湴绠椾簡 */
  }
}

function createWindow() {
  const saved = readPosition() || defaultPosition();
  /* 璁板繂鐨勬槸鐞冪殑宸︿笂瑙掞紱绐楀彛鍐呭姣旂悆澶т竴鐐癸紝鍏堝缓鍦ㄧ悆鐨勫師鐐癸紝鍒涘缓鍚庡啀鎸夊疄娴嬪昂瀵告崲绠椼€?*/
  const position = clampToDisplays(saved);
  win = new BrowserWindow({
    x: position.x,
    y: position.y,
    width: BALL_SIZE,
    height: BALL_SIZE,
    frame: false,
    /* Windows 涓婇粯璁よ繕鏈変竴灞備笉鍙鐨?WS_THICKFRAME锛?px锛夛紝
       浼氳 outer/content 灏哄鐩稿樊 4px锛屾嫋鍔ㄦ椂瓒婃嫋瓒婂ぇ銆傚叧鎺夊畠銆?*/
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

  /* 绐楀彛鍐呭姣旂悆澶у嚭杈圭紭锛堝疄娴?4px锛夈€傛寜瀹炴祴宸€兼妸绐楀彛寰€鍥炴尓锛?     璁╃悆姝ｅソ钀藉湪璁颁綇鐨勪綅缃笂鈥斺€斿惁鍒欐瘡娆″惎鍔ㄩ兘浼氭紓涓€鐐广€?*/
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
    /* 蹇界暐 */
  }

  win.loadURL(ballUrl());

  const present = () => {
    if (!win || win.isDestroyed()) return;
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    savePosition(ballPosition());
  };
  win.once('ready-to-show', present);
  /* 閫忔槑鏃犺竟妗嗙獥鍦ㄩ儴鍒嗙幆澧冮噷 ready-to-show 浼氳繜鍒扮敋鑷充笉瑙﹀彂锛屽厹涓€灞傚畾鏃躲€?*/
  setTimeout(present, 900);

  win.on('closed', () => {
    win = null;
  });

  /* 椤甸潰閲岀殑 JS 閿欒涔熷啓杩涜瘖鏂棩蹇楋紝鏂逛究鏃犵晫闈㈡帓鏌?*/
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) logInput('console[' + level + '] ' + String(message).slice(0, 160));
  });

  win.webContents.on('did-finish-load', () => {
    lastEmotion = null;
    /* 鎹富棰樹細閲嶈浇椤甸潰锛氭柊椤甸潰鏄敹璧风殑锛岀獥鍙ｄ篃寰楃缉鍥炵悆鐨勫昂瀵革紝鍚﹀垯浼氱暀涓€鍧楅€忔槑澶х獥 */
    if (expanded) {
      const ball = ballPosition();
      expanded = false;
      layout = 'up';
      targetSize = { width: BALL_SIZE, height: BALL_SIZE };
      if (ball) win.setContentBounds({ x: ball.x, y: ball.y, width: BALL_SIZE, height: BALL_SIZE });
      if (badgeOn) sendBadge({ kind: lastBadgeKind || 'done', text: badgeText(lastBadgeKind) });
    }
    startPolling();
    broadcastSettings();
  });

  startHitTest();
  return win;
}

/* ---------------- 娓叉煋杩涚▼鍙戞潵鐨勬嫋鍔?鍔ㄤ綔 ---------------- */

ipcMain.on('ball:drag-start', () => {
  logInput('pointerdown');
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  /* 璁?outer bounds锛氭嫋鍔ㄥ彧鐢?setPosition 鏀逛綅缃紝缁濅笉鍐欏昂瀵糕€斺€?     鍐欏昂瀵镐細鍦?DPI 缂╂斁涓嬪弽澶嶆崲绠楋紝瓒婃嫋瓒婂ぇ銆?*/
  dragState = { cursor, outer: win.getBounds() };
  clearLeaveTimer();
});

/** 璇婃柇锛氭妸杈撳叆浜嬩欢鍐欏埌鏂囦欢锛屼究浜庡湪鏃犵晫闈㈢幆澧冧笅纭绐楀彛鏄惁鏀跺埌榧犳爣銆?*/
function logInput(kind) {
  if (!DEV_MODE) return; // 姝ｅ紡杩愯涓嶅啓璇婃柇鏂囦欢
  try {
    const file = path.join(app.getPath('userData'), 'input.log');
    fs.appendFileSync(file, `${new Date().toISOString()} ${kind}\n`);
  } catch {
    /* 蹇界暐 */
  }
}

ipcMain.on('ball:drag-to', (_event, dx, dy) => {
  if (!win || win.isDestroyed() || !dragState) return;
  /* 鍙敼浣嶇疆銆佷笉鏀瑰昂瀵革細setPosition 涓嶄細纰板楂橈紝灞曞紑鏃剁獥鍙ｅぇ灏忎繚鎸佷笉鍙橈紝
     鐞冧篃灏变笉浼?璺?鍒伴潰鏉垮乏涓婅銆?*/
  const origin = dragState.outer;
  const next = clampToDisplays(
    {
      x: Math.round(origin.x + Number(dx || 0)),
      y: Math.round(origin.y + Number(dy || 0)),
    },
    targetSize,
  );
  /* 灏哄姘歌繙鍐?targetSize 杩欎釜甯搁噺锛歴etPosition 浼氶噸濂?DWM 杈规锛?     鑰屼粠 getBounds 璇诲洖灏哄鍐嶅啓浼氬湪 DPI 缂╂斁涓嬫紓绉汇€?*/
  win.setContentBounds({ x: next.x, y: next.y, width: targetSize.width, height: targetSize.height });
});

ipcMain.on('ball:drag-end', () => {
  if (win && !win.isDestroyed()) savePosition(ballPosition());
  dragState = null;
});

ipcMain.on('ball:open-dsh', () => toggleDshWindow());

/** 鍙抽敭鑿滃崟涓庤缃€?*/
ipcMain.on('ball:set-setting', (_event, key, value) => {
  if (key === 'gaze') settings.gaze = value !== false;
  else if (key === 'lowLatency') {
    /* 低延迟模式：开启就预热常驻 + 不自动退出；关闭就立刻收回内存 */
    settings.lowLatency = value === true;
    if (settings.lowLatency) {
      ensureToggleProc();
      startFocusPolling();
      touchToggleIdle();
    } else {
      stopToggleProc();
    }
  }
  else if (key === 'theme' && (value === 'auto' || value === 'dark' || value === 'light')) {
    settings.theme = value;
    /* 鍚屾椂璇锋眰鎶婃暣涓?DSH 涔熷垏杩囧幓锛氶〉闈㈠崐渚ц疆璇?/theme 鍐嶈皟 ctx.theme.setTheme */
    const mapped = value === 'auto' ? 'system' : value;
    try {
      const request = require('node:http').get(ORIGIN + '/theme?set=' + mapped, (response) => response.resume());
      request.on('error', () => {});
    } catch {
      /* 蹇界暐 */
    }
    if (win && !win.isDestroyed()) win.loadURL(ballUrl());
  }
  saveSettings();
  broadcastSettings();
  if (key === 'auto') {
    /* 鍗犱綅锛岄伩鍏嶇┖鍒嗘敮 */
  }
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
 * DSH 鐨勪富棰樺亸濂藉彉浜嗭紙鐢ㄦ埛鍦ㄥ埆澶勬敼鐨勶級鈫?妗岄潰鐞冭窡鐫€鎹€? * DSH 鐨?'system' 瀵瑰簲鐞冪殑 'auto'锛涚浉鍚屽氨涓嶅姩锛岄伩鍏嶆潵鍥為噸杞姐€? */
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
          /* 蹇界暐 */
        }
      });
    })
    .on('error', () => {});
}

/** 鐪肩璺熼殢锛氭妸銆屽厜鏍囩浉瀵圭悆蹇冪殑鏂瑰悜銆嶅綊涓€鍖栧悗鎺ㄧ粰椤甸潰锛?0ms 涓€娆★紝澶熼『婊戜篃涓嶈垂锛夈€?*/
function pushGaze(cursor) {
  if (!settings.gaze || !win || win.isDestroyed()) return;
  const rects = interactiveRects();
  const ball = rects[0];
  const cx = ball.x + ball.width / 2;
  const cy = ball.y + ball.height / 2;
  const nx = Math.max(-1, Math.min(1, (cursor.x - cx) / GAZE_RADIUS));
  const ny = Math.max(-1, Math.min(1, (cursor.y - cy) / GAZE_RADIUS));
  try {
    win.webContents.send('ball:gaze', { x: nx, y: ny });
  } catch {
    /* 蹇界暐 */
  }
}

/**
 * 灞曞紑 / 鏀惰捣锛氱獥鍙?= 鐞?+ 闈㈡澘 鐨勫苟闆嗭紝骞朵繚璇?*鐞冪殑灞忓箷浣嶇疆涓嶅姩**銆? * 骞堕泦蹇呯劧鏈夈€岀┖鐧借钀姐€嶏紝鎵€浠ョ獥鍙ｄ笉鑳芥暣鍧楀悆榧犳爣鈥斺€? * 鐢变富杩涚▼鎸夊厜鏍囦綅缃仛鍛戒腑妫€娴嬶紝鍙湪灏忕悆/闈㈡澘涓婅В闄?setIgnoreMouseEvents銆? */
ipcMain.on('ball:expand', (_event, size) => {
  if (!win || win.isDestroyed()) return;
  const width = Math.max(180, Math.round(Number(size && size.width) || panelSize.width));
  const height = Math.max(120, Math.round(Number(size && size.height) || panelSize.height));
  panelSize = { width, height };
  const bounds = win.getContentBounds();
  /* 鐞冪殑灞忓箷浣嶇疆锛歶p 鏃跺湪绐楀彛鍙充笅瑙掞紝down 鏃跺湪鍙充笂瑙掞紱宸﹀彸鍚岀悊銆?*/
  const ballRight = bounds.x + bounds.width;
  const ballLeft = ballRight - BALL_SIZE;
  const ballTop = layout === 'up' ? bounds.y + bounds.height - BALL_SIZE : bounds.y;
  const area = screen.getDisplayNearestPoint({ x: ballLeft, y: ballTop }).workArea;
  const boxWidth = Math.max(BALL_SIZE, width);

  /* 绔栫洿锛氫紭鍏堟湞涓婏紙鐞冨湪搴曪級锛屼笂闈笉澶熷氨鏈濅笅锛涗袱杈归兘涓嶅灏辫创鐫€涓婅竟 */
  const up = ballTop - 8 - height >= area.y;
  const downFits = ballTop + BALL_SIZE + 8 + height <= area.y + area.height;
  layout = up ? 'up' : 'down';
  let y = up ? Math.round(ballTop - 8 - height) : Math.round(ballTop);
  if (!up && !downFits) y = Math.round(Math.max(area.y, Math.min(y, area.y + area.height - BALL_SIZE)));

  /* 姘村钩锛氫紭鍏堝悜鐞冨乏渚у睍寮€锛涘乏杈逛笉澶熷氨缈诲埌鍙充晶锛涢兘涓嶅灏卞す鍦ㄥ睆鍐?*/
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

  const next = {
    x,
    y,
    width: boxWidth,
    height: (up ? height : height) + 8 + BALL_SIZE,
  };
  if (!win.isDestroyed()) {
    try {
      win.webContents.send('ball:layout', { vertical: layout, align });
    } catch {
      /* 蹇界暐 */
    }
  }
  expanded = true;
  panelAlign = align;
  targetSize = { width: next.width, height: next.height };
  clearLeaveTimer();
  logInput('expand to ' + JSON.stringify(next) + ' layout=' + layout + '/' + align);
  win.setContentBounds(next);
});

ipcMain.on('ball:collapse', () => {
  if (!win || win.isDestroyed()) return;
  const ball = ballPosition();
  expanded = false;
  layout = 'up';
  panelAlign = 'right';
  targetSize = { width: BALL_SIZE, height: BALL_SIZE };
  logInput('collapse');
  if (ball) win.setContentBounds({ x: ball.x, y: ball.y, width: BALL_SIZE, height: BALL_SIZE });
});

/** 灏忕悆 / 闈㈡澘鐨勫睆骞曠煩褰紝鐢ㄤ簬鍛戒腑妫€娴嬨€?*/
function interactiveRects() {
  const bounds = win.getContentBounds();
  if (!expanded) return [{ x: bounds.x, y: bounds.y, width: BALL_SIZE, height: BALL_SIZE }];
  /* 闈㈡澘鍖哄煙鐩存帴鐢卞綋鍓嶇獥鍙ｆ帹瀵硷細绐楀彛 = 闈㈡澘 + 闂撮殭 + 鐞冿紝
     杩欐牱涓嶄細鍥犱负 panelSize 璁扮殑鏄棫鍊艰€岃闈㈡澘椤堕儴鐐逛笉鍒般€?*/
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
        /* forward:true 鈥斺€?绌块€忔椂浠嶇劧鎶婄Щ鍔ㄤ簨浠惰浆缁欓〉闈紝榧犳爣杩涘埌鐞冧笂鑳界珛鍒绘仮澶?*/
        win.setIgnoreMouseEvents(ignore, { forward: true });
      } catch {
        /* 蹇界暐 */
      }
    }
    /* 鍏夋爣绂诲紑鐞冨拰闈㈡澘锛氱瓑涓€灏忎細鍎垮氨鏀堕潰鏉匡紙妗岄潰绐楀彛鍚笉鍒般€屽闈㈢殑鐐瑰嚮銆嶏紝
       鍙兘鐢ㄣ€岀寮€銆嶆潵杩戜技鐐瑰閮ㄥ叧闂級銆?*/
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
    /* 璋冭壊鏉挎槸寮曟搸娉ㄥ唽鍓嶆敼鐨勭瀛愶紝鍙兘閲嶈浇椤甸潰锛涢噸杞藉悗 did-finish-load 浼氶噸鏂版媺鐘舵€?*/
    if (win && !win.isDestroyed()) win.loadURL(`${ORIGIN}/ball.html?surface=desktop&theme=${theme}&v=9`);
  }
});

/* ---------------- 鐢熷懡鍛ㄦ湡 ---------------- */

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

    /* 绌洪棽鏃堕鐑父椹?PowerShell锛氬弻鍑荤涓€娆′篃涓嶇敤绛夊喎鍚姩 */
    setTimeout(() => {
      /* 默认按需启动：不预热，省掉 70MB 常驻；开了「低延迟模式」才预热常驻。 */
      if (!settings.lowLatency) return;
      try {
        ensureToggleProc();
        startFocusPolling();
        touchToggleIdle();
      } catch {
        /* 忽略 */
      }
    }, 3000);

    /* 鑷妯″紡锛氬湪椤甸潰閲屾淳鍙戠湡瀹炵殑 PointerEvent锛岃蛋涓€閬嶃€屽睍寮€ 鈫?鎷栧姩銆嶏紝
       姣忔鎵撳嵃绐楀彛 bounds銆傛瘮澶栭儴鍚堟垚榧犳爣浜嬩欢鍙潬锛堜笉浼氭挒鍒伴潰鏉挎牸瀛愶級銆?*/
    if (DEV_MODE && args.get('selftest') !== undefined) {
      /* 涓嶇敤 did-finish-load锛歝reateWindow 閲屽凡缁?loadURL锛岃繖涓簨浠跺彲鑳藉凡缁忚繃鍘讳簡 */
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

    /* --paneltest=1锛氬睍寮€ 鈫?鍒囥€屽叏閮ㄣ€嶁啋 鐪嬬悆鏈夋病鏈夎窇浣?*/
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

    /* --menutest=1锛氳剼鏈洿杩為〉闈紝楠岃瘉鍙抽敭鑿滃崟涓庝富棰樺垏鎹紙涓嶄緷璧栧悎鎴愰紶鏍囷級 */
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
        /* 鍙瓑 250ms锛氭闈㈢悆鏈夈€屽厜鏍囩寮€ 500ms 灏辨敹璧枫€嶇殑鍚彂寮忥紝鍚堟垚娴嬭瘯閲屽厜鏍囦笉鍦ㄧ悆涓?*/
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
      win.loadURL(`${ORIGIN}/ball.html?surface=desktop&theme=${themeName()}&v=9`);
    });

    if (probePath) {
      /* 鑷妯″紡锛氭墦鍗拌瘖鏂紙鍙€夋埅鍥撅級锛岀劧鍚庨€€鍑恒€傜粰涓嶅甫鐣岄潰鐨勭幆澧冮獙璇佺敤銆?*/
      setTimeout(() => {
        console.log(JSON.stringify({ probe: 'timeout' }));
        app.exit(2);
      }, 20000);
      win.webContents.once('did-finish-load', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const state = await fetchState();
        if (state) await applyEmotion(state.emotion);
        /* --badge=done|error锛氭妸瑙掓爣鐐逛寒锛屼究浜庢埅鍥剧‘璁ゆ覆鏌?*/
        /* --badgeipc=done锛氳蛋鐪熷疄鐨?ball:badge IPC锛堥獙璇?preload 鈫?椤甸潰杩欐潯璺級 */
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
