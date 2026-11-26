/* 检查 ball.html 里每段内联 <script> 能不能通过语法解析。
   用途：手改页面后先跑一次，别再把语法错误带上线（曾经多一个 }); 让整页白掉）。 */
import fs from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

if (blocks.length === 0) {
  console.log('没有内联脚本');
  process.exit(0);
}

let failed = 0;
blocks.forEach((code, index) => {
  try {
    new vm.Script(code, { filename: `inline-${index + 1}.js` });
    console.log(`inline #${index + 1}: OK (${code.split('\n').length} 行)`);
  } catch (error) {
    failed += 1;
    console.log(`inline #${index + 1}: 语法错误 → ${error.message}`);
  }
});

process.exit(failed === 0 ? 0 : 1);
