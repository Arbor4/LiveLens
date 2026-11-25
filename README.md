# 幕译 · LiveLens

**画面一变，翻译即现。**

幕译（LiveLens）是一款轻量级桌面屏幕实时截图翻译与多引擎文本翻译工具。  
“幕”指屏幕与画面，“Live”强调实时响应，“Lens”寓意镜头所及、看见即译。

基于 Tauri 2 + React + Tailwind CSS 构建，兼具快速启动、原生性能与简洁交互。

## 演示

![demo](assets/demo.png)

## 核心特性

- **仿微信智能选区与悬浮工具栏**：悬停自动框选软件窗口与顶部菜单栏，支持 8 向拖拽微调，选定后通过工具栏按需执行「截图翻译 / 识别文字 / 原位实时 / 副屏实时」
- **双模式实时屏幕翻译**：
  - **原位实时模式**：透明置顶且鼠标穿透，在原区域上方实时覆盖译文（支持区块原位覆盖与吸底字幕条切换）
  - **实时翻译副屏模式**：独立可缩放/全屏窗口，通过 macOS `ScreenCaptureKit` 同步选区画面并等比叠加实时译文（支持智能关键帧省电模式与流畅视频模式）
- **可配置 OCR 与本地大模型**：支持 macOS 原生 **Apple Vision**、外置独立 **RapidOCR** 服务，以及保留随时切回原版 **有道图片翻译**；翻译支持 **HY-MT1.5-1.8B**（Ollama / llama.cpp / MLX）及 必应、Google、微软、腾讯、Yandex、词霸
- **原文 / 译文切换**：静态翻译展示后，在选区内右键或点击工具栏即可快速对比原文与译文
- **网络代理配置**：支持系统代理、自定义代理地址或直连模式
- **语音朗读与语言检测**：支持输入文本自动语种检测与语音播报
- **系统托盘常驻**：关闭主窗口后自动隐藏至系统托盘，支持快捷键唤醒与开机静默自启

> 本地模型与独立 RapidOCR 服务安装指南见 [docs/LOCAL_MODELS.md](docs/LOCAL_MODELS.md)，分阶段演进文档见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 快捷键与交互

| 操作 | 说明 |
|------|------|
| `Ctrl+Shift+X` | 全局快捷键，启动截图翻译（可在设置中修改） |
| `Ctrl+Shift+C` | 全局快捷键，截图识别文字并复制（可在设置中修改） |
| **鼠标左键拖拽** | 框选需要翻译或识别的屏幕区域 |
| **区域内鼠标右键** | 在译文与原文画面之间快速切换 |
| `Esc` / **区域外右键** | 取消截图或关闭结果预览 |
| **点击托盘图标** | 唤醒主窗口 |
| **右键托盘图标** | 打开托盘菜单（显示窗口 / 退出） |

## 技术栈

- **前端**：React 19 + TypeScript + Tailwind CSS v4 + Vite
- **桌面框架**：Tauri 2（Rust 后端 + 多窗口 WebView）
- **截图与选区**：
  - macOS：CoreGraphics / 原生全屏预览与 WebView 交互层
  - Windows / Linux：`screenshots` + `winit` + `softbuffer` 原生选区渲染

## 项目结构

采用 Tauri 2 官方标准的 Vite + React + Rust 分层结构：

```text
.
├── index.html                  # 主窗口入口
├── capture.html                # 截图选区窗口入口
├── overlay.html                # 独立浮层窗口入口
├── package.json                # 前端依赖与脚本
├── vite.config.ts              # Vite 多入口与 Tailwind CSS 配置
├── src/                        # React 前端源码
│   ├── main.tsx                # 主窗口挂载入口
│   ├── capture.tsx             # 截图窗口挂载入口
│   ├── overlay.tsx             # 浮层窗口挂载入口
│   ├── App.tsx                 # 主窗口根组件
│   ├── components/             # UI 组件（HeaderBar、TranslationWorkspace、SettingsPanel 等）
│   ├── constants/              # 语言列表、引擎与代理配置常量
│   ├── lib/                    # Tauri IPC 封装、快捷键与焦点工具
│   ├── styles/                 # Tailwind CSS 全局样式
│   └── types/                  # TypeScript 数据类型定义
└── src-tauri/                  # Tauri 2 Rust 后端
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs             # 二进制入口（调用 livelens_lib::run）
        ├── lib.rs              # 应用构建、插件初始化与托盘生命周期
        ├── state.rs            # 全局共享状态
        ├── config.rs           # 配置与历史记录持久化
        ├── models.rs           # 前后端通信数据结构
        ├── error.rs            # 统一错误类型
        ├── commands/           # Tauri Commands（capture / settings / translate / window / overlay / history）
        ├── capture/            # 屏幕采集与原生选区窗口
        └── translators/        # OCR 图译与多引擎文本翻译实现
```

## 本地开发与构建

### 环境要求

- Node.js 20+ 与 npm
- Rust 工具链（stable）
- Tauri CLI v2（`cargo install tauri-cli --version "^2"`）

### 安装依赖与运行

```bash
npm install
cargo tauri dev
```

### 生产打包

```bash
cargo tauri build
```

打包产物位于 `src-tauri/target/release/bundle/` 目录下。

## macOS 运行说明

如果本地自行打包或分发的应用未使用 Apple 开发者证书签名，首次在 macOS 上打开时系统可能会拦截：

```bash
sudo xattr -cr /Applications/LiveLens.app
```

也可以在访达（Finder）中右键点击 `LiveLens.app` 选择“打开”，或在 **系统设置 > 隐私与安全性** 中允许运行并授予屏幕录制权限。
