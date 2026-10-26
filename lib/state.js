/**
 * 宿主侧情绪状态机
 *
 * 为什么要搬到宿主：桌面球不在 DSH 页面里，拿不到 `ctx.uiSession` 和会话事件窗口。
 * 宿主侧反而更全：`session/event`、`agent/status`、`api-session/status`、
 * 以及 approval / user-questions 的 waterfall 都能在这里观察到，而且**窗口隐藏时照样准**。
 *
 * 优先级（与页面版逐条对齐，页面版的 27 条断言就是这套规则）：
 *   待确认 35 > 出错 34 > 停止 41 > 被拦 38 > (运行中: 接收 31 / 工具 32·36·40 / 思考 30)
 *   > 完成 33 > 空闲轮换 02·03·04·19
 *
 * 纯逻辑，不碰 IO：喂事件、给时钟，读当前表情。这样可以脱离 DSH 单测。
 */

const IDLE_EMOTIONS = ['02', '03', '04', '19'];
const IDLE_MIN_MS = 6000;
const IDLE_MAX_MS = 10000;
const START_HOLD_MS = 1200;
const DONE_HOLD_MS = 2000;
const ERROR_HOLD_MS = 3000;
const STOP_HOLD_MS = 2500;
const BLOCK_HOLD_MS = 2500;

const SEARCH_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'lsp', 'skill',
  'session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace',
  'list_agents', 'list_subagent_models', 'job_list', 'job_output',
  'cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self',
]);
const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

/** 读文件 / 搜索 → 40 检索资料；联网 → 36 联网加载；其余动手的 → 32 处理中忙碌。 */
export function classifyTool(name) {
  if (!name) return '32';
  if (WEB_TOOLS.has(name)) return '36';
  if (SEARCH_TOOLS.has(name)) return '40';
  if (/^(read|glob|grep|list_|cordis_inspect_)/.test(name)) return '40';
  return '32';
}

function randomIdle(previous) {
  const pool = IDLE_EMOTIONS.filter((id) => id !== previous);
  const source = pool.length > 0 ? pool : IDLE_EMOTIONS;
  return source[Math.floor(Math.random() * source.length)];
}

function randomIdleDelay() {
  return IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS);
}

/**
 * @param {{ now?: () => number, random?: () => number }} [deps] 注入时钟/随机数，便于测试
 */
