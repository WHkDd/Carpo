# Xcvt — 报刊版面 OCR (Tauri)

桌面 OCR 工具：导入报刊扫描图像或 PDF → 手动框选版块 → 分组成报道 → 多供应商 OCR → 导出结构化文本。

这是从 [PySide6 旧版](../xcvt) 迁移而来的 Tauri 重写版本。覆盖 macOS（Apple Silicon + Intel）与 Windows，以现代化前端、紧凑桌面体验、批量工作流为目标。

## 状态

✅ **M0 完成** — 项目脚手架就位，设计系统 + 高保真稿就绪，`pnpm tauri dev` 出空壳窗口，CI 雏形就位。

✅ **M1 完成** — 基础 UI shell、Toolbar、StatusBar、Konva Canvas、导入交互、raster image 后端命令、Tauri IPC wrapper、queue/ui store slices 已落地。

✅ **M2 完成** — PDF 队列、PDF 页导航、preview bitmap cache、per-file/page view state、collapsed queue rail 已落地。

✅ **M3 完成** — 手动画块、多选、Transformer resize/drag、选择顺序标签、Delete/Backspace 删除、方向键微调、右键菜单、article color token bridge 已落地。M3 只负责 block geometry 与临时 selection；最终报道建模进入 M4。

✅ **M4 完成** — 报道分组、右栏报道列表、inline rename/delete/clear-all、报刊名/日期元数据、标准/快速 OCR profile toggle 已落地。Article 与 metadata 保持 file/document-scoped；blocks 保持 page-scoped；`selectionOrder` 仅作为临时选择顺序，点击“标记为报道”后固化为 `articleOrder` 并清空 selection，不删除或隐藏选框。

接下来：M4-M7 的详细任务分解见 [`plan.md`](./plan.md)。**[UI] 标记的任务需视觉评审，留给人工或 Claude；[BE] 标记的任务可由 codex 等自动代理推进。**

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
