/* 真实编译一次重启链路的两段 C#，检查生成的 exe 是 GUI 子系统（没有控制台窗口）。
 *
 * 这条断言存在的原因：0.5.1 第一次发布时只靠「源码里写了 /target:winexe」自证，
 * 结果用户机器上一直复用早先编译出来的控制台版本，黑框照旧。
 * 只有真的编一遍再读 PE 头 Subsystem 字段，才能证明「不会弹窗口」。
 *
 * 用法：node test/helper-subsystem.mjs  （需要 Windows + .NET Framework 4.x 的 csc.exe）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const helperDir = path.join(here, '..', 'helper');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* PE 头里的 Subsystem 字段：2 = GUI，3 = 控制台 */
function subsystemOf(file) {
  const buf = fs.readFileSync(file);
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\u0000\u0000') return null;
  return buf.readUInt16LE(peOffset + 24 + 68);
}

const compiler = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
].find((item) => fs.existsSync(item));

if (!compiler) {
  console.log('skip 找不到 csc.exe（非 Windows 或没装 .NET Framework 4.x），这条测试跳过');
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-subsystem-'));
try {
  const cases = [
    { source: 'restart-helper.cs', refs: [], expect: 2 },
    { source: 'restart-launcher.cs', refs: ['System.Management'], expect: 2 },
  ];

  for (const item of cases) {
    const out = path.join(work, item.source.replace(/\.cs$/, '.exe'));
    const argv = ['/nologo', '/optimize+', '/target:winexe'];
    for (const ref of item.refs) argv.push('/r:' + ref + '.dll');
    argv.push('/out:' + out, path.join(helperDir, item.source));
    const result = spawnSync(compiler, argv, { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    const built = result.status === 0 && fs.existsSync(out);
    check(`${item.source} 能编译`, built, String(result.stderr || '').slice(0, 200));
    if (!built) continue;
    const subsystem = subsystemOf(out);
    check(
      `${item.source} 编出来是 GUI 子系统（Subsystem=2，不会分配控制台窗口）`,
      subsystem === item.expect,
      `实际 Subsystem=${subsystem}`,
    );
  }

  /* 控制台那个必须保持控制台：它要跟球走 stdin/stdout 管道 */
  const toggleOut = path.join(work, 'toggle-helper.exe');
  const toggle = spawnSync(
    compiler,
    ['/nologo', '/optimize+', '/target:exe', '/out:' + toggleOut, path.join(helperDir, 'toggle-helper.cs')],
    { windowsHide: true, encoding: 'utf8', timeout: 60000 },
  );
  const toggleBuilt = toggle.status === 0 && fs.existsSync(toggleOut);
  check('toggle-helper.cs 能编译', toggleBuilt, String(toggle.stderr || '').slice(0, 200));
  if (toggleBuilt) {
    check(
      'toggle-helper.cs 仍是控制台子系统（要 stdin/stdout，靠 spawn 的 windowsHide 藏窗口）',
      subsystemOf(toggleOut) === 3,
      `实际 Subsystem=${subsystemOf(toggleOut)}`,
    );
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\nALL PASS');
