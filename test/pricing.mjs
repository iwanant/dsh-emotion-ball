/**
 * 峰谷判定 + 余额换算的单元测试。
 * 跑法：node test/pricing.mjs
 *
 * 时间点全部用固定日期，不读本机时钟，所以在任何机器上结果都一样。
 */
import assert from 'node:assert/strict';

import { pricingWindow, isHoliday, beijingClock } from '../lib/pricing.js';
import { money } from '../lib/usage.js';

const at = (iso) => Date.parse(iso);
let passed = 0;

function check(name, fn) {
  fn();
  passed += 1;
  console.log('ok   ' + name);
}

check('工作日 10:00 是峰时段', () => {
  const w = pricingWindow(at('2026-11-10T10:00:00+08:00'));
  assert.equal(w.peak, true);
  assert.equal(w.label, '峰时段');
  assert.equal(w.discount, '全价');
  assert.equal(w.switchLabel, '12:00 后转谷时');
});

check('午休 12:30 是谷时段', () => {
  const w = pricingWindow(at('2026-11-10T12:30:00+08:00'));
  assert.equal(w.peak, false);
  assert.equal(w.switchLabel, '14:00 后转峰时');
});

check('下午 15:00 是峰时段，18:00 结束', () => {
  const w = pricingWindow(at('2026-11-10T15:00:00+08:00'));
  assert.equal(w.peak, true);
  assert.equal(w.switchLabel, '18:00 后转谷时');
});

check('工作日 19:00 转谷，下次是明天 09:00', () => {
  const w = pricingWindow(at('2026-11-10T19:00:00+08:00'));
  assert.equal(w.peak, false);
  assert.equal(w.switchLabel, '明天 09:00 后转峰时');
  assert.equal(new Date(w.switchAt).toISOString(), new Date(at('2026-11-11T09:00:00+08:00')).toISOString());
});

check('周六上午不算峰时段', () => {
  const w = pricingWindow(at('2026-11-14T10:00:00+08:00'));
  assert.equal(w.peak, false);
  assert.equal(w.switchLabel, '后天 09:00 后转峰时');
});

check('国庆假期整天是谷时段，节后首个工作日转峰', () => {
  assert.equal(isHoliday('2026-10-02'), true);
  const w = pricingWindow(at('2026-10-02T10:00:00+08:00'));
  assert.equal(w.peak, false);
  assert.equal(new Date(w.switchAt).toISOString(), new Date(at('2026-10-08T09:00:00+08:00')).toISOString());
});

check('周五下班后要到周一 09:00 才转峰', () => {
  const w = pricingWindow(at('2026-11-13T18:30:00+08:00'));
  assert.equal(w.peak, false);
  assert.equal(new Date(w.switchAt).toISOString(), new Date(at('2026-11-16T09:00:00+08:00')).toISOString());
});

check('周三早上班前是谷，09:00 转峰', () => {
  const w = pricingWindow(at('2026-11-11T08:59:00+08:00'));
  assert.equal(w.peak, false);
  assert.equal(w.switchLabel, '09:00 后转峰时');
});

check('北京时间换算不受本机时区影响', () => {
  const clock = beijingClock(at('2026-11-10T00:30:00Z'));
  assert.equal(clock.ymd, '2026-11-10');
  assert.equal(clock.minutes, 8 * 60 + 30);
});

check('余额格式化：两位小数 / 千位分隔', () => {
  assert.equal(money(9.71218116), '¥9.71');
  assert.equal(money(1234.567), '¥1,235');
  assert.equal(money(0), '¥0.00');
});

console.log('\nALL PASS (' + passed + ')');
