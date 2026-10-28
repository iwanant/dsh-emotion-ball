/**
 * 桌面球 —— preload
 *
 * 只暴露「窗口级」能力：拖动、双击拉起 DSH、展开/收起、右键菜单、设置、眼神跟随。
 * 页面本身（ball.html）不做任何 Node 侧的事，保持它是纯渲染 + 纯交互。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshBall', {
  surface: 'desktop',
  dragStart: () => ipcRenderer.send('ball:drag-start'),
  dragTo: (dx, dy) => ipcRenderer.send('ball:drag-to', dx, dy),
  dragEnd: () => ipcRenderer.send('ball:drag-end'),
  openDsh: () => ipcRenderer.send('ball:open-dsh'),
  /* 提前把后台 PowerShell 拉起来，消掉双击的冷启动延迟 */
  warm: () => ipcRenderer.send('ball:warm'),
  expand: (size) => ipcRenderer.send('ball:expand', size),
  collapse: () => ipcRenderer.send('ball:collapse'),
  resetPosition: () => ipcRenderer.send('ball:reset-position'),
  setSetting: (key, value) => ipcRenderer.send('ball:set-setting', key, value),
  onState: (callback) => {
    ipcRenderer.on('ball:state', (_event, state) => callback(state));
  },
  onSettings: (callback) => {
    ipcRenderer.on('ball:settings', (_event, settings) => callback(settings));
  },
  onGaze: (callback) => {
    ipcRenderer.on('ball:gaze', (_event, point) => callback(point));
  },
  onBadge: (callback) => {
    ipcRenderer.on('ball:badge', (_event, payload) => callback(payload));
  },
  onLayout: (callback) => {
    ipcRenderer.on('ball:layout', (_event, layout) => callback(layout));
  },
  onLeave: (callback) => {
    ipcRenderer.on('ball:leave', () => callback());
  },
});
