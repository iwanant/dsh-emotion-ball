/* 「重启 DSH」的启动链检查。
   这些东西错了不会报错，只会「点了没反应」或者「屏幕上闪一个黑框」——所以逐条钉住。 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLauncherArgs, imageNameOf } from '../helper/restart-launch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_DIR = path.join(HERE, '..', 'helper');
const readSource = (name) => fs.readFileSync(path.join(HELPER_DIR, name), 'utf8');
/** 去掉注释再查关键字：注释里会提到 powershell 这类「为什么不这么做」 */
const readCode = (name) => readSource(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

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

const exe = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe';
const helper = 'C:\\Users\\me\\AppData\\Roaming\\dsh\\dsh-restart-helper-123.exe';
const log = 'C:\\Users\\me\\AppData\\Roaming\\dsh\\restart.log';

check('镜像名去掉 .exe', () => {
  assert.equal(imageNameOf(exe), 'DeepSeek Harness');
});

check('镜像名兼容正斜杠与大小写', () => {
  assert.equal(imageNameOf('D:/apps/DeepSeek Harness.EXE'), 'DeepSeek Harness');
});

check('launcher 参数是一对一的「--key 值」，路径原样不掺引号', () => {
  const args = buildLauncherArgs({ helperExe: helper, image: 'DeepSeek Harness', exe, log });
  assert.deepEqual(args, [
    '--helper', helper,
    '--image', 'DeepSeek Harness',
    '--exe', exe,
    '--log', log,
    '--delay', '600',
  ]);
});

check('默认延时 600ms，可以覆盖', () => {
  assert.equal(buildLauncherArgs({ helperExe: helper, image: 'x', exe, log, delay: 1200 }).at(-1), '1200');
});

check('launcher 源码用 WMI 创建进程', () => {
  const source = readSource('restart-launcher.cs');
  assert.ok(source.includes('ManagementClass("Win32_Process")'), '没有 Win32_Process');
  assert.ok(source.includes('InvokeMethod("Create"'), '没有调用 Create');
  assert.ok(source.includes('inParams["CommandLine"]'), '没有设置 CommandLine');
});

check('launcher 源码会把每个值加引号（路径空格不会断）', () => {
  const source = readSource('restart-launcher.cs');
  assert.ok(source.includes('return "\\"" + value + "\\"";'), '没有加引号的 Quote');
  assert.ok(source.includes('--image " + Quote(image)'), 'image 没加引号');
  assert.ok(source.includes('--exe " + Quote(exe)'), 'exe 没加引号');
});

check('两段 C# 里都没有 powershell，重启路径也不再 spawn 它', () => {
  for (const name of ['restart-launcher.cs', 'restart-helper.cs']) {
    assert.ok(!/powershell/i.test(readCode(name)), name + ' 里还有 powershell');
  }
  /* 双击那条路径还有 PowerShell 兜底（编不出 exe 时），这里只管重启 */
  const main = fs.readFileSync(path.join(HELPER_DIR, 'main.js'), 'utf8');
  const body = (main.match(/function restartDsh\(\)[\s\S]*?\n\}/) || [''])[0];
  assert.ok(body.length > 200, '找不到 restartDsh()');
  assert.ok(!/powershell/i.test(body), 'restartDsh 里还有 powershell');
  assert.ok(body.includes('spawn(launcherExe'), 'restartDsh 没有 spawn launcher');
});

check('两段都是 winexe（没有控制台窗口）', () => {
  const main = fs.readFileSync(path.join(HELPER_DIR, 'main.js'), 'utf8');
  assert.ok(/restart-helper\.cs', 'dsh-restart-helper', \{ winexe: true \}/.test(main), 'restart-helper 不是 winexe');
  assert.ok(
    /restart-launcher\.cs', 'dsh-restart-launcher', \{ winexe: true/.test(main),
    'restart-launcher 不是 winexe',
  );
  assert.ok(/opts\.winexe \? '\/target:winexe' : '\/target:exe'/.test(main), 'compileHelper 没有 winexe 分支');
});

check('执行体按镜像名杀进程，杀完等死透再拉起', () => {
  const source = readSource('restart-helper.cs');
  const before = source.indexOf('GetProcessesByName(image)');
  const kill = source.indexOf('item.Kill()');
  const relaunch = source.indexOf('Process.Start(info)');
  assert.ok(before > 0 && kill > before && relaunch > kill, '顺序不对：枚举 → 杀 → 拉起');
  assert.ok(source.includes('Thread.Sleep(delay'), '没有先等 delay');
});

if (failed > 0) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\nALL PASS');
