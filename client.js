/**
 * dsh-emotion-ball —— 客户端半侧（浏览器）
 *
 * 桌面球（Electron 独立窗口）负责所有可见的部分，所以这里只剩下四件轻活：
 *   1. 对话里给 set_emotion 留一个极轻的标记（tool.call.toolview）
 *   2. 把「桌面球菜单里换的主题」应用到整个 DSH（轮询宿主的 /theme seq）
 *   3. 把 DSH 当前主题偏好上报回去，让桌面球跟着变（双向同步）
 *   4. 上报页面焦点（桌面球据此决定要不要亮角标）
 *
 * 历史说明：这里曾经挂过一颗网页版小球（store / 选择盘 / 拖动 / 眼神跟随），
 * 后来桌面球接手渲染、页面里不再注册 shell.overlay，那套逻辑已整体删除，
 * 只保留上面四件事——别再往这里加渲染代码。
 */
window.__ModuleLoader__.load({
  id: 'dsh-emotion-ball',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'emotion-ball';
    /** 与宿主半侧 index.js 的 PORT 保持一致。 */
    const ORIGIN = 'http://127.0.0.1:8766';

    const DICT = {
      zh: { title: '情绪小球', call: '情绪' },
      en: { title: 'Emotion Ball', call: 'mood' },
    };

    /** apply() 里绑定宿主 locale 服务；组件渲染时用它决定文案语言。 */
    let localeService = null;

    function localeIsEnglish() {
      try {
        const snapshot = localeService && localeService.getLocale();
        return Boolean(snapshot && snapshot.active === 'en');
      } catch {
        return false;
      }
    }

    /** 有宿主注入的 t 就用，没有就退回本地字典。 */
    function tr(t, key) {
      if (typeof t === 'function') {
        try {
          const value = t(key);
          if (value && value !== key) return value;
        } catch {
          /* 忽略 */
        }
      }
      const dict = localeIsEnglish() ? DICT.en : DICT.zh;
      return dict[key] || DICT.zh[key] || key;
    }

    /** 宿主静态服务返回的 32 条表情目录（id → { name, enName }）。 */
    let catalogNames = null;

    const CALL_CSS = `
.eb-call{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);opacity:.78;vertical-align:baseline}
.eb-call .dot{font-size:10px;color:var(--dsw-alias-brand-primary)}
.eb-call .nm{opacity:.85}
`;

    function readCallArgs(block) {
      try {
        const args = block && block.args;
        if (!args) return null;
        return {
          emotionId: typeof args.emotionId === 'string' ? args.emotionId : '',
          note: typeof args.note === 'string' ? args.note : '',
        };
      } catch {
        /* preparing 阶段参数可能还没到齐 */
        return null;
      }
    }

    /** set_emotion 在对话里只留一个极轻的标记，不打断阅读。 */
    function SetEmotionRow(props) {
      const { t } = props;
      const call = readCallArgs(props.block);
      const emotionId = call && call.emotionId ? call.emotionId : '';
      const english = localeIsEnglish();
      const meta = emotionId && catalogNames ? catalogNames.get(emotionId) : null;
      const label = meta ? (english && meta.enName ? meta.enName : meta.name) : '';
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CALL_CSS),
        h(
          'span',
          {
            className: 'eb-call',
            title: call && call.note ? call.note : tr(t, 'call'),
          },
          h('span', { className: 'dot' }, '●'),
          label ? h('span', { className: 'nm' }, label) : null,
        ),
      );
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots) {
        console.warn('[emotion-ball] slots 服务不可用，未注册');
        return;
      }

      try {
        localeService = ctx.get ? ctx.get('locale') : ctx.locale;
      } catch {
        localeService = null;
      }

      /* 对话里的极轻标记。 */
      /*
       * 运行时下载进度条：球是独立窗口，没有 Electron 就跑不起来，
       * 这段时间必须在 DSH 界面里给个反馈，否则用户只会觉得"装了啥也没有"。
       */
      const RuntimeNotice = () => {
        const [runtime, setRuntime] = React.useState(null);
        React.useEffect(() => {
          let cancelled = false;
          const tick = () => {
            fetch(ORIGIN + '/state', { cache: 'no-store' })
              .then((response) => (response.ok ? response.json() : null))
              .then((data) => {
                if (!cancelled && data && data.runtime) setRuntime(data.runtime);
              })
              .catch(() => {});
          };
          tick();
          const timer = window.setInterval(tick, 1500);
          return () => {
            cancelled = true;
            window.clearInterval(timer);
          };
        }, []);

        if (!runtime || runtime.state === 'ready' || runtime.state === 'idle') return null;

        const mb = (bytes) => (bytes ? (bytes / 1024 / 1024).toFixed(0) : '?');
        let text = '';
        if (runtime.state === 'downloading') {
          text = `情绪小球 · 正在下载运行时 ${runtime.percent || 0}%（${mb(runtime.received)} / ${mb(runtime.total)} MB）`;
        } else if (runtime.state === 'verifying') {
          text = '情绪小球 · 正在校验安装包…';
        } else if (runtime.state === 'extracting') {
          text = '情绪小球 · 正在解压…';
        } else if (runtime.state === 'error') {
          text = `情绪小球 · 运行时准备失败：${runtime.error || '未知原因'}`;
        } else {
          return null;
        }

        const failed = runtime.state === 'error';
        return h(
          'div',
          {
            style: {
              position: 'fixed',
              right: 16,
              bottom: 16,
              zIndex: 60,
              maxWidth: 420,
              padding: '8px 12px',
              borderRadius: 10,
              fontSize: 12,
              lineHeight: 1.5,
              pointerEvents: 'auto',
              background: failed ? 'rgba(229,72,77,.96)' : 'rgba(24,24,30,.94)',
              color: '#fff',
              boxShadow: '0 8px 24px rgba(0,0,0,.35)',
              fontFamily: 'system-ui, -apple-system, "Microsoft YaHei", sans-serif',
            },
          },
          text,
          failed
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    fetch(ORIGIN + '/runtime/retry', { method: 'GET' }).catch(() => {});
                    setRuntime({ state: 'downloading', percent: 0 });
                  },
                  style: {
                    marginLeft: 8,
                    border: 0,
                    borderRadius: 6,
                    padding: '2px 8px',
                    cursor: 'pointer',
                    background: 'rgba(255,255,255,.2)',
                    color: '#fff',
                    fontSize: 12,
                  },
                },
                '重试',
              )
            : null,
        );
      };

      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'emotion-ball-runtime',
            order: 950,
            locale: NS,
          },
          RuntimeNotice,
        );
      });

      ctx.slots.inject('tool.call.toolview', function* () {
        yield ctx.slots.register(
          {
            name: 'tool.call.toolview',
            key: 'set_emotion',
            locale: NS,
          },
          SetEmotionRow,
        );
      });

      /* 表情目录：桌面球不再通过 iframe 发消息，改从宿主静态服务取。 */
      ctx.effect(() => {
        let cancelled = false;
        try {
          window
            .fetch(ORIGIN + '/emotions.json')
            .then((response) => (response.ok ? response.json() : null))
            .then((items) => {
              if (cancelled || !Array.isArray(items)) return;
              catalogNames = new Map(items.map((item) => [item.id, item]));
            })
            .catch(() => {});
        } catch {
          /* 忽略 */
        }
        return () => {
          cancelled = true;
        };
      }, 'emotion-ball: catalog');

      /* 桌面球菜单里换主题时，把整个 DSH 也切过去。
         宿主记一个 seq，这里轮询到变化就调 ctx.theme.setTheme（DSH 会持久化到用户设置）。 */
      ctx.effect(() => {
        let seq = -1;
        const tick = () => {
          try {
            window
              .fetch(ORIGIN + '/theme', { cache: 'no-store' })
              .then((response) => (response.ok ? response.json() : null))
              .then((data) => {
                if (!data || typeof data.seq !== 'number' || data.seq === seq) return;
                const first = seq < 0;
                seq = data.seq;
                if (first || !data.theme) return; // 首次只是对齐 baseline，不重复设置
                const service = ctx.get ? ctx.get('theme') : ctx.theme;
                if (!service || typeof service.setTheme !== 'function') return;
                try {
                  service.setTheme(data.theme);
                  console.info('[emotion-ball] 已切换 DSH 主题:', data.theme);
                } catch (error) {
                  console.warn('[emotion-ball] 切换 DSH 主题失败:', error && error.message);
                }
              })
              .catch(() => {});
          } catch {
            /* 忽略 */
          }
        };
        const timer = window.setInterval(tick, 1000);
        tick();
        return () => window.clearInterval(timer);
      }, 'emotion-ball: DSH theme sync');

      /* 把 DSH 当前主题偏好上报给宿主，让桌面球跟着变（双向同步）。 */
      ctx.effect(() => {
        const report = () => {
          try {
            const service = ctx.get ? ctx.get('theme') : ctx.theme;
            if (!service || typeof service.getTheme !== 'function') return;
            const snapshot = service.getTheme();
            const preference = snapshot && snapshot.preference;
            if (preference !== 'light' && preference !== 'dark' && preference !== 'system') return;
            window.fetch(ORIGIN + '/theme?report=' + preference, { cache: 'no-store' }).catch(() => {});
          } catch {
            /* 忽略 */
          }
        };
        report();
        const off = typeof ctx.on === 'function' ? ctx.on('theme/change', () => report()) : null;
        return () => {
          if (typeof off === 'function') off();
        };
      }, 'emotion-ball: DSH theme report');

      /*
       * 上报「用户刚在 DSH 里操作过」：桌面球用它判断角标该不该算已读。
       * 焦点信号在某些环境下不可靠（窗口没被认出前台），但这个信号不会——
       * 你能点、能滚、能打字，就说明你回到 DSH 了。
       */
      ctx.effect(() => {
        let last = 0;
        const touch = () => {
          const now = Date.now();
          if (now - last < 1500) return; // 节流
          last = now;
          try {
            window.fetch(ORIGIN + '/activity', { cache: 'no-store' }).catch(() => {});
          } catch {
            /* 忽略 */
          }
        };
        window.addEventListener('pointerdown', touch, true);
        window.addEventListener('keydown', touch, true);
        window.addEventListener('wheel', touch, { capture: true, passive: true });
        return () => {
          window.removeEventListener('pointerdown', touch, true);
          window.removeEventListener('keydown', touch, true);
          window.removeEventListener('wheel', touch, true);
        };
      }, 'emotion-ball: activity report');

      /* 上报「DSH 页面是否在前台」：桌面球据此决定要不要亮角标。 */
      ctx.effect(() => {
        const report = () => {
          try {
            const focused = document.hasFocus() && document.visibilityState === 'visible' ? '1' : '0';
            window.fetch(ORIGIN + '/focus?f=' + focused, { cache: 'no-store' }).catch(() => {});
          } catch {
            /* 忽略 */
          }
        };
        report();
        window.addEventListener('focus', report);
        window.addEventListener('blur', report);
        document.addEventListener('visibilitychange', report);
        /* 心跳：宿主重启后页面不会重新 apply，纯靠事件会让宿主一直以为「未知」 */
        const timer = window.setInterval(report, 5000);
        return () => {
          window.clearInterval(timer);
          window.removeEventListener('focus', report);
          window.removeEventListener('blur', report);
          document.removeEventListener('visibilitychange', report);
        };
      }, 'emotion-ball: focus report');
    }

    return {
      name: NS,
      inject: ['slots'],
      apply,
    };
  },
});
