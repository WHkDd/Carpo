import { describe, expect, it, beforeEach } from "vitest";
import {
  clearPendingJob,
  loadPendingJob,
  savePendingJob,
} from "@/lib/job-persistence";
import type { StartJobInfo } from "@/store/jobSlice";

const info: StartJobInfo = {
  jobId: "job-1",
  kind: "whole_file",
  fileId: "file-1",
  newspaperName: "申报",
  newspaperDate: "1936-01-01",
  requestedPages: [1, 2, 3],
};

// This suite runs under vitest's default `node` environment (no jsdom), so
// `sessionStorage` isn't a global here — stand in a minimal in-memory
// implementation rather than pulling jsdom in for the whole project.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

(globalThis as { sessionStorage?: Storage }).sessionStorage = new MemoryStorage();

describe("job-persistence", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("round-trips a saved job", () => {
    savePendingJob(info);
    expect(loadPendingJob()).toEqual(info);
  });

  it("returns null when nothing is saved", () => {
    expect(loadPendingJob()).toBeNull();
  });

  it("clears the saved job", () => {
    savePendingJob(info);
    clearPendingJob();
    expect(loadPendingJob()).toBeNull();
  });

  it("returns null for corrupt stored JSON instead of throwing", () => {
    sessionStorage.setItem("carpo:pendingJob", "{not json");
    expect(loadPendingJob()).toBeNull();
  });
});
