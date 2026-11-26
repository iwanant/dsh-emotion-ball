import { createEmotionState } from '../lib/state.js';

const state = createEmotionState({ now: () => Date.now(), random: () => 0.5 });
const log = (label) => console.log(label, JSON.stringify(state.snapshot), 'pending=' + state.debug().pending);

state.turnStart('s1');
log('turn start');

state.toolCall('s1', 'call-1', 'ask_user_question');
log('ask_user_question called');

state.toolResult('s1', 'call-1', false);
log('answered (same id)');

state.toolCall('s1', 'call-2', 'ask_user_question');
log('ask again');
state.toolResult('s1', 'call-2', false);
log('answered again');
