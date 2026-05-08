import { FileText } from "lucide-react";
import { useStore } from "@/store";

export function Toolbar() {
  const currentFile = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );

  if (!currentFile) return null;

  return (
    <header className="absolute left-2 top-2 z-10 flex h-7 max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg border border-border/60 bg-background/75 px-2 text-[12px]">
      <FileText
        className="h-3.5 w-3.5 shrink-0 text-foreground-subtle"
        strokeWidth={1.5}
      />
      <span className="truncate font-semibold text-foreground">
        {currentFile.name}
      </span>
    </header>
  );
}
