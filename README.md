# Xcvt — 报刊版面 OCR (Tauri)

桌面 OCR 工具：导入报刊扫描图像或 PDF → 手动框选版块 → 分组成报道 → 多供应商 OCR → 导出结构化文本。

这是从 [PySide6 旧版](../xcvt) 迁移而来的 Tauri 重写版本。覆盖 macOS（Apple Silicon + Intel）与 Windows，以现代化前端、紧凑桌面体验、批量工作流为目标。

## 状态

✅ **M0 完成** — 项目脚手架就位，设计系统 + 高保真稿就绪，`pnpm tauri dev` 出空壳窗口，CI 雏形就位。

🟡 **M1 非 UI 基础已推进** — 已完成 raster image 后端命令、Tauri IPC wrapper、queue/ui store slices。M1 的 AppShell、Toolbar、StatusBar、Konva Canvas、导入交互和视觉 polish 仍按计划留给人工或 Claude UI 评审。

接下来：M1-M7 的详细任务分解见 [`plan.md`](./plan.md)。**[UI] 标记的任务需视觉评审，留给人工或 Claude；[BE] 标记的任务可由 codex 等自动代理推进。**

设计依据：
- [`PRODUCT.md`](./PRODUCT.md) — 用户、口吻、反例、战略原则
- [`DESIGN.md`](./DESIGN.md) — 设计系统：颜色 token、字号、间距、动效
- [`docs/DESIGN.md`](./docs/DESIGN.md) — 实现地图：组件 ↔ shadcn ↔ 文件路径
- [`docs/mockups/*.html`](./docs/mockups/) — 浏览器可直接打开的高保真稿

## 技术栈

- **框架**: Tauri 2.x
- **前端**: React 18 · Vite · TypeScript · Zustand · Konva · Tailwind · shadcn/ui
- **后端**: Rust · `pdfium-render` · `reqwest` · `tokio` · `keyring`
- **OCR**: PaddleOCR · OpenAI Vision · Claude Vision · OpenRouter
- **分发**: macOS DMG（arm64 + x64）· Windows MSI/NSIS

## 本地开发

```bash
pnpm install
pnpm tauri dev
```

要求：Node 20+、pnpm 10、Rust stable、平台对应的 webview 依赖。

## 目录结构

```
src/                  # React 前端
src-tauri/            # Rust 后端
docs/                 # 设计与签名说明
.github/workflows/    # CI / 发布
```

## License

MIT — 见 [LICENSE](./LICENSE)。
