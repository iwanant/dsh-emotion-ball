/**
 * dsh-emotion-ball —— 宿主半侧
 *
 * 两件事：
 *   1. 把随包的 Emotion Ball（球球 blob 形象）挂到 127.0.0.1:8766，
 *      给客户端半侧的 <iframe> 加载。只服务白名单里的文件，不做通用静态目录。
 *   2. 注册 set_emotion 工具，让 agent 能主动设定表情。
 *
 * 为什么只服务白名单：路径穿越在路由解析阶段就不存在（没有把 URL 拼进文件路径），
 * 比事后做 ../ 校验更难出错。
 *
 * set_emotion 不需要和客户端做 RPC：工具调用会作为 tool/call 事件进入会话日志，
 * 客户端半侧订阅会话事件流就能看到 { emotionId, note }。日志即真相，
 * 刷新页面 / 重开会话后表情状态也能从日志重建。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createEmotionState } from './lib/state.js';
import { createRuntimeInstaller, ELECTRON_VERSION } from './lib/runtime.js';

/** ESM 里没有 require：借一份用来取 Electron 的 BrowserWindow。 */
const nodeRequire = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = path.join(HERE, 'assets', 'emotion-ball');

/** 客户端半侧写死同一个端口，改这里必须同步改 client.js。 */
export const PORT = 8766;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** 只暴露球球引擎需要的四个脚本，其余一律 404。 */
const SCRIPTS = ['rings.js', 'emotions.js', 'ball.js', 'engine.js'];

/** 状态机心跳：保持期（比如「任务完成」2 秒）靠它推进。 */
const TICK_MS = 500;

/** 当前进程里的状态机实例；/state 读它。 */
let liveState = null;

/** 桌面球请求切换 DSH 主题；页面半侧轮询 seq 变化后调 ctx.theme.setTheme。 */
let themeRequest = { theme: null, seq: 0 };

/** DSH 页面是否在前台；桌面球据此决定要不要弹系统通知。 */
let dshFocused = null;
/** 桌面球 helper 自己用 Win32 问出来的前景窗口状态（比页面上报可靠）。 */
let helperFocused = null;
/** 用户最近一次在 DSH 页面里操作的时间戳（点/滚/按键）。 */
let lastActivityAt = 0;
/** 诊断：/state 被读过多少次「pending 为真」，用来确认待回答状态有没有上报。 */
let pendingSeen = 0;
/** 诊断：最近 20 条会话事件（排查 pending 为什么没清）。 */
const recentEvents = [];

/** 桌面球上报的角标状态，挂在 /state 上，便于排查「为什么没提醒」。 */
let badgeState = null;
/** 读取焦点失败时的原因，挂在 /state 里排查用。 */
let focusError = '';

/** 焦点以页面上报为准：宿主是 ESM 且插件目录解析不到 electron 模块，拿不到 BrowserWindow。 */
function readDshFocused() {
  try {
    /* 宿主半侧是 ESM，没有全局 require —— 之前这行一直静默失败，
       dshFocused 恒为 null，「你在看就不提醒」从未生效。用 createRequire 借一份。 */
    const electron = nodeRequire('electron');
    const windows = electron.BrowserWindow.getAllWindows();
    if (!windows.length) return null;
    return windows.some((item) => !item.isDestroyed() && item.isVisible() && item.isFocused());
  } catch (error) {
    focusError = String((error && error.message) || error);
    return null;
  }
}

/** set_emotion 的参数是 JSON 字符串。 */
function parseArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 桌面球（Electron helper）                                           */
/* ------------------------------------------------------------------ */

/** 桌面球开关：默认开；设 DSH_EMOTION_BALL_DESKTOP=0 可临时关掉（过渡期调试用）。 */
const DESKTOP_BALL_ENABLED = process.env.DSH_EMOTION_BALL_DESKTOP !== '0';

/**
 * 自备 Electron 运行时的安装器：**不借用 dsh-pet**，删掉它球也不会报废。
 * 存在 ~/.dsh/emotion-ball-runtime/ 下，跟着用户目录走。
 */
const runtimeRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'emotion-ball-runtime');
const runtimeInstaller = DESKTOP_BALL_ENABLED
  ? createRuntimeInstaller({
      rootDir: runtimeRoot,
      onChange: (progress) => {
        if (progress.state === 'error') console.warn('[emotion-ball] 运行时准备失败:', progress.error);
        if (progress.state === 'ready') {
          console.info('[emotion-ball] 运行时就绪:', progress.targetDir);
          if (!desktopChild) {
            desktopChild = startDesktopBall(resolveElectron());
          }
        }
      },
    })
  : null;

/** 桌面球进程，避免重复启动。 */
let desktopChild = null;

/**
 * 找 Electron 运行时：**只认自己那份**（或显式环境变量）。
 * 刻意不再借用 dsh-pet 的 `$DSH_HOME/electron`——用户删掉 dsh-pet 时球会一起报废。
 * 自己没有就返回 null，由 ensureRuntime() 去下载。
 */
function resolveElectron() {
  const override = process.env.DSH_EMOTION_BALL_ELECTRON;
  if (override && fs.existsSync(override)) return override;
  return runtimeInstaller ? runtimeInstaller.electronPath() : null;
}

/** DSH 自己的可执行文件，双击小球时用它拉起（单实例锁会把它变成「聚焦」）。 */
function resolveDshExe() {
  const candidates = [process.execPath, process.env.DSH_APP_EXE];
  for (const candidate of candidates) {
    if (candidate && /\.exe$/i.test(candidate) && /deepseek/i.test(path.basename(candidate))) return candidate;
  }
  return null;
}
function startDesktopBall(electron) {
  const target = electron || resolveElectron();
  if (!target) {
    console.warn('[emotion-ball] 还没有可用的 Electron 运行时，桌面球不启动');
    return null;
  }
  const env = { ...process.env };
  /* 这个环境里 ELECTRON_RUN_AS_NODE=1：不清掉的话 electron.exe 会退化成纯 node，
     require('electron') 直接报 MODULE_NOT_FOUND。 */
  delete env.ELECTRON_RUN_AS_NODE;

  const helperDir = path.join(HERE, 'helper');
  const dshExe = resolveDshExe();
  const argv = [helperDir];
  if (dshExe) argv.push(`--dsh-exe=${dshExe}`);

  try {
    const child = spawn(target, argv, { stdio: 'ignore', env });
    child.on('error', (error) => {
      console.warn('[emotion-ball] 桌面球启动失败:', error && error.message);
    });
    child.on('exit', (code) => {
      if (code !== 0) console.warn('[emotion-ball] 桌面球退出，code =', code);
    });
    console.info('[emotion-ball] 桌面球已启动', { electron: target, dshExe: dshExe || '(未找到)' });
    return child;
  } catch (error) {
    console.warn('[emotion-ball] 桌面球 launch 异常:', error && error.message);
    return null;
  }
}

