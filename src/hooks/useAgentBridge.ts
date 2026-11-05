import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildLayoutDocumentFromRecognizedPages } from "@/components/structure/OcrTextPanel";
import { useStore } from "@/store";
import { isTauriRuntime, logWarn } from "@/lib/runtime";
import {
  batchEntry,
  planBatchFile,
  planOutputDocs,
  safeFileStem,
  sortBatchEntries,
  startBatchExport,
} from "@/lib/batch-export";
import { planProofreadImages } from "@/lib/proofread-images";
import {
  buildProofreadReview,
  findSuggestionSpan,
  parseProofreadTargetKey,
  proofreadKeyFor,
  type ProofreadTarget,
} from "@/lib/proofread";
import { proofreadTargetText } from "@/store/jobSlice";
import type { ProofreadSuggestion } from "@/lib/ipc-types";
import { consumePendingOpenPaths } from "./useDesktopIntegration";

interface AgentRequest {
  id: string;
  method: string;
  path: string;
  body: unknown;
}
type ImportPaths = (paths: string[]) => void | Promise<void>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected JSON object");
  return value as Record<string, unknown>;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error(`${field} must be a string array`);
  return value;
}
function fileIds(body: Record<string, unknown>): string[] {
  const ids = [...new Set(strings(body.fileIds, "fileIds"))];
  if (
    !ids.length ||
    ids.some((id) => !useStore.getState().files.some((f) => f.id === id))
  )
    throw new Error("fileIds must identify existing files");
  return ids;
}
function files() {
  const state = useStore.getState();
  return state.files.map(({ payload: _payload, ...file }) => ({
    ...file,
    ...state.getDocumentState(file.id),
  }));
}

