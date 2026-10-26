// 宿主侧状态机单测：注入时钟与随机数，验证优先级、保持期、手动模式边界。
import { createEmotionState, classifyTool } from '../lib/state.js';

let clock = 1_000_000;
const state = createEmotionState({ now: () => clock, random: () => 0.5 });
const advance = (ms) => {
  clock += ms;
  state.tick();
  return state.snapshot.emotion;
};

let failures = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${name}\n  actual   ${JSON.stringify(actual)}\n  expected ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// --- 分类 ---
check('read → 40', classifyTool('read'), '40');
check('web_search → 36', classifyTool('web_search'), '36');
check('pwsh → 32', classifyTool('pwsh'), '32');

// --- 空闲起点 ---
check('初始是空闲表情', state.snapshot.emotion, '02');
check('初始是自动模式', state.snapshot.mode, 'auto');

// --- 新回合 → 31，1.2s 后 → 30 ---
state.setRunning('s1', true);
check('运行但无工具 → 30', state.snapshot.emotion, '30');
state.turnStart('s1');
check('新回合 → 31', state.snapshot.emotion, '31');
check('1.3s 后 → 30', advance(1300), '30');

// --- 工具分类 ---
state.toolCall('s1', 'c1', 'read');
check('read → 40', state.snapshot.emotion, '40');
state.toolResult('s1', 'c1', false);
check('工具结束 → 30', state.snapshot.emotion, '30');
state.toolCall('s1', 'c2', 'web_fetch');
check('web_fetch → 36', state.snapshot.emotion, '36');
state.toolCall('s1', 'c3', 'pwsh');
check('pwsh → 32', state.snapshot.emotion, '32');

// --- 工具失败 → 34，3s 后回来 ---
state.toolResult('s1', 'c3', true);
check('工具失败 → 34', state.snapshot.emotion, '34');
check('3.1s 后 → 30', advance(3100), '30');

// --- 回合完成 → 33，2s 后回到空闲 ---
state.turnEnd('s1', 'completed');
check('回合完成 → 33', state.snapshot.emotion, '33');
state.setRunning('s1', false);
check('仍在 33 保持期内', state.snapshot.emotion, '33');
check('2.1s 后回到空闲', advance(2100), '02');

// --- aborted → 41；blocked → 38；error → 34 ---
state.setRunning('s2', true);
state.turnEnd('s2', 'aborted');
check('中断 → 41', state.snapshot.emotion, '41');
state.setRunning('s2', false);
advance(2600);
state.setRunning('s2', true);
state.turnEnd('s2', 'blocked');
check('被拦 → 38', state.snapshot.emotion, '38');
state.setRunning('s2', false);
advance(2600);
state.setRunning('s2', true);
state.turnEnd('s2', 'error');
check('回合报错 → 34', state.snapshot.emotion, '34');
state.setRunning('s2', false);
advance(3100);

// --- 等待输入优先级最高 ---
state.setRunning('s3', true);
state.toolCall('s3', 'c9', 'pwsh');
state.setPending(true);
check('待确认压过忙碌 → 35', state.snapshot.emotion, '35');
state.setPending(false);
check('确认完回到工具态 → 32', state.snapshot.emotion, '32');

// --- 手动模式：下一个状态事件失效 ---
state.setManual('16', '我有把握');
check('手选 → 16 / manual', [state.snapshot.emotion, state.snapshot.mode], ['16', 'manual']);
check('手动模式有 note', state.snapshot.note, '我有把握');
state.toolResult('s3', 'c9', false);
check('下一个状态事件 → 回到自动', state.snapshot.mode, 'auto');
check('自动后的表情是 30', state.snapshot.emotion, '30');

// --- set_emotion 自身不算状态事件 ---
state.setManual('21', '');
state.toolCall('s3', 'c10', 'set_emotion');
check('set_emotion 不会顶掉手动', [state.snapshot.emotion, state.snapshot.mode], ['21', 'manual']);
state.releaseManual();
check('释放手动 → 自动', state.snapshot.mode, 'auto');

// --- 空闲轮换只挑 4 个候选 ---
state.setRunning('s4', false);
advance(12000);
check('空闲候选属于 02/03/04/19', ['02', '03', '04', '19'].includes(state.snapshot.emotion), true);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
