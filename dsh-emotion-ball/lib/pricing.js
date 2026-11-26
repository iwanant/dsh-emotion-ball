'use strict';

/**
 * DeepSeek 的峰谷定价时段。
 *
 * 官方口径（2026-11 版价格页）：
 *   北京时间**周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00** 为高峰时段；
 *   其余时段——包括周末与法定节假日全天——都是空闲时段。
 *   空闲时段价格 = 高峰时段价格的一半。
 *   来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *
 * 注意：调休上班的周六/周日不需要特殊处理——官方口径是「周末全天空闲」，
 * 所以这里只按「周一到周五 + 非节假日」判断。
 */

/** 高峰区间（北京时间 00:00 起的分钟数）。 */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

/**
 * 法定节假日（放假日期，含调休放假的当天）。
 * 来源：国办发明电〔2025〕7号《国务院办公厅关于2026年部分节假日安排的通知》。
 * 每年 11 月前后国务院会发下一年度的安排，届时在下面补一行即可；
 * 缺少年份时按「只认周末」处理，不会报错。
 */
const HOLIDAYS = {
  2026: [
    '01-01..01-03', // 元旦
    '02-15..02-23', // 春节
    '04-04..04-06', // 清明
    '05-01..05-05', // 劳动节
    '06-19..06-21', // 端午
    '09-25..09-27', // 中秋
    '10-01..10-07', // 国庆
  ],
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** '2026-11-10' 形式 → 0..6（0 = 周日），用 UTC 计算，不依赖本机时区与 ICU。 */
function weekdayOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 把 'MM-DD..MM-DD' 或 'MM-DD' 展开成 'YYYY-MM-DD' 集合。 */
function expandRanges(year, specs) {
  const out = new Set();
  for (const spec of specs || []) {
    const [from, to = from] = spec.split('..');
    const start = Date.UTC(year, Number(from.slice(0, 2)) - 1, Number(from.slice(3, 5)));
    const end = Date.UTC(year, Number(to.slice(0, 2)) - 1, Number(to.slice(3, 5)));
    for (let t = start; t <= end; t += DAY_MS) {
      const d = new Date(t);
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      out.add(`${d.getUTCFullYear()}-${mm}-${dd}`);
    }
  }
  return out;
}

const holidayCache = new Map();

/** 某天是不是法定节假日。 */
function isHoliday(ymd, table = HOLIDAYS) {
  const year = Number(ymd.slice(0, 4));
  if (!holidayCache.has(year)) holidayCache.set(year, expandRanges(year, table[year]));
  return holidayCache.get(year).has(ymd);
}

/** 某个时间点（毫秒）对应的北京日期与分钟数。 */
function beijingClock(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { ymd, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** 这一天的高峰区间；周末与节假日返回空数组。 */
function peakWindowsOf(ymd, table = HOLIDAYS) {
  const day = weekdayOf(ymd);
  if (day === 0 || day === 6) return [];
  if (isHoliday(ymd, table)) return [];
  return PEAK_WINDOWS;
}

/** '今天' / '明天' / '周三' 这种给用户看的说法。 */
function dayLabel(targetYmd, todayYmd) {
  if (targetYmd === todayYmd) return '今天';
  const diff = Math.round(
    (Date.parse(`${targetYmd}T00:00:00Z`) - Date.parse(`${todayYmd}T00:00:00Z`)) / DAY_MS,
  );
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekdayOf(targetYmd)];
}

function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * 当前处于峰值还是谷值，以及下一次切换的时间。
 * @param {number} now 毫秒时间戳
 * @param {object} table 节假日表（测试可注入）
 * @returns {{peak: boolean, label: string, discount: string, switchAt: number, switchLabel: string, reason: string}}
 */
function pricingWindow(now = Date.now(), table = HOLIDAYS) {
  const today = beijingClock(now);
  const todayPeaks = peakWindowsOf(today.ymd, table);

  for (const [from, to] of todayPeaks) {
    if (today.minutes >= from && today.minutes < to) {
      const switchAt = now + (to - today.minutes) * 60 * 1000 - (now + BEIJING_OFFSET_MS) % 60000;
      return {
        peak: true,
        label: '峰时段',
        discount: '全价',
        switchAt,
        switchLabel: `${hhmm(to)} 后转谷时`,
        reason: '工作日高峰',
      };
    }
  }

  /* 谷值：找下一次进入高峰的时刻（今天剩下的区间，或往后最多 14 天里的第一个工作日）。 */
  for (const [from] of todayPeaks) {
    if (today.minutes < from) {
      const deltaMinutes = from - today.minutes;
      return {
        peak: false,
        label: '谷时段',
        discount: '5 折',
        switchAt: now + deltaMinutes * 60 * 1000 - (now + BEIJING_OFFSET_MS) % 60000,
        switchLabel: `${hhmm(from)} 后转峰时`,
        reason: todayPeaks.length ? '非高峰时段' : '周末或节假日',
      };
    }
  }

  for (let i = 1; i <= 14; i++) {
    const probe = beijingClock(now + i * DAY_MS);
    const peaks = peakWindowsOf(probe.ymd, table);
    if (!peaks.length) continue;
    const [from] = peaks[0];
    return {
      peak: false,
      label: '谷时段',
      discount: '5 折',
      switchAt: now + i * DAY_MS + (from - probe.minutes) * 60 * 1000,
      switchLabel: `${dayLabel(probe.ymd, today.ymd)} ${hhmm(from)} 后转峰时`,
      reason: '非高峰时段',
    };
  }

  return {
    peak: false,
    label: '谷时段',
    discount: '5 折',
    switchAt: 0,
    switchLabel: '',
    reason: '非高峰时段',
  };
}

export { pricingWindow, isHoliday, peakWindowsOf, beijingClock, HOLIDAYS, PEAK_WINDOWS };
