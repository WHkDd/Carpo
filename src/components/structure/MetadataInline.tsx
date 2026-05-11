import { useCallback } from "react";
import { useStore } from "@/store";

export function MetadataInline() {
  const fileId = useStore((s) => s.currentFileId) ?? "";
  const docState = useStore((s) => s.getDocumentState(fileId));
  const updateDocumentMetadata = useStore((s) => s.updateDocumentMetadata);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateDocumentMetadata(fileId, { newspaperName: e.target.value });
    },
    [fileId, updateDocumentMetadata]
  );

  const handleDateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateDocumentMetadata(fileId, { newspaperDate: e.target.value });
    },
    [fileId, updateDocumentMetadata]
  );

  if (!fileId) return null;

  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <label className="mb-1 block text-[11px] font-medium text-foreground-subtle">
          报刊名
        </label>
        <input
          type="text"
          value={docState.newspaperName}
          onChange={handleNameChange}
          placeholder="—"
          className="h-7 w-full rounded-md border border-border/60 bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtle/50 focus:border-border-strong"
        />
      </div>
      <div>
        <label className="mb-1 block text-[11px] font-medium text-foreground-subtle">
          日期
        </label>
        <input
          type="text"
          value={docState.newspaperDate}
          onChange={handleDateChange}
          placeholder="—"
          className="h-7 w-full rounded-md border border-border/60 bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtle/50 focus:border-border-strong"
        />
      </div>
    </div>
  );
}
