# Carpo agent bridge

Opt-in local API. Read `agent-bridge.json` in Carpo's app data directory for
`port`, `token`, `pid`, `version`. On macOS:
`~/Library/Application Support/local.kai.carpo/agent-bridge.json`.
Send every request to `http://127.0.0.1:<port>/v1` with
`Authorization: Bearer <token>`. Never send Origin. Tokens change on restart or
re-enabling. Closing the macOS window hides it; quitting Carpo stops the API.

- `GET /guide`: this Markdown guide.
- `GET /skill`: the installable `carpo/SKILL.md`, including YAML frontmatter.
- `GET /status`: application version, file count, foreground task, batch state.
- `GET /files`: file metadata and ids.
- `POST /files/import`: `{ "paths": ["/absolute/scan.pdf"] }` or
  `{ "dir": "/absolute/scans", "recursive": true }`. Returns `fileIds`, `files`.
  Symlink directories are not traversed. Unsupported files in a directory are skipped.
  Explicit missing/unsupported files fail. Inspect each returned `loadError`.
- `PATCH /files/:id`: optional `newspaperName`, `newspaperDate`, `tags` (string array).
- `POST /ocr/batch`: `{ "fileIds": ["..."] }`. Starts OCR without exporting;
  reuses existing usable results. Returns immediately after job setup.
- `GET /ocr/batch`: poll `status`, `items`, progress and errors until terminal.

OCR uses the application's configured provider and may incur provider charges.
Carpo does not install skills or credentials into agent directories itself.
Document/OCR state is session-local.
HTTP errors return `{ "error": "..." }`; a frontend timeout is HTTP 504.
A timeout does not roll back work already started: inspect status before retrying.

## Install the Carpo skill

In Settings → Agent, enable control and copy the installation instructions to
your agent. The agent reads the discovery file, authenticates `GET /skill` and
saves the full successful Markdown response as `carpo/SKILL.md` in its own
user-level skills directory, following its harness conventions. Preserve user
customizations if a skill already exists. Refresh skills or restart the agent
session if required, then verify with `GET /status`. Installation does not start
OCR or modify documents.

The skill is bundled with Carpo from `skills/carpo/SKILL.md`; installation does
not require a separate service or downloading anything from an external site.
Carpo itself never writes to an agent's directories. The installed skill contains
no port/token and reads discovery plus the current `/guide` on each task. After
installation, ask your agent in natural language to operate Carpo. Connection
still requires Carpo to be running with agent control enabled.

## Read scans and submit corrections

`GET /files/:id/units` returns `{units:[{key,text,images:[{key,page,path}]}]}`.
Keys are `page:1` or `article:<id>`; URL-encode keys when used in a path.
`text` can be null for an unrecognized page. Images are real PNG files in
Carpo's app cache (`agent-bridge-images`), available to local image-reading
tools. Pages render at 150 DPI; articles are cropped from their source pages.
Cache images are cleared at the next launch. Treat the returned text as a snapshot.

`POST /files/:id/units/:key/review` accepts:

```json
{
  "baseText": "新聞",
  "suggestions": [{
    "before": "聞",
    "after": "闻",
    "context_before": "新",
    "category": "charform",
    "confidence": 1,
    "reason": "字形校正"
  }],
  "apply": false
}
```

`baseText` is REQUIRED and must equal the snapshot text you read. Read the scan
before correcting. Categories: `punct`, `charform`, `garble`, `layout`, `semantic`.
Confidence is 0–1. Anchors (`context_before` + `before`) must identify a unique
span after whitespace removal; invalid/ambiguous anchors reject the request.
`before` must be nonempty. Insertions/deletions follow the existing review
engine's span rules. Do not submit while the file has an active OCR/proofread task.

Without `apply`, a pending review appears in Carpo's existing review panel;
punct/charform/garble use its normal accepted defaults, layout/semantic remain
pending. With `apply:true`, all submitted suggestions are accepted and applied
through the same engine; response includes `review.appliedConflictSkipped` for
overlapping suggestions. GUI Undo remains available and refuses stale text.
Undo or discard an existing applied review in Carpo before replacing it.

## Export current text

`POST /export`:

```json
{"fileIds":["..."],"layout":"merged","format":"md","target":"/absolute/result.md"}
```

Formats: `md`, `docx`, `layout-pdf`. Layouts: `separate`, `merged`, `by_tag`.
For `merged`, target is an absolute FILE path with an existing parent; it replaces
that exact file. For `separate` / `by_tag`, target is an existing absolute DIRECTORY;
filenames are sanitized and collisions get ` (2)`, ` (3)`, etc. No picker appears.

Markdown/DOCX export existing text only and never start OCR. Response is
`{"status":"started"}`; poll `GET /ocr/batch` for terminal state, per-file failures,
`batch.error` and `batch.outputs` (written absolute paths). A terminal `done` does
not imply every item succeeded. Use a separate OCR batch first when text is missing.

`layout-pdf` requires whole-page structured layout data (e.g. PaddleOCR or imported
Paddle JSON) for every requested file. It produces Carpo's existing reflowed reading
PDF, not a facsimile of the scanned page. Article-only/plain text OCR cannot use it.
Edited page text is honored, including pages edited to empty. Pages without layout
are omitted, matching the GUI exporter. Merged/by-tag PDFs concatenate source pages
in metadata sort order; original page-number anchors may repeat across files.
PDF returns `{outputs:[{targetPath,pageCount,warningCount,warnings}]}` after writing.
No OCR is started. A system CJK font must be available, as in the GUI PDF exporter.
Multi-document output is not transactional; earlier outputs remain if a later
write fails. Check target directory and status before retrying.

## Minimal local client

```python
import json, pathlib, urllib.request
p = pathlib.Path.home() / "Library/Application Support/local.kai.carpo/agent-bridge.json"
d = json.loads(p.read_text())
base = f"http://127.0.0.1:{d['port']}/v1"
headers = {"Authorization": f"Bearer {d['token']}", "Content-Type": "application/json"}
def call(method, path, body=None):
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    with urllib.request.urlopen(req) as response:
        return response.read().decode()
print(call("GET", "/guide"))
```

On other systems use the discovery path shown in Settings → Agent. The API binds
only loopback, accepts Host `127.0.0.1:<port>` or `localhost:<port>`, rejects any
Origin header and requires authentication even for guide/status. The request body
limit is 2 MiB; frontend reply timeout is 120 seconds. Calls require a loaded main
WebView. Treat token and rendered images as private local data. Turning the switch
off removes discovery and stops listening immediately; re-enable creates new credentials.
