import { spawnSync } from "node:child_process";
import os from "node:os";

const platform = os.platform();
const arch = os.arch();

let target = null;
if (platform === "darwin" && arch === "arm64") {
  target = "macos-arm64";
} else if (platform === "win32" && arch === "x64") {
  target = "windows-x64";
}

if (!target) {
  console.error(
    `Unsupported pdfium host: ${platform}/${arch} ` +
      `(supported: darwin/arm64, win32/x64)`
  );
  process.exit(1);
}

const isWindows = platform === "win32";
const script = isWindows
  ? "src-tauri/scripts/fetch_pdfium.ps1"
  : "src-tauri/scripts/fetch_pdfium.sh";
const command = isWindows ? "pwsh" : "bash";
const args = isWindows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, target]
  : [script, target];

const result = spawnSync(command, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
