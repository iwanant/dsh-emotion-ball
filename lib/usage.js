'use strict';

/**
 * 读 DSH 存着的大账号令牌，向 Platform 查「还剩多少钱」。
 *
 * 为什么不用 API key：DSH 默认走账号登录（deepseek-account），本地并没有可用的
 * `sk-` 余额接口权限；账号侧的口径就在 Platform 的 get_user_summary 上，
 * 也就是设置里「账号」那页显示的数字。令牌只在本机读取、只发给 token 里记录的
 * issuer（默认 https://platform.deepseek.com），不发往任何第三方。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pricingWindow } from './pricing.js';

const CREDENTIALS = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const RECORD = 'deepseek-account-platform/default';
const DEFAULT_ISSUER = 'https://platform.deepseek.com';
const FRESH_MS = 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 8000;

/** 从 .credentials.yaml 里抠出账号令牌；文件不存在或没登录时返回 null。 */
function readGrant(file = CREDENTIALS) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${RECORD}:`);
  if (start < 0) return null;
  let token = '';
  let issuer = DEFAULT_ISSUER;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    /* 记录块结束：缩进回到 records 的下一级 */
    if (/^\s{0,2}\S/.test(line)) break;
    const tv = /^\s+token:\s*(\S+)\s*$/.exec(line);
    if (tv) token = tv[1];
    const iv = /^\s+issuer:\s*(\S+)\s*$/.exec(line);
    if (iv) issuer = iv[1];
  }
  if (!token) return null;
  return { token, issuer: issuer.replace(/\/+$/, '') };
}

/** 余额字符串 → 数字（Platform 用 big.js 文法，0E-16 这种也合法）。 */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pick(wallets, key = 'balance', currency = 'CNY') {
  const list = Array.isArray(wallets) ? wallets : [];
  const hit = list.find((w) => w && w.currency === currency);
  return hit ? num(hit[key]) : 0;
}

function money(value, currency = 'CNY') {
  const symbol = currency === 'CNY' ? '¥' : '$';
  const abs = Math.abs(value);
  if (abs >= 1000) return `${symbol}${Math.round(value).toLocaleString('zh-CN')}`;
  return `${symbol}${value.toFixed(2)}`;
}

/**
 * @param {object} options
 * @param {Function} [options.fetch] 注入用（测试里换成假的）
 * @param {Function} [options.now]
 */
function createUsage(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || Date.now;
  let snapshot = {
    ok: false,
    at: 0,
    currency: 'CNY',
    balance: 0,
    bonus: 0,
    total: 0,
    spent: 0,
    display: '—',
    bonusDisplay: '',
    error: 'loading',
  };
  let lastTry = 0;
  let inflight = null;

  function withWindow(snap) {
    return { ...snap, window: pricingWindow(now()) };
  }

  async function query() {
    const grant = readGrant(options.credentials);
    if (!grant) throw new Error('没有找到账号登录信息');
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有 fetch');
    const url = `${grant.issuer}/api/v0/users/get_user_summary`;
    const res = await fetchImpl(url, {
      headers: {
        'x-dsh-auth-token': grant.token,
        accept: 'application/json',
        'user-agent': 'dsh-emotion-ball',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const data = body && body.data && body.data.biz_data;
    if (!data) throw new Error('响应里没有余额数据');

    const balance = pick(data.normal_wallets);
    const bonus = pick(data.bonus_wallets);
    const spent = pick(data.total_costs, 'amount');
    snapshot = {
      ok: true,
      at: now(),
      currency: 'CNY',
      balance,
      bonus,
      total: balance + bonus,
      spent,
      display: money(balance + bonus),
      bonusDisplay: bonus > 0 ? `含赠送 ${money(bonus)}` : '',
      error: null,
    };
    return snapshot;
  }

  /** 触发一次刷新（去重、有失败退避）；调用方不需要等。 */
  function ensureFresh(force = false) {
    if (inflight) return inflight;
    const since = now() - lastTry;
    if (!force && since < (snapshot.ok ? FRESH_MS : RETRY_MS)) return Promise.resolve(snapshot);
    lastTry = now();
    inflight = query()
      .catch((error) => {
        snapshot = { ...snapshot, ok: false, error: error.message || String(error) };
        return snapshot;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return {
    /** 同步快照：拿到什么给什么，顺手在后台刷新。 */
    snapshot() {
      ensureFresh();
      return withWindow(snapshot);
    },
    /** 等一次真实刷新（菜单点开时可以调，最多 TIMEOUT_MS）。 */
    async fresh(force = true) {
      await ensureFresh(force);
      return withWindow(snapshot);
    },
    readGrant: () => readGrant(options.credentials),
  };
}

export { createUsage, readGrant, money };