/** Every dispatch uses the live store; only native I/O goes through IPC. */
export async function dispatchAgentRequest(
  request: Omit<AgentRequest, "id">,
  importPaths: ImportPaths,
): Promise<unknown> {
  const { method, path } = request;
  const body = object(request.body);
  const state = useStore.getState();
  if (method === "GET" && path === "/v1/status")
    return {
      fileCount: state.files.length,
      activeJob: state.activeJob,
      batch: state.batchExport,
    };
  if (method === "GET" && path === "/v1/files") return { files: files() };
  if (method === "POST" && path === "/v1/files/import") {
    const paths = strings(body.paths, "paths");
    await consumePendingOpenPaths(importPaths);
    const imported = files().filter((file) => paths.includes(file.path));
    return { fileIds: imported.map((f) => f.id), files: imported };
  }
  const fileMatch = /^\/v1\/files\/([^/]+)$/.exec(path);
  if (method === "PATCH" && fileMatch) {
    const id = decodeURIComponent(fileMatch[1]!);
    if (!state.files.some((f) => f.id === id))
      throw new Error("file not found");
    for (const field of ["newspaperName", "newspaperDate"] as const) {
      if (body[field] !== undefined && typeof body[field] !== "string")
        throw new Error(`${field} must be a string`);
    }
    const tags =
      body.tags === undefined ? undefined : strings(body.tags, "tags");
    state.updateDocumentMetadata(id, {
      ...(body.newspaperName !== undefined
        ? { newspaperName: body.newspaperName as string }
        : {}),
      ...(body.newspaperDate !== undefined
        ? { newspaperDate: body.newspaperDate as string }
        : {}),
    });
    if (tags) {
      for (const tag of state.getDocumentState(id).tags)
        state.removeTagFromFiles([id], tag);
      for (const tag of tags) state.addTagToFiles([id], tag);
    }
    return files().find((f) => f.id === id);
  }
  if (method === "GET" && path === "/v1/ocr/batch")
    return { batch: state.batchExport };
  if (method === "POST" && path === "/v1/ocr/batch") {
    const result = await startBatchExport({
      fileIds: fileIds(body),
      layout: "separate",
      format: "md",
      recognizeOnly: true,
    });
    if (result.status === "error") throw new Error(result.error);
    return result;
  }
  if (method === "POST" && path === "/v1/export") {
    const ids = fileIds(body);
    if (!["separate", "merged", "by_tag"].includes(String(body.layout)))
      throw new Error("layout must be separate, merged or by_tag");
    if (!["md", "docx", "layout-pdf"].includes(String(body.format)))
      throw new Error("format must be md, docx or layout-pdf");
    if (typeof body.target !== "string" || !body.target.trim())
      throw new Error("target must be an absolute path");
    const layout = body.layout as "separate" | "merged" | "by_tag";
    if (body.format === "layout-pdf") {
      const documents = new Map(
        ids.map((id) => {
          const doc = buildLayoutDocumentFromRecognizedPages(
            state.recognizedPages[id],
          );
          if (!doc)
            throw new Error(
              `layout-pdf unavailable for ${id}: whole-page OCR with layout blocks is required; article-only/plain text OCR has no layout`,
            );
          return [id, doc] as const;
        }),
      );
      const entries = sortBatchEntries(
        ids.map((id) => batchEntry(state, planBatchFile(state, id))),
      );
      const outputs = [];
      for (const doc of planOutputDocs(layout, entries)) {
        const pages = doc.entries.flatMap(
          (entry) => documents.get(entry.fileId)!.pages,
        );
        outputs.push(
          await invoke("agent_bridge_write_export", {
            output: {
              target: body.target,
              stem: layout === "merged" ? undefined : safeFileStem(doc.stem),
              format: "layout-pdf",
              document: { source: "paddle", pages },
            },
          }),
        );
      }
      return { outputs };
    }
    const result = await startBatchExport({
      fileIds: ids,
      layout,
      format: body.format as "md" | "docx",
      target: body.target,
      exportOnly: true,
    });
    if (result.status === "error") throw new Error(result.error);
    return result;
  }
  const unitMatch = /^\/v1\/files\/([^/]+)\/units(?:\/([^/]+)\/review)?$/.exec(
    path,
  );
  if (unitMatch) {
    const id = decodeURIComponent(unitMatch[1]!);
    const file = state.files.find((f) => f.id === id);
    if (!file) throw new Error("file not found");
    const targets: ProofreadTarget[] = [
      ...Array.from(
        { length: file.kind === "pdf" ? (file.pdfTotal ?? 1) : 1 },
        (_, index) => ({ mode: "whole_file" as const, page: index + 1 }),
      ),
      ...state
        .getDocumentState(id)
        .articles.map((article) => ({
          mode: "grouped" as const,
          articleId: article.id,
        })),
    ];
    if (method === "GET" && !unitMatch[2]) {
      const plans = planProofreadImages(state, id, targets);
      const images = await invoke<
        Array<{ key: string; page: number; path: string }>
      >("agent_bridge_unit_images", {
        path: file.path,
        kind: file.kind,
        plans,
      });
      // Snapshot texts before I/O. A subsequent review must carry this baseText.
      return {
        units: targets.map((target) => ({
          key: proofreadKeyFor(target),
          text: proofreadTargetText(state, id, target),
          images: images.filter(
            (image) => image.key === proofreadKeyFor(target),
          ),
        })),
      };
    }
    if (method === "POST" && unitMatch[2]) {
      const key = decodeURIComponent(unitMatch[2]);
      const target = parseProofreadTargetKey(key);
      if (!target || !targets.some((t) => proofreadKeyFor(t) === key))
        throw new Error("unit not found");
      const text = proofreadTargetText(state, id, target);
      if (typeof body.baseText !== "string" || body.baseText !== text)
        throw new Error("stale or missing baseText: read units again");
      if (body.apply !== undefined && typeof body.apply !== "boolean")
        throw new Error("apply must be a boolean");
      if (state.proofreadReviews[id]?.[key]?.status === "applied")
        throw new Error("undo or discard the applied review in Carpo first");
      if (
        (state.activeJob?.fileId === id &&
          ["running", "cancelling"].includes(state.activeJob.status)) ||
        state.jobStartClaimFileId === id ||
        (state.batchExport &&
          ["running", "cancelling"].includes(state.batchExport.status) &&
          state.batchExport.items.some((item) => item.fileId === id))
      )
        throw new Error("file has a running task");
      if (!Array.isArray(body.suggestions))
        throw new Error("suggestions must be an array");
      const suggestions = body.suggestions.map((value) => {
        const s = object(value);
        for (const field of ["before", "after", "context_before", "reason"])
          if (typeof s[field] !== "string")
            throw new Error(`suggestion ${field} must be a string`);
        if (
          !["punct", "charform", "garble", "layout", "semantic"].includes(
            String(s.category),
          ) ||
          typeof s.confidence !== "number" ||
          !Number.isFinite(s.confidence) ||
          s.confidence < 0 ||
          s.confidence > 1
        )
          throw new Error("invalid suggestion category or confidence");
        const suggestion = s as unknown as ProofreadSuggestion;
        if (!findSuggestionSpan(text, suggestion))
          throw new Error("invalid or ambiguous suggestion anchor");
        return suggestion;
      });
      const review = buildProofreadReview(
        { key, text },
        { key, suggestions, model: "agent", discarded: 0 },
        undefined,
        Date.now(),
      )!;
      if (body.apply === true)
        review.suggestions.forEach((s) => {
          s.verdict = "accepted";
        });
      state.setProofreadReviews(id, { [key]: review });
      if (
        body.apply === true &&
        !useStore.getState().applyProofreadReview(id, key)
      )
        throw new Error("review became stale before application");
      return { review: useStore.getState().proofreadReviews[id]?.[key] };
    }
  }
  throw new Error("unknown endpoint or method");
}

export function useAgentBridge(importPaths: ImportPaths): void {
  const importer = useRef(importPaths);
  importer.current = importPaths;
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AgentRequest>("carpo://agent/request", (event) => {
      const { id, ...request } = event.payload;
      void dispatchAgentRequest(request, (paths) => importer.current(paths))
        .then(
          (data) => invoke("agent_bridge_reply", { id, ok: true, data }),
          (error: unknown) =>
            invoke("agent_bridge_reply", {
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        .catch((error) => {
          void logWarn(`agent reply failed: ${String(error)}`);
        });
    })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => {
        void logWarn(`agent listener failed: ${String(error)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
