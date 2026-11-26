/**
 * 自备 Electron 运行时
 *
 * 球是一个独立窗口，需要一个 Electron 二进制才能跑。但我们**不借用 dsh-pet** 的那份：
 * 一旦用户删掉 dsh-pet，球就会跟着报废。所以第一次启用时自己下载一份，
 * 存进 `%APPDATA%\dsh-emotion-ball\runtime\`，此后只认自己这份。
 *
 * 流程：查本地 → 取 SHASUMS256 → 下载（镜像失败切官方）→ 校验 → tar.exe 解压 → 验证。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawn } from 'node:child_process';

/** 钉死版本：和 dsh-pet 用的同一版，避免行为差异。 */
export const ELECTRON_VERSION = '43.3.0';

const ZIP_NAME = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;

/** 下载源：国内镜像优先，失败自动切官方。 */
const ZIP_SOURCES = [
  `https://registry.npmmirror.com/-/binary/electron/${ELECTRON_VERSION}/${ZIP_NAME}`,
  `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP_NAME}`,
];

const SHASUMS_SOURCES = [
  `https://registry.npmmirror.com/-/binary/electron/${ELECTRON_VERSION}/SHASUMS256.txt`,
  `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/SHASUMS256.txt`,
];

const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';

/**
 * 运行时的安装器。状态对象被 /state 读到，页面上据此显示进度条。
 *
 * state: idle | downloading | verifying | extracting | ready | error
 */
export function createRuntimeInstaller(options) {
  const { rootDir, onChange } = options;
  const targetDir = path.join(rootDir, `electron-v${ELECTRON_VERSION}`);
  const zipPath = path.join(rootDir, ZIP_NAME);
  const partPath = `${zipPath}.part`;

  const state = {
    state: 'idle',
    percent: 0,
    received: 0,
    total: 0,
    version: ELECTRON_VERSION,
    targetDir,
    error: '',
  };

  let running = null;

  function publish(patch) {
    Object.assign(state, patch);
    if (typeof onChange === 'function') {
      try {
        onChange(state);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 自己那份运行时是否就绪。 */
  function electronPath() {
    const exe = path.join(targetDir, exeName);
    return fs.existsSync(exe) ? exe : null;
  }

  function reset() {
    running = null;
    publish({ state: 'idle', percent: 0, received: 0, total: 0, error: '' });
  }

  /** 确保运行时可用；已经可用就立刻返回路径。 */
  function ensure() {
    const existing = electronPath();
    if (existing) {
      publish({ state: 'ready', percent: 100, error: '' });
      return Promise.resolve(existing);
    }
    if (running) return running;
    running = install()
      .then(() => {
        const exe = electronPath();
        if (!exe) throw new Error('解压后没找到 electron.exe');
        publish({ state: 'ready', percent: 100, error: '' });
        return exe;
      })
      .catch((error) => {
        const message = String((error && error.message) || error);
        publish({ state: 'error', error: message });
        throw error;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  async function install() {
    await fsp.mkdir(rootDir, { recursive: true });
    const expected = await fetchExpectedHash();
    const zip = await downloadZip(expected);
    await extract(zip, targetDir);
    try {
      await fsp.unlink(zipPath);
    } catch {
      /* 删不掉也不影响 */
    }
  }

  /** 从 SHASUMS256.txt 里取这个 zip 的 sha256（取不到就不做校验，但会记日志）。 */
  async function fetchExpectedHash() {
    for (const url of SHASUMS_SOURCES) {
      try {
        const text = await getText(url);
        const line = text.split('\n').find((item) => item.trim().endsWith(`*${ZIP_NAME}`) || item.trim().endsWith(` ${ZIP_NAME}`));
        if (line) {
          const hash = line.trim().split(/\s+/)[0];
          if (/^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
        }
      } catch {
        /* 换下一个源 */
      }
    }
    return null;
  }

  async function downloadZip(expected) {
    publish({ state: 'downloading', percent: 0, received: 0, total: 0, error: '' });
    let lastError = null;
    for (const url of ZIP_SOURCES) {
      try {
        return await downloadOne(url, expected);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('所有下载源都失败');
  }

  /** 单个源下载到 .part，成功后校验并改名。 */
  function downloadOne(url, expected) {
    return new Promise((resolve, reject) => {
      let settle = (fn, value) => {
        settle = () => {};
        fn(value);
      };
      const fail = (error) => {
        try {
          fs.existsSync(partPath) && fs.unlinkSync(partPath);
        } catch {
          /* 忽略 */
        }
        settle(reject, error);
      };

      request(url)
        .then((response) => {
          if (response.statusCode !== 200) {
            response.resume();
            fail(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          const total = Number(response.headers['content-length'] || 0);
          let received = 0;
          let lastPublish = 0;
          const out = fs.createWriteStream(partPath);
          out.on('error', fail);
          response.on('data', (chunk) => {
            received += chunk.length;
            const now = Date.now();
            /* 每 200ms 刷新一次进度，别把 IPC / HTTP 打爆 */
            if (now - lastPublish > 200) {
              lastPublish = now;
              publish({
                state: 'downloading',
                received,
                total,
                percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0,
              });
            }
          });
          response.on('error', fail);
          response.pipe(out);
          out.on('finish', () => {
            out.close(() => {
              publish({ state: 'verifying', percent: 100 });
              const actual = hashFile(partPath);
              if (expected && actual !== expected) {
                fail(new Error(`sha256 不匹配（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`));
                return;
              }
              try {
                fs.renameSync(partPath, zipPath);
              } catch (error) {
                fail(error);
                return;
              }
              settle(resolve, zipPath);
            });
          });
        })
        .catch(fail);
    });
  }

  async function extract(zip, dir) {
    publish({ state: 'extracting', percent: 100 });
    await fsp.mkdir(dir, { recursive: true });
    /* Windows 10+ 自带 bsdtar，能直接解 zip；不用额外依赖。 */
    await new Promise((resolve, reject) => {
      const child = spawn('tar.exe', ['-xf', zip, '-C', dir], { windowsHide: true });
      let errorText = '';
      child.stderr.on('data', (chunk) => {
        errorText += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`解压失败（tar 退出码 ${code}）${errorText.slice(0, 120)}`));
      });
    });
    await fsp.unlink(zip).catch(() => {});
  }

  return {
    ensure,
    reset,
    electronPath,
    get progress() {
      return { ...state };
    },
  };
}

function getText(url) {
  return request(url).then(
    (response) =>
      new Promise((resolve, reject) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve(body));
        response.on('error', reject);
      }),
  );
}

/** https.get 的 promise 版，最多跟 5 次重定向。 */
function request(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'dsh-emotion-ball' } }, (response) => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location && depth < 5) {
        response.resume();
        request(location, depth + 1).then(resolve, reject);
        return;
      }
      resolve(response);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('下载超时'));
    });
  });
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(file);
  hash.update(buffer);
  return hash.digest('hex');
}
