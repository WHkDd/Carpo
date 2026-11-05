---
name: carpo
description: 操作正在运行的 Carpo 桌面应用，按本地路径导入报刊扫描件、批量 OCR、对照原图提交校对并导出 Markdown、DOCX 或阅读版 PDF。Use when the user asks to control Carpo; use Carpo's local bridge and live GUI state.
---

# Carpo

通过 Carpo 进程内的本地 HTTP bridge 操作当前 GUI 会话。Carpo 必须正在运行，且设置 → Agent →「允许 agent 控制」已开启。应用退出或关闭开关后无法调用；不要启动额外的常驻服务。

## 连接

每次任务开始时重新读取 `agent-bridge.json`。优先使用用户或安装指令提供的发现文件路径；否则按系统查找：

| 系统 | 发现文件 |
| --- | --- |
| macOS | `~/Library/Application Support/local.kai.carpo/agent-bridge.json` |
| Windows | `%APPDATA%/local.kai.carpo/agent-bridge.json` |
| Linux | `$XDG_DATA_HOME/local.kai.carpo/agent-bridge.json`；变量未设置时用 `~/.local/share/local.kai.carpo/agent-bridge.json` |

文件包含 `port`、`token`、`pid`、`version`。仅连接 `http://127.0.0.1:<port>/v1`，请求带 `Authorization: Bearer <token>`，不发送 Origin。绕过 HTTP 代理，防止本机鉴权信息经代理发送。

先 `GET /guide` 并阅读返回的最新完整 API 说明，再 `GET /status` 确认当前文件和任务。以当前应用的 guide 为准，不依赖安装时的接口版本。

下面是可按需使用的标准库连接示例；它只读取连接信息和 guide，不修改文档：

```python
import json
import os
import sys
import urllib.request
from pathlib import Path

# 若安装指令提供了发现文件绝对路径，直接用该路径替换这里的自动发现。
if sys.platform == "darwin":
    discovery = Path.home() / "Library/Application Support/local.kai.carpo/agent-bridge.json"
elif sys.platform == "win32":
    discovery = Path(os.environ["APPDATA"]) / "local.kai.carpo/agent-bridge.json"
else:
    data_home = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local/share"))
    discovery = data_home / "local.kai.carpo/agent-bridge.json"

connection = json.loads(discovery.read_text(encoding="utf-8"))
port = connection["port"]
if type(port) is not int or not 1 <= port <= 65535:
    raise ValueError("Invalid Carpo bridge port")
base = f"http://127.0.0.1:{port}/v1"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def call(method, path, body=None):
    request = urllib.request.Request(
        base + path,
        data=None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {connection['token']}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with opener.open(request, timeout=130) as response:
        return response.read().decode("utf-8")

print(call("GET", "/guide"))
```

发现文件缺失或连接被拒绝时，请用户打开 Carpo 并开启控制。401 时重新读取发现文件后仅重试连接一次；仍失败则报告问题。不要读取钥匙串、查找供应商 API key 或把 token 写入 skill、脚本文件或回复。

## 执行用户任务

- **导入**：按用户指定的绝对路径调用 `/files/import`，从响应获取 file IDs 并检查 `loadError`。用 `/files` 获取当前队列；文件 ID 只属于当前会话。
- **识别**：明确范围后调用 `/ocr/batch`，轮询批量进度，检查每个 item 和批量错误。识别使用 Carpo 已配置的供应商，可能产生费用；仅安装或验证连接不构成启动识别的请求。
- **校对**：读取 `/files/:id/units` 并查看返回的本地 PNG。保留原文的繁体、异体字及历史用语，不凭语感改写。提交时使用读取到的完整 `baseText` 和 guide 规定的建议结构；默认进入 GUI 审阅面板，仅在用户要求直接应用时带 `apply:true`。遇到 stale 或锚点错误，重新读取并核对，不绕过检查。
- **导出**：按用户指定格式、布局和绝对目标路径调用 `/export`。Markdown/DOCX 导出已有文本，不自动补做识别。`merged` 指定文件并会覆盖该文件；`separate`/`by_tag` 指定已有目录。阅读版 PDF 需要结构化整页布局；缺少布局时报告限制，不擅自重新 OCR。按 guide 判断同步响应或需轮询的批量任务。

HTTP 超时不表示操作没有发生。先查询状态或检查输出，再决定是否重试修改、识别或导出，避免重复任务。报告实际完成的文件、失败项和导出路径；批量 `done` 仍需检查各项是否成功。

本 skill 只保存调用方法。端口和 token 会变化；不要缓存它们，也不要把用户文件或原图发送给 Carpo 以外的服务来替代用户要求的本地调用。
