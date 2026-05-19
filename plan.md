# Xcvt 功能改进计划

## 0. 目标与边界

这一轮改进的目标是把 Xcvt 的 OCR 能力拆清楚：框选识别继续作为精细识别与整理的核心；全文识别在 Paddle 服务商下升级为更接近 Paddle 网页版的文档级识别；同时新增 Paddle 网页版 JSON 的导入、预检与版式重建 PDF 导出能力。

不加入 `Chronicles-OCR` 功能。该仓库是古文字/VLLM 评测基准，不是 OCR 服务商或可直接接入的识别模型。后续如果要比较模型在古文字上的效果，可以单独做 benchmark，不纳入本轮产品功能。

## 1. 模式定义

### 1.1 框选识别

用于用户在画布上框选报道、段落或局部区域后进行精细识别。

实现原则：

- 继续支持 Paddle、OpenAI、OpenRouter、OpenAI-compatible。
- 对 Paddle 仍走局部图片/裁切块识别。
- 对 OpenAI/OpenRouter 保持 vision OCR 逻辑。
- 不启用文档级 Paddle 参数，避免版式重构影响局部块识别。

### 1.2 逐页全文识别

保留为兼容模式，适合 OpenAI/OpenRouter 以及需要逐页即时反馈的场景。

实现原则：

- PDF 每页渲染为图片。
- 每页独立识别。
- 每页完成后可立即写入右侧文本面板。
- 不作为 Paddle 的首选全文模式。

### 1.3 Paddle 文档级全文识别

当全文识别选择 Paddle provider 时，优先走文档级 API，而不是逐页 PNG。

目标流程：

```text
原 PDF / 图片文件
-> Paddle /api/v2/ocr/jobs
-> pageRanges
-> optionalPayload
-> 轮询 extractProgress
-> 下载 jsonUrl / markdownUrl
-> 按页解析结果
-> 写入右侧页文本与 layout 数据
```

### 1.4 Paddle JSON 版式导出

用户可以使用 Paddle 网页版 OCR 完整 PDF，再把网页端导出的 JSON 导入 Xcvt。

目标能力：

- 读取 Paddle JSON。
- 预检识别参数与结构字段。
- 写入按页文本，支持右侧按页查看。
- 根据 `block_label`、`block_content`、`block_bbox`、`block_order`、`block_polygon_points` 生成版式重建 PDF。

## 2. 前置复杂度优化

这几项应在新增大功能前优先处理，避免后续页数和文本量增大后放大性能问题。

### 2.1 OcrTextPanel 全文文本延迟组装

现状问题：

- 当前 `OcrTextPanel` 在渲染阶段会组装所有页文本。
- 全文模式下会排序所有页并拼接全文。
- 大 PDF 或导入 Paddle JSON 后可能卡主线程。

改法：

- 渲染阶段只计算是否有文本、页数、当前页文本。
- 点击“复制所有页”或“导出所有页”时再临时组装全文。
- `buildAllPagesText()` 不再放在常规 render/useMemo 路径中。

验收：

- 右侧面板切页不触发全文拼接。
- 复制全部、导出全部结果不变。

### 2.2 AppShell 分组 OCR 结果匹配优化

现状问题：

- grouped OCR done 时已构造 `errorById`，但结果仍通过 `payload.results.find(...)` 查找。
- 复杂度为 `requestedArticles x results`。

改法：

```ts
const resultById = new Map(payload.results.map((r) => [r.article_id, r.text]));
```

然后按 article id O(1) 查询。

验收：

- 分组 OCR 结果合并逻辑不变。
- 错误文章仍显示 `[识别失败：...]`。
- 未返回结果仍显示 `[未识别]`。

### 2.3 pageStateSlice block 查找优化

现状问题：

- `syncArticleBlocks()` 对每个 `article.blockRefs` 在对应页面 `blocks` 里 `find`。
- 跨页报道和 block 多时会放大为重复线性查找。

改法：

- 同步前按页建立索引：

```ts
Map<page, Map<blockId, block>>
```

- 根据 `ref.page/ref.blockId` O(1) 查找 block。

验收：

