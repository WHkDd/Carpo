# Xcvt — 报刊版面 OCR

桌面 OCR 工具，专门处理近代中文报刊扫描件。导入图像或 PDF，框选报道版块或整页识别，多家
provider 任选，结果导出为 Markdown / 纯文本。

跨平台桌面应用，覆盖 macOS（Apple Silicon）与 Windows。由于无Windows设备测试，Windows平台属于理论可用。

## 特性

- **两种识别模式**：框选报道（一篇报道可跨多块、跨多页拼成完整文本）/ 全文按页识别。
- **多 provider 路由**：PaddleOCR（百度异步 jobs API）、OpenAI Vision、OpenRouter、任意
  OpenAI-compatible 自建端点；任意切换不丢失先前识别结果。
- **结构化导出**：识别后的报道按选择顺序组装成单篇 Markdown，支持复制 / 单篇导出 / 整文档导出。
- **本地凭据**：API key / Token 通过系统 Keychain（macOS）/ Credential Manager（Windows）保管，
  不会写入项目文件，也不会跨设备同步。
- **细粒度取消**：识别进行中点取消会立刻打断长 poll 与回退退避，不会再继续烧 OCR 配额。
- **大画布顺滑**：PDFium 渲染走专用线程；图像以二进制 IPC 传给前端，单页 50MB+ 的 A3 报纸也能流畅切页。

## 安装

正式包从 [Releases](https://github.com/WHkDd/xcvt-tauri/releases/latest) 下载：

- macOS Apple Silicon：`Xcvt_*_aarch64.dmg`
- Windows：`Xcvt_*_x64-setup.exe` 或 `Xcvt_*_x64_en-US.msi`

### macOS 首次启动

当前首次双击会触发 Gatekeeper 拦截。

**终端命令**：把 dmg 里的 `Xcvt.app` 拖到 `/Applications`，然后运行

   ```bash
   xattr -dr com.apple.quarantine /Applications/Xcvt.app
   ```

### Windows 首次启动

SmartScreen 会显示蓝色拦截框。点 **更多信息 → 仍要运行** 即可。

## 本地开发

```bash
pnpm install
pnpm prepare:pdfium   # 下载对应平台的 PDFium 动态库到 src-tauri/pdfium/
pnpm tauri dev
```

要求：Node 20+、pnpm 10、Rust stable（推荐 1.78+）、平台对应的 webview 依赖
（macOS：Xcode CLI；Windows：WebView2 Runtime）。

### 常用命令

```bash
pnpm typecheck                       # tsc --noEmit
pnpm test                            # vitest
pnpm lint                            # eslint
pnpm tauri build                     # 出发布包到 src-tauri/target/release/bundle/
( cd src-tauri && cargo test )       # Rust 单测 + 集成测试
```

## 待做

[] 更多服务商接入（GLM-OCR等）
[] 本地模型支持
[] 全文识别模式下可跳页选择，目前只接受选择连续页

## 技术栈

- **框架**：Tauri 2.x
- **前端**：React 18 · Vite · TypeScript · Zustand · Konva · Tailwind · shadcn/ui
- **后端**：Rust · `pdfium-render` · `reqwest` · `tokio` · `keyring`
- **OCR**：PaddleOCR（异步 jobs）· OpenAI Vision · OpenRouter · OpenAI-compatible

## 目录结构

```
src/                  React 前端
  components/         画布、版块、报道列表、设置等组件
  hooks/              文件导入、PDF 翻页、bitmap LRU 缓存、OCR 触发等
  store/              Zustand slices
  lib/                IPC 类型契约 / 工具函数
src-tauri/            Rust 后端
  src/
    commands/         #[tauri::command] handlers
    jobs/             grouped / whole-file OCR runner
    ocr/              provider 实现（paddle / openai）
    pdf.rs            PDFium worker（专用线程 + tokio mpsc）
.github/workflows/    CI / release
```

## License

MIT — 见 [LICENSE](./LICENSE)。
