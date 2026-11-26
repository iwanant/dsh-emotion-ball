# 第三方素材 / Third-Party Assets

本项目的代码是 MIT（见 `LICENSE`），但 **`assets/emotion-ball/` 不是我的作品**，
它有自己的一套许可，想拿去用/改/商用之前请务必读完。

## `assets/emotion-ball/`

来自 **Emotion Ball** 项目（作者 sam70361），遵循其 **Emotion Ball Community License**
（原文见 `assets/emotion-ball/LICENSE` 与 `assets/emotion-ball/NOTICE.md`）。

关键两条：

- **球形象的视觉设计**（身体造型、配色、彩带等特效、整体形象）：
  **仅限个人技术学习与研究，禁止任何商业用途**，且作者**不提供**商业授权。
- **引擎源码与表情配置数据**（状态机、弹簧插值、球面投影、眼环/眼形/嘴形参数、关键帧等）：
  非商业免费；商业用途需另购授权。

所以本插件可以自由使用、修改、分发，**但不能商用**——除非你把美术换掉。

## 想商用怎么办

渲染层只依赖两样东西：

```
assets/emotion-ball/ball.html     页面骨架 + 主题变量 + 面板 UI
assets/emotion-ball/js/           表情引擎（rings / emotions / ball / engine）
```

把 `assets/emotion-ball/` 整体替换成你自己的素材（只要提供同名入口 `ball.html` 和
`window.EmotionBall.create(...)` 这套接口，或者直接改写 `ball.html` 让它用自己的渲染），
本项目的其余部分（状态机、Electron 外壳、通知、主题、运行时安装器）仍然可用，
那时你可以自由选择许可。

## 第三方运行时

插件首次启用时会从官方镜像下载 **Electron**（MIT 许可）到用户目录，
不随本仓库分发，也不需要在此声明。
