import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { logError } from "./lib/runtime";
import "katex/dist/katex.min.css";
import "./styles/globals.css";

// Forward uncaught frontend errors into the Tauri log file so post-mortem
// debugging works without DevTools. Both handlers swallow their own failures
// (logging can race with shutdown / IPC teardown) to avoid feedback loops.
window.addEventListener("error", (event) => {
  const where = event.filename
    ? ` at ${event.filename}:${event.lineno}:${event.colno}`
    : "";
  void logError(`uncaught error: ${event.message}${where}`);
});

window.addEventListener("unhandledrejection", (event) => {
  const reason =
    event.reason instanceof Error
      ? `${event.reason.name}: ${event.reason.message}${
          event.reason.stack ? `\n${event.reason.stack}` : ""
        }`
      : String(event.reason);
  void logError(`unhandled rejection: ${reason}`);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