- 删除报道、清空报道、跨页报道、重编号行为不变。
- 增加针对跨页 article/block refs 的单测。

## 3. PageRangePlan

所有全文 OCR 都使用统一的页码范围模型。

### 3.1 数据结构

```ts
type PageRange = {
  from: number;
  to: number;
};

type PageRangePlan = {
  raw: string;
  totalPages: number;
  ranges: PageRange[];
  pages: number[];
  paddlePageRanges: string;
};
```

### 3.2 支持格式

输入示例：

```text
1-5,8-230,233,235,240-288
```

解析结果：

```text
ranges:
1-5
8-230
233
235
240-288

paddlePageRanges:
1-5,8-230,233,235,240-288
```

连续页自动合并：

```text
1-5,8-230,231,240-288
-> 1-5,8-231,240-288
```

### 3.3 校验规则

- 空值表示全部页。
- 支持空格。
- 去重。
- 排序。
- 合并连续区间。
- 禁止 0 页。
- 禁止负数。
- 禁止超出 `totalPages`。
- 禁止倒序区间，如 `9-3`。
- 非法字符给出明确错误。

### 3.4 落地位置

```text
src/lib/page-range.ts
src/lib/__tests__/page-range.test.ts
```

前端用于即时校验，后端执行前仍需二次校验。

## 4. 页码跳转 PageJumpControl

### 4.1 目标

画布和右侧全文识别文本面板都支持输入页码跳转 PDF。

### 4.2 组件

```tsx
<PageJumpControl
  fileId={file.id}
  currentPage={file.currentPage}
  totalPages={file.pdfTotal}
  variant="canvas"
/>
```

### 4.3 交互

- 输入数字后 Enter 跳转。
- blur 时提交。
- Esc 回滚。
- 非法输入恢复当前页。
- 超出范围自动 clamp 到 `1..totalPages`。
- 输入框 focus 时不触发现有快捷键。
- 仅在 `pdfTotal > 1` 时显示。

### 4.4 放置位置

- 画布：右下或底部浮动控件，显示 `[当前页] / 总页数`。
- 右侧全文文本面板：替换现有静态 `第 X / Y 页`。

### 4.5 状态调用

```ts
setCurrentPage(fileId, page)
```

该控件只改变当前页，不触发 OCR。

## 5. 统一按页 OCR 结果存储

### 5.1 目标

无论结果来自逐页 PNG、Paddle 文档 job、Paddle 分块 job、Paddle JSON 导入，都按原 PDF 页码存储。

### 5.2 数据结构

```ts
type RecognizedPage = {
  text: string;
  layout?: LayoutPage;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  sourceMode:
    | "page_image"
    | "paddle_document"
    | "paddle_document_chunk"
    | "paddle_json_import";
  sourceJobId?: string;
  chunkId?: string;
  chunkPage?: number;
};

type RecognizedPages = Record<string, Record<number, RecognizedPage>>;
```

### 5.3 兼容策略

第一阶段保留现有：

```ts
pageOcrTexts[fileId][page] = text
```

新增 `recognizedPages` 后同步写入旧结构，避免一次性改动全部 UI。

第二阶段右侧文本面板改为优先读取：

```ts
recognizedPages[fileId]?.[currentPage]?.text
```

## 6. Paddle 文档级全文识别

### 6.1 新增后端模块

建议新增：

```text
src-tauri/src/ocr/paddle_document.rs
```

保留当前 `paddle.rs` 作为单图/裁切块识别路径。

### 6.2 提交逻辑

multipart 本地上传：

```text
file: 原 PDF / 图片
model: PaddleOCR-VL-1.5
pageRanges: "1-5,8-230,233,235,240-288"
optionalPayload: JSON string
```

fileUrl 模式：

```json
{
  "fileUrl": "...",
  "model": "PaddleOCR-VL-1.5",
  "pageRanges": "1-5,8-230,233,235,240-288",
  "optionalPayload": {}
}
```

### 6.3 任务流程

```text
submit_document_job
-> poll_document_job
-> fetch jsonUrl / markdownUrl
-> parse_paddle_jsonl_by_page
-> write recognizedPages/pageOcrTexts
```

### 6.4 UI 行为