export function createEmotionState(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const random = typeof deps.random === 'function' ? deps.random : Math.random;

  let session = null;
  let running = false;
  let pending = false;
/** 等你回答的那个 ask_user_question 调用 id（用 id 匹配，避免被别的工具覆盖）。 */
let questionCallId = null;
  let activeTool = null; // { callId, name, at }
  let note = '';

  let epoch = 0;
/** 回合计数：只在 turn/start 时 +1（epoch 是每个事件都 +1，不能用来判断「新一轮」）。 */
let turns = 0;
  let manual = null; // { id, note, epoch }

  let startHoldUntil = 0;
  let doneHoldUntil = 0;
  let errorHoldUntil = 0;
  let stopHoldUntil = 0;
  let blockHoldUntil = 0;

  let idleId = '02';
  let nextIdleAt = now() + randomIdleDelay();

  let current = { emotion: '02', mode: 'auto', note: '', at: now() };

  function pickIdle(at) {
    if (at >= nextIdleAt) {
      const next = randomIdle(idleId);
      idleId = next;
      nextIdleAt = at + IDLE_MIN_MS + random() * (IDLE_MAX_MS - IDLE_MIN_MS);
    }
    return idleId;
  }

  function compute() {
    const at = now();
    let auto;
    if (pending) auto = '35';
    else if (at < errorHoldUntil) auto = '34';
    else if (at < stopHoldUntil) auto = '41';
    else if (at < blockHoldUntil) auto = '38';
    /* 完成的保持期排在 running 之前：turn/end 落地时 running 往往还没翻成 false，
       此时应当立刻显示「任务完成」，而不是继续显示思考中。新回合的 turnStart 会清掉它。 */
    else if (at < doneHoldUntil) auto = '33';
    else if (running) {
      if (at < startHoldUntil) auto = '31';
      else if (activeTool) auto = classifyTool(activeTool.name);
      else auto = '30';
    } else auto = pickIdle(at);

    const chosen = manual ? manual.id : auto;
    if (chosen !== current.emotion || (manual ? 'manual' : 'auto') !== current.mode) {
      current = {
        emotion: chosen,
        mode: manual ? 'manual' : 'auto',
        note: manual ? manual.note : '',
        at,
      };
    }
    return current;
  }

  /** 每个「状态事件」都会推进 epoch，手动模式随之失效（与页面版一致）。 */
  function bump() {
    epoch += 1;
    if (manual && manual.epoch < epoch) manual = null;
  }

  const api = {
    get snapshot() {
      return current;
    },
    tick: compute,

    /** 新回合开始 */
    turnStart(sessionId) {
      turns += 1;
      if (sessionId && sessionId !== session) {
        session = sessionId;
        activeTool = null;
      }
      startHoldUntil = now() + START_HOLD_MS;
      doneHoldUntil = 0;
      errorHoldUntil = 0;
      stopHoldUntil = 0;
      blockHoldUntil = 0;
      bump();
      return compute();
    },

    /** 回合结束；kind 取 TurnEndReason.kind */
    turnEnd(sessionId, kind) {
      if (sessionId && sessionId !== session) session = sessionId;
      const at = now();
      if (kind === 'completed') doneHoldUntil = at + DONE_HOLD_MS;
      else if (kind === 'aborted' || kind === 'interrupted') stopHoldUntil = at + STOP_HOLD_MS;
      else if (kind === 'blocked') blockHoldUntil = at + BLOCK_HOLD_MS;
      else if (kind === 'error') errorHoldUntil = at + ERROR_HOLD_MS;
      activeTool = null;
      bump();
      return compute();
    },

    toolCall(sessionId, callId, name) {
      if (sessionId && sessionId !== session) {
        session = sessionId;
        activeTool = null;
      }
      if (name === 'set_emotion') return current; // 自己触发的不算状态事件
      /*
       * ask_user_question 一被调用，就是「在等你回答」——这是最可靠的信号。
       * （宿主的 user-questions/request 是 agent 作用域 waterfall，根级插件收不到，
       *  所以不能靠它判断 pending。）
       */
      if (name === 'ask_user_question') {
        pending = true;
        questionCallId = callId || null;
      }
      activeTool = { callId, name, at: now() };
      bump();
      return compute();
    },

    toolResult(sessionId, callId, isError) {
      if (questionCallId && (!callId || questionCallId === callId)) {
        /* 你回答了：待回答状态结束 */
        pending = false;
        questionCallId = null;
      }
      if (activeTool && (!callId || activeTool.callId === callId)) activeTool = null;
      if (isError) errorHoldUntil = now() + ERROR_HOLD_MS;
      bump();
      return compute();
    },

    /** agent/status 或 api-session/status */
    setRunning(sessionId, value) {
      if (sessionId && sessionId !== session) session = sessionId;
      if (running === Boolean(value)) return current;
      running = Boolean(value);
      if (running) {
        doneHoldUntil = 0;
        errorHoldUntil = 0;
      }
      if (!running) activeTool = null;
      bump();
      return compute();
    },

    /** 等用户确认 / 审批 */
    setPending(value) {
      if (pending === Boolean(value)) return current;
      pending = Boolean(value);
      bump();
      return compute();
    },

    /** set_emotion 工具：进入手动模式，直到下一个状态事件 */
    setManual(id, why) {
      if (typeof id !== 'string' || id === '') return current;
      manual = { id, note: typeof why === 'string' ? why : '', epoch };
      note = manual.note;
      return compute();
    },

    /** 手动 → 自动 */
    releaseManual() {
      manual = null;
      note = '';
      return compute();
    },

    /**
     * 载入时的基线：插件可能在一个回合中途才被启用，此时没收到过任何事件。
     * 用会话日志尾部推出来的事实校正 running / 在跑的工具，但不触发任何保持期动画。
     */
    hydrate(facts) {
      const input = facts || {};
      running = Boolean(input.running);
      activeTool = input.toolName
        ? { callId: input.toolCallId || 'hydrated', name: input.toolName, at: now() }
        : null;
      return compute();
    },

    /** 诊断用 */
    debug() {
      return {
        emotion: current.emotion,
        mode: current.mode,
        session: session || null,
        running,
        pending,
        tool: activeTool ? activeTool.name : null,
        epoch,
      turns,
      holds: {
          start: Math.max(0, startHoldUntil - now()),
          done: Math.max(0, doneHoldUntil - now()),
          error: Math.max(0, errorHoldUntil - now()),
          stop: Math.max(0, stopHoldUntil - now()),
          block: Math.max(0, blockHoldUntil - now()),
        },
        note,
      };
    },
  };

  return api;
}