function stopDesktopBall(child) {
  if (!child || child.killed) return;
  try {
    child.kill();
  } catch {
    /* 已经没了 */
  }
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function typeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** URL 路径 → 真实文件；不在白名单内返回 null（不做字符串拼接式查找）。 */
function resolveRoute(pathname) {
  if (pathname === '/' || pathname === '' || pathname === '/ball.html') {
    return { file: path.join(ASSET_ROOT, 'ball.html') };
  }
  if (pathname === '/health') return { file: null, body: 'dsh-emotion-ball' };
  if (pathname === '/state') return { file: null, body: null, state: true };
  if (pathname === '/manual') return { file: null, body: null, manual: true };
  if (pathname === '/emotions.json') return { file: null, body: null, catalog: true };
  if (pathname === '/theme') return { file: null, body: null, theme: true };
  if (pathname === '/focus') return { file: null, body: null, focus: true };
  if (pathname === '/badge') return { file: null, body: null, badge: true };
  if (pathname === '/runtime/retry') return { file: null, body: null, runtimeRetry: true };
  if (pathname === '/activity') return { file: null, body: null, activity: true };
  /* 本机调试：模拟「等你回答」的开始/结束，用来测量角标延迟 */
  if (pathname === '/debug/pending') return { file: null, body: null, debugPending: true };
  const script = /^\/js\/([A-Za-z0-9_-]+\.js)$/.exec(pathname);
  if (script && SCRIPTS.includes(script[1])) {
    return { file: path.join(ASSET_ROOT, 'js', script[1]) };
  }
  return null;
}

function handle(req, res) {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'method not allowed');
    }
    const url = new URL(req.url || '/', ORIGIN);
    const route = resolveRoute(url.pathname);
    if (!route) return send(res, 404, 'not found');
    if (route.manual) {
      /* 桌面球点选表情时调这里：进入手动模式；clear=1 表示恢复自动。
         只监听回环地址，且只影响这个装饰件的状态。 */
      const id = url.searchParams.get('id');
      const note = url.searchParams.get('note') || '';
      if (url.searchParams.get('clear') === '1') {
        if (liveState) liveState.releaseManual();
      } else if (liveState && typeof id === 'string' && /^\d{2}$/.test(id)) {
        liveState.setManual(id, note.slice(0, 240));
      }
      return send(res, 200, JSON.stringify(liveState ? liveState.snapshot : {}), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
    if (route.theme) {
      /* set=light|dark|system：桌面球菜单点的。页面半侧轮询 seq 变化后应用到 DSH。 */
      const requested = url.searchParams.get('set');
      if (requested === 'light' || requested === 'dark' || requested === 'system') {
        themeRequest = { ...themeRequest, theme: requested, seq: themeRequest.seq + 1 };
      }
      /* report：页面半侧上报 DSH 当前偏好，桌面球据此跟随（不动 seq，避免来回触发） */
      const reported = url.searchParams.get('report');
      if (reported === 'light' || reported === 'dark' || reported === 'system') {
        themeRequest = { ...themeRequest, reported };
      }
      return send(res, 200, JSON.stringify(themeRequest), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
    if (route.catalog) {
      const catalog = emotionCatalog();
      const items = [...catalog.entries()].map(([id, info]) => ({ id, name: info.name, group: info.group }));
      return send(res, 200, JSON.stringify(items), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
    if (route.activity) {
      lastActivityAt = Date.now();
      return send(res, 200, JSON.stringify({ at: lastActivityAt }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
    if (route.debugPending) {
      /* 只在开发模式下开放：正常运行时这个入口是死的 */
      if (process.env.DSH_EMOTION_BALL_DEV !== '1' || url.searchParams.get('token') !== 'dev') {
        return send(res, 403, 'forbidden');
      }
      const on = url.searchParams.get('on') === '1';
      if (liveState) liveState.setPending(on);
      return send(res, 200, JSON.stringify({ pending: on, at: Date.now() }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
    if (route.runtimeRetry) {
      if (!runtimeInstaller) return send(res, 400, 'desktop disabled');
      runtimeInstaller.reset();
      runtimeInstaller.ensure().catch(() => {});
      return send(res, 200, JSON.stringify(runtimeInstaller.progress), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
    if (route.badge) {
      const on = url.searchParams.get('on') === '1';
      let parsedLog = null;
      const rawLog = url.searchParams.get('log');
      if (rawLog) {
        try {
          parsedLog = JSON.parse(rawLog);
        } catch {
          parsedLog = null;
        }
      }
      badgeState = on
        ? { on: true, kind: url.searchParams.get('kind') || '', why: url.searchParams.get('why') || '', at: Date.now() }
        : { on: false, why: url.searchParams.get('why') || '', at: Date.now() };
      if (parsedLog) badgeState.log = parsedLog;
      return send(res, 200, JSON.stringify(badgeState), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
    if (route.focus) {
      const value = url.searchParams.get('f');
      if (value === '1' || value === '0') {
        if (url.searchParams.get('src') === 'helper') helperFocused = value === '1';
        else dshFocused = value === '1';
      }
      return send(res, 200, JSON.stringify({ focused: dshFocused, helperFocused }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
    if (route.state) {
      const snapshot = liveState ? liveState.snapshot : { emotion: '02', mode: 'auto', note: '' };
      const debug = liveState ? liveState.debug() : {};
      const payload = {
        emotion: snapshot.emotion,
        turns: snapshot.turns,
        mode: snapshot.mode,
        note: snapshot.note,
        dshFocused,
        helperFocused,
        lastActivityAt,
        badge: badgeState,
        runtime: runtimeInstaller ? runtimeInstaller.progress : null,
        recent: recentEvents,
        focusError,
        ...debug,
        server: 'dsh-emotion-ball',
      };
      if (payload.pending === true) pendingSeen += 1;
      payload.pendingSeen = pendingSeen;
      return send(res, 200, JSON.stringify(payload), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
    if (route.body !== undefined) {
      return send(res, 200, route.body, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    fs.readFile(route.file, (error, buffer) => {
      if (error) return send(res, 404, 'not found');
      send(res, 200, req.method === 'HEAD' ? '' : buffer, { 'Content-Type': typeOf(route.file) });
    });
  } catch {
    try {
      send(res, 500, 'internal error');
    } catch {
      /* socket 已断，忽略 */
    }
  }
}

let catalogCache;

/**
 * 从引擎自带的 emotions.js 里取 ID → 名称，作为 set_emotion 的校验与展示来源。
 * 失败不致命：退化成「只校验 ID 形如两位数字」。
 */
export function emotionCatalog() {
  if (catalogCache) return catalogCache;
  const fallback = new Map();
  try {
    const source = fs.readFileSync(path.join(ASSET_ROOT, 'js', 'emotions.js'), 'utf8');
    const sandbox = { window: {} };
    vm.runInNewContext(source, sandbox, { timeout: 1000, filename: 'emotions.js' });
    const seed = sandbox.window && sandbox.window.EMOTION_SEED;
    if (Array.isArray(seed)) {
      for (const item of seed) {
        if (!item || typeof item.id !== 'string') continue;
        fallback.set(item.id, {
          name: typeof item.name === 'string' ? item.name : item.id,
          group: typeof item.group === 'string' ? item.group : 'custom',
        });
      }
    }
  } catch (error) {
    console.warn('[emotion-ball] 无法读取 emotions.js，退化为宽松校验:', error && error.message);
  }
  catalogCache = fallback;
  return catalogCache;
}

function describeCatalog() {
  const catalog = emotionCatalog();
  if (catalog.size === 0) return '可用 ID: 00-07 生命周期, 10-21 情绪, 30-41 代理状态';
  return [...catalog.entries()].map(([id, info]) => `${id} ${info.name}`).join('，');
}

const SET_EMOTION_TOOL = {
  name: 'set_emotion',
  description: [
    'Set the mood of the Emotion Ball indicator (bottom-right of the UI).',
    'Use it for reactions the system cannot observe: unease about a piece of code,',
    'confidence in a plan, wanting to complain. The transcript shows only a tiny chip,',
    'so this does not interrupt reading; keep calls rare.',
    'IDs: 00-07 lifecycle, 10-21 moods, 30-41 agent work states.',
    'Common ones: 16 专注, 11 疑惑, 19 满意, 21 生气, 10 开心, 38 拒绝, 41 停止.',
  ].join(' '),
  parameters: {
    type: 'object',
    properties: {
      emotionId: {
        type: 'string',
        description: 'Two-digit emotion ID, e.g. "16".',
      },
      note: {
        type: 'string',
        description: 'Optional short reason, kept in the transcript.',
      },
    },
    required: ['emotionId'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        emotionId: { type: 'string' },
        name: { type: 'string' },
        applied: { type: 'boolean' },
        reason: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['emotionId', 'applied'],
      additionalProperties: false,
    },
    render(_args, value) {
      const result = value && typeof value === 'object' ? value : {};
      if (!result.applied) {
        return [{ type: 'text', text: `Emotion Ball unchanged: ${result.reason || 'unknown emotion id'}` }];
      }
      return [{ type: 'text', text: `Emotion Ball → ${result.emotionId} ${result.name || ''}`.trim() }];
    },
  },
  async execute(args) {
    const input = args && typeof args === 'object' ? args : {};
    const emotionId = typeof input.emotionId === 'string' ? input.emotionId.trim() : '';
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 240) : '';
    const catalog = emotionCatalog();
    if (catalog.size > 0) {
      const known = catalog.get(emotionId);
      if (!known) {
        return {
          emotionId,
          applied: false,
          reason: `unknown id "${emotionId}"`,
          note,
        };
      }
      return { emotionId, name: known.name, applied: true, note };
    }
    if (!/^\d{2}$/.test(emotionId)) {
      return { emotionId, applied: false, reason: `unknown id "${emotionId}"`, note };
    }
    return { emotionId, applied: true, note };
  },
};

/**
 * 启动静态服务器。端口占用时视为「可能已有实例」，只警告、不抛错。
 * @returns {Promise<import('node:http').Server | null>}
 */
function startServer() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const server = http.createServer(handle);
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        console.warn(`[emotion-ball] ${ORIGIN} 已被占用，沿用现有监听（小球可能来自旧实例）`);
      } else {
        console.warn('[emotion-ball] 静态服务启动失败:', error && error.message);
      }
      finish(null);
    });
    server.listen(PORT, '127.0.0.1', () => finish(server));
  });
}

export const inject = ['tools'];

/**
 * cordis 插件入口。
 * @param {any} ctx cordis 上下文
 */
export function apply(ctx) {
  let server = null;
  let disposed = false;

  ctx.effect(() => {
    if (!fs.existsSync(path.join(ASSET_ROOT, 'ball.html'))) {
      console.warn('[emotion-ball] 缺少 assets/emotion-ball/ball.html，小球会显示空白');
    }
    startServer()
      .then((started) => {
        if (disposed) {
          try {
            started && started.close();
          } catch {
            /* 关闭失败无所谓 */
          }
          return;
        }
        server = started;
      })
      .catch((error) => {
        console.warn('[emotion-ball] 初始化异常:', error && error.message);
      });
    return () => {
      disposed = true;
      if (!server) return;
      const current = server;
      server = null;
      try {
        if (typeof current.closeAllConnections === 'function') current.closeAllConnections();
        current.close();
      } catch {
        /* 关闭失败无所谓 */
      }
    };
  }, 'emotion-ball: static server');

  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    console.warn('[emotion-ball] tools 服务不可用，set_emotion 未注册');
    return;
  }
  ctx.effect(() => ctx.tools.register(SET_EMOTION_TOOL), 'emotion-ball: set_emotion tool');

  attachStateMachine(ctx);

  /* 桌面球：插件的生命周期就是它的生命周期。
     运行时没准备好时先去下载，下好了 onChange 里再启动。 */
  ctx.effect(() => {
    if (!DESKTOP_BALL_ENABLED || !runtimeInstaller) {
      return () => {};
    }
    /* 有就直接起（安装器会先把状态置 ready），没有就去下载；
       下载完成后 onChange 里会启动。 */
    runtimeInstaller.ensure().catch(() => {
      /* onChange 里已经记录了错误，页面会显示 */
    });
    return () => {
      stopDesktopBall(desktopChild);
      desktopChild = null;
    };
  }, 'emotion-ball: desktop helper');
}

/**
 * 把宿主侧状态机接到 DSH 的真实事件上，并把当前表情挂到 /state。
 *
 * 这几个信号都是「宿主已广播、不影响别人」的观察点：
 *   session/event        —— turn/start、turn/end、tool/call、tool/result（可观测事实）
 *   agent/status         —— 运行/空闲
 *   approval/request     —— 等用户批准
 *   user-questions/request —— 等用户回答
 * 后两个是 waterfall：我们只旁听（await next() 再原样返回），不改变任何决策。
 */
function attachStateMachine(ctx) {
  const state = createEmotionState();
  liveState = state;
  /** 已经做过基线校正的会话。 */
  const hydrated = new Set();

  ctx.effect(() => {
    const disposers = [];

    disposers.push(ctx.on('session/event', (session, event) => {
      const id = session && session.id;
      /* 第一次见到这个会话：先按日志尾部校正一次，避免「回合中途启用插件」时一脸茫然。 */
      if (id && !hydrated.has(id)) {
        hydrated.add(id);
        hydrateFromSession(state, session);
      }
      const data = (event && event.data) || {};
    /* 诊断用：只留最近 20 条，形状压到最小 */
    recentEvents.push({
      type: (event && event.type) || '',
      name: data.name || '',
      callId: data.callId || '',
      toolCallId: (data.message && data.message.toolCallId) || '',
      kind: (data.reason && data.reason.kind) || '',
    });
    if (recentEvents.length > 20) recentEvents.shift();
      switch (event && event.type) {
        case 'turn/start':
          state.turnStart(id);
          break;
        case 'turn/end':
          state.turnEnd(id, data.reason && data.reason.kind);
          break;
        case 'tool/call': {
          const name = typeof data.name === 'string' ? data.name : '';
          const callId = typeof data.callId === 'string' ? data.callId : '';
          state.toolCall(id, callId, name);
          if (name === 'set_emotion') {
            const args = parseArguments(data.arguments);
            if (args && typeof args.emotionId === 'string') {
              state.setManual(args.emotionId, typeof args.note === 'string' ? args.note : '');
            }
          }
          break;
        }
        case 'tool/result': {
          const message = data.message || {};
          const callId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
          const failed = message.isError === true || Boolean(data.error);
          state.toolResult(id, callId, failed);
          break;
        }
        default:
          break;
      }
    }));

    disposers.push(ctx.on('agent/status', (payload) => {
      const agent = payload && payload.agent;
      const id = agent && agent.id;
      state.setRunning(id, payload && payload.status === 'running');
    }));

    disposers.push(observePending(ctx, state, 'approval/request'));
    disposers.push(observePending(ctx, state, 'user-questions/request'));

    const timer = setInterval(() => state.tick(), TICK_MS);
    disposers.push(() => clearInterval(timer));

    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 忽略 */
        }
      }
    };
  }, 'emotion-ball: host state machine');
}

/**
 * 扫会话日志尾部，推出「当前是否在一个未结束的回合里、有没有还在跑的工具」。
 * 只读，不写任何东西，也不产生保持期动画。
 */
function hydrateFromSession(state, session) {
  try {
    const seq = typeof session.seq === 'number' ? session.seq : 0;
    const from = Math.max(0, seq - 400);
    const events = session.snapshotEvents(from) || [];
    let openTurn = false;
    const calls = new Map();
    const finished = new Set();
    for (const event of events) {
      const data = (event && event.data) || {};
      switch (event && event.type) {
        case 'turn/start':
          openTurn = true;
          calls.clear();
          finished.clear();
          break;
        case 'turn/end':
          openTurn = false;
          break;
        case 'tool/call':
          if (data.name !== 'set_emotion' && typeof data.callId === 'string') {
            calls.set(data.callId, data.name);
          }
          break;
        case 'tool/result':
          if (data.message && typeof data.message.toolCallId === 'string') {
            finished.add(data.message.toolCallId);
          }
          break;
        default:
          break;
      }
    }
    let tool = null;
    for (const [callId, name] of calls) {
      if (finished.has(callId)) continue;
      tool = { callId, name };
    }
    state.hydrate({
      running: openTurn,
      toolName: tool ? tool.name : null,
      toolCallId: tool ? tool.callId : null,
    });
  } catch (error) {
    console.warn('[emotion-ball] 会话基线扫描失败:', error && error.message);
  }
}

/** 旁听一个 waterfall：进入时标记「等用户」，返回/抛错时清除。永远返回 next() 的结果。 */function observePending(ctx, state, eventName) {
  try {
    const off = ctx.on(eventName, async (payload, next) => {
      state.setPending(true);
      try {
        return await next();
      } finally {
        state.setPending(false);
      }
    });
    return typeof off === 'function' ? off : () => {};
  } catch (error) {
    console.warn(`[emotion-ball] 订阅 ${eventName} 失败:`, error && error.message);
    return () => {};
  }
}