- 任务运行时显示文档级进度：`extractedPages / totalPages`。
- 完成后一次性写入所有页。
- 如果后续走分块，则每个 chunk 完成后写入一批页。

## 7. 大文件与分块策略

### 7.1 限制

Paddle API 限制：

```text
multipart file <= 50MB
fileUrl <= 200MB
PDF <= 1000 页
```

### 7.2 策略

```text
<= 50MB:
  直接 multipart 上传

50-200MB:
  有 fileUrl 时使用 fileUrl
  无 fileUrl 时本地自动分块

> 200MB:
  提示压缩/拆分
  或继续使用本地分块
```

### 7.3 分块方式

推荐只抽用户选择的页生成 chunk PDF，而不是把未选页也放进去。

示例：

```text
用户选择:
1-5,8-230,233,235,240-288

chunk-001:
原始页 1,2,3,4,5,8,...,120

chunk-002:
原始页 121,...,230,233,235

chunk-003:
原始页 240,...,288
```

每个 chunk 控制在 40-45MB 以下。

### 7.4 映射 manifest

```ts
type ChunkManifest = {
  chunkId: string;
  chunkPdfPath: string;
  originalPages: number[];
  chunkPageToOriginalPage: Record<number, number>;
  originalPageToChunkPage: Record<number, number>;
};
```

回填时：

```ts
const originalPage = chunkPageToOriginalPage[chunkPage];
recognizedPages[fileId][originalPage] = result;
```

UI 永远使用原 PDF 页码，不显示 chunk 页码。

## 8. Paddle 参数策略

### 8.1 参数分组

区分三套参数：

```ts
paddleGroupedPayload
paddleDocumentPayload
paddleJsonExpectedSettings
```

### 8.2 默认策略

框选识别：

- 保守。
- 不启用文档级版面重组参数。

Paddle 文档识别：

- 尽量接近 Paddle 网页版。
- 开启 layout detection、seal recognition、title level、table merge、polygon points 等适合文档级解析的选项。

Paddle JSON 导入：

- 不修改 JSON。
- 只读取 `model_settings` 和结果字段，做预检提示。

### 8.3 UI

第一版不必做复杂开关面板。可以先做：

- 恢复框选默认。
- 恢复文档默认。
- 高级 JSON 编辑。
- JSON 校验。

后续再做和 Paddle 网页版一致的可视化开关。

## 9. Paddle JSON 导入预检

### 9.1 入口

新增入口：

```text
导入 Paddle JSON
```

允许两种使用方式：

- 已打开对应 PDF：导入 JSON 后关联当前文件。
- 未打开 PDF：作为独立 JSON 文档导入，只做预检和 PDF 导出。

### 9.2 后端命令

```rust
analyze_paddle_json(path) -> PaddleJsonPreflightReport
```

### 9.3 报告结构

```ts
type PaddleJsonPreflightReport = {
  pageCount: number;
  blockCount: number;
  labelCounts: Record<string, number>;
  modelSettings: Record<string, unknown>;
  hasParsingResults: boolean;
  hasBlockBbox: boolean;
  hasBlockOrder: boolean;
  hasPolygonPoints: boolean;
  hasMarkdown: boolean;
  hasImages: boolean;
  warnings: string[];
};
```

### 9.4 检查内容

- 页数。
- block 总数。
- label 统计。
- 是否有 `prunedResult.parsing_res_list`。
- 是否有 `block_bbox`。
- 是否有 `block_order`。
- 是否有 `block_polygon_points`。
- 是否有 `markdown.text`。
- 是否有 `markdown.images`。
- 是否有 `outputImages`。
- `model_settings` 中哪些参数开启/关闭。
- `markdown_ignore_labels` 忽略了哪些内容。

### 9.5 提示分类

```text
已确认开启
已确认关闭
JSON 未记录，无法判断
结构存在，可用于导出
结构缺失，导出质量受限
```

## 10. LayoutDocument 中间模型

### 10.1 目标

不要直接用 Paddle 原始 JSON 排版。先转换为项目自己的中间模型，方便后续支持 GLM-OCR 或其它 provider。

### 10.2 数据结构

