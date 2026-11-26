/* 「重启 DSH」脚本生成器的断言：不执行 PowerShell，只检查生成出来的文本。
   重点是「顺序」和「转义」——这两样错了，用户点下去就是没反应或者杀错东西。 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { buildRestartScript, imageNameOf } = require('../helper/restart-script.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (error) {
    failed += 1;
    console.log('FAIL ' + name + ' → ' + error.message);
  }
}

check('镜像名去掉 .exe', () => {
  assert.equal(imageNameOf('C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'), 'DeepSeek Harness');
});

check('镜像名兼容正斜杠与大小写', () => {
  assert.equal(imageNameOf('C:/apps/dsh/DeepSeek Harness.EXE'), 'DeepSeek Harness');
});

const script = buildRestartScript({
  exe: "C:\\Program Files\\O'Brien\\DeepSeek Harness.exe",
  image: 'DeepSeek Harness',
  log: 'C:\\Users\\me\\AppData\\Roaming\\dsh-emotion-ball\\restart.log',
});

check('路径里的单引号被转义成两个', () => {
  assert.ok(script.includes("O''Brien"), '没转义单引号');
});

check('带空格的路径整体落在单引号里', () => {
  assert.ok(script.includes(`$exe = 'C:\\Program Files\\O''Brien\\DeepSeek Harness.exe'`));
});

check('先杀进程，再等死透，最后才拉起', () => {
  const kill = script.indexOf('$p.Kill()');
  const wait = script.indexOf('$gone = $false');
  const relaunch = script.indexOf('Start-Process -FilePath $exe');
  assert.ok(kill > 0 && wait > kill && relaunch > wait, `顺序错了 kill=${kill} wait=${wait} relaunch=${relaunch}`);
});

check('拉起前先等工作结束，不是紧接着杀', () => {
  const killed = script.indexOf('Note "killed"');
  const relaunch = script.indexOf('Start-Process -FilePath $exe');
  assert.ok(killed > 0 && relaunch > killed);
});

check('脚本是纯 ASCII（PowerShell 5.1 的 -File 读中文会乱码）', () => {
  const bad = [...script].filter((ch) => ch.charCodeAt(0) > 127);
  assert.equal(bad.length, 0, `出现非 ASCII 字符：${bad.slice(0, 5).join('')}`);
});

check('每行都独立（不是被压成一行）', () => {
  assert.ok(script.split('\n').length >= 20, '行数太少，可能被 join 成了单行');
});

if (failed > 0) {
  console.log(`\n${failed} 条失败`);
  process.exit(1);
}
console.log('\nALL PASS');