```ts
type LayoutDocument = {
  source: "paddle" | "glm_ocr";
  pages: LayoutPage[];
};

type LayoutPage = {
  index: number;
  width: number;
  height: number;
  blocks: LayoutBlock[];
};

type LayoutBlock = {
  label: string;
  text: string;
  bbox: [number, number, number, number];
  polygon?: [number, number][];
  order?: number;
  imageRef?: string;
  raw?: unknown;
};
```

### 10.3 Paddle adapter

解析：

```text
JSON array index -> page index
prunedResult.parsing_res_list -> blocks
block_label -> label
block_content -> text
block_bbox -> bbox
block_order -> order
block_polygon_points -> polygon
markdown.images/outputImages -> resources
```

页面宽高：

- 如果 JSON 有明确页面尺寸，优先使用。
- 否则从 bbox 最大值估计。

## 11. 版式重建 PDF 导出

### 11.1 目标

生成“代排版 PDF”，不是“原图背景 + 隐形文字层 PDF”。

### 11.2 导出模式

第一版先做：

```text
bbox 近似版式
```

后续再做：

```text
阅读重排版
```

### 11.3 导出选项

```ts
type LayoutPdfExportOptions = {
  mode: "bbox" | "reading";
  includeHeader: boolean;
  includeFooter: boolean;
  includePageNumber: boolean;
  includeAsideText: boolean;
  includeFootnote: boolean;
  includeImages: boolean;
  includeTables: boolean;
  fontScale: number;
  marginScale: number;
};
```

第一版默认：

```text
mode = bbox
includeHeader = true
includeFooter = true
includePageNumber = true
includeAsideText = true
includeFootnote = true
includeImages = false
includeTables = true, placeholder
```

### 11.4 坐标转换

Paddle 坐标原点在左上角，PDF 坐标原点在左下角。

```ts
pdfX = x0 * scale;
pdfY = pageHeightPdf - y1 * scale;
pdfW = (x1 - x0) * scale;
pdfH = (y1 - y0) * scale;
```

### 11.5 block 渲染规则

```text
doc_title:
  大字号；竖排 title 可近似竖排

paragraph_title:
  较大字号；可加粗

text:
  正文

aside_text:
  小字号；保留边栏位置

vision_footnote:
  小字号；保留页底位置

header/footer/number:
  小字号浅灰

table:
  第一版文本/占位；后续 table renderer

image/header_image/footer_image:
  第一版占位；后续嵌入图片
```

### 11.6 溢出策略

```text
先换行
仍溢出 -> 缩小字号
仍溢出 -> 扩展 block 高度
仍溢出 -> 写入 warning
```

不要无提示截断正文。

### 11.7 技术选型

正式软件功能应放在 Rust/Tauri 后端，不依赖 Python。

第一版要求：

- 能稳定绘制中文。
- PDF 可打开。
- 文本可复制。
- 打包 macOS/Windows 可用。

如 Rust PDF 库对 CJK 字体支持成本较高，可先将 Python/ReportLab 原型作为验证脚本，但正式版本迁移到 Rust。

## 12. 图片和表格资源

### 12.1 第一版

- 图片块显示占位框。
- 表格块显示文本或简单表格。
- 不强依赖 Paddle 图片 URL，因为 URL 可能过期。

### 12.2 第二版

- 导入 JSON 时尝试下载 `markdown.images` 和 `outputImages`。
- 保存到本地资源目录。
- PDF 导出时嵌入图片。
- 表格使用独立 table renderer。

资源目录：

```text
exports/{docId}/
  source.json
  assets/
  layout.pdf
  manifest.json
```

## 13. JSON 导入后的右侧文本联动

导入 Paddle JSON 后，除了可导出 PDF，也应写入按页文本。

流程：

```text
Paddle JSON
-> LayoutDocument
-> 每页提取 markdown.text 或 blocks text
-> recognizedPages[fileId][page] = { text, layout, sourceMode: "paddle_json_import" }
-> 右侧全文面板按 currentPage 显示
```

如果当前已打开 PDF：

- 尝试关联当前文件。
- 页数不一致时提示用户确认。

如果未打开 PDF：

- 作为独立 JSON 文档显示预检与导出功能。
- 不提供画布联动。

## 14. GLM-OCR 位置

GLM-OCR 可以后续作为轻量文档 OCR provider，但不作为本轮主线。

原因：

- GLM-OCR 支持 PDF/图片、Markdown、layout details、bbox、表格 HTML。
- 但官方限制 PDF <= 50MB、最大 100 页。
- label 粒度主要是 `image/text/formula/table`，不如 Paddle 的页眉、页脚、页码、旁注、脚注、标题层级等细。

后续如果接入，复用 `LayoutDocument` adapter：

```text
GLM layout_details -> LayoutDocument
```

但预检报告中需明确提示：GLM 的版式标签粒度低于 Paddle。

## 15. UI 入口

建议入口：

- 顶部工具栏：全文识别模式、页码范围、页码跳转。
- 设置：Paddle 参数预设 / 高级 JSON。
- 文件菜单或工具栏：导入 Paddle JSON。
- JSON 预检面板：显示结构报告与导出按钮。
- 导出对话框：版式 PDF 导出选项。

典型流程：

```text
打开 PDF
-> 选择全文识别
-> provider = Paddle
-> 输入页码范围
-> 开始文档级 OCR
-> 右侧按页查看文本
```

或：

```text
Paddle 网页版 OCR PDF
-> 导出 JSON
-> Xcvt 导入 Paddle JSON
-> 预检
-> 右侧按页查看
-> 导出版式重建 PDF
```

## 16. 测试与验收

### 16.1 单元测试

```text
page-range parser
PageRangePlan normalization
Paddle JSON preflight
Paddle JSON -> LayoutDocument
chunk page mapping
bbox coordinate conversion
label include/exclude filtering
AppShell resultById merge
syncArticleBlocks map lookup
```

### 16.2 集成测试

使用小型 Paddle JSON fixture：

- 验证页数。
- 验证 label 统计。
- 验证按页文本提取。
- 验证导出 PDF 页数。

### 16.3 人工验证

- 300 页以上 PDF 的页码跳转不卡。
- 全文模式右侧只显示当前页，不预拼接全文。
- Paddle 文档识别完成后页码对应正确。
- 分块 OCR 后原始页码映射正确。
- JSON 导入后预检提示准确。
- 版式 PDF 随机抽查 5-10 页，旁注、页码、正文位置合理。

### 16.4 当前环境注意

本工作区如果缺少：

```text
src-tauri/pdfium/macos-arm64/libpdfium.dylib
node_modules
```

则 `cargo check/test` 或 `pnpm` 验证会失败。正式实现前先运行：

```text
pnpm install
pnpm prepare:pdfium
```

再执行完整验证。

## 17. 推荐实施顺序

### Phase 1: 前置整理

1. 修 `OcrTextPanel` 全文文本延迟组装。
2. 修 `AppShell` grouped OCR result lookup。
3. 修 `pageStateSlice` block lookup map，并补测试。

### Phase 2: 页码体验

4. 实现 `PageRangePlan`。
5. 实现 `PageJumpControl`。
6. 右侧文本面板与画布接入页码跳转。

### Phase 3: 结果模型

7. 新增 `recognizedPages`。
8. 兼容写入现有 `pageOcrTexts`。
9. 右侧全文面板逐步切换到统一按页结果。

### Phase 4: Paddle 文档级 OCR

10. 新增 `paddle_document.rs`。
11. 支持 `file + pageRanges + optionalPayload`。
12. 下载并保存 `jsonUrl/markdownUrl`。
13. 解析 Paddle 文档结果并按页写入。

### Phase 5: 大文件与分块

14. 实现本地 PDF 分块。
15. 生成 chunk manifest。
16. chunk 结果按原始页码回填。

### Phase 6: Paddle JSON 导入

17. 实现 JSON 预检。
18. 实现 `LayoutDocument` adapter。
19. JSON 导入后写入右侧按页文本。

### Phase 7: 版式 PDF 导出

20. 实现 bbox 版式 PDF renderer。
21. 加导出选项。
22. 表格/图片第一版占位。
23. 后续增强图片下载与表格渲染。

