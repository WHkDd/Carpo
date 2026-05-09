import { useStore } from "@/store";

export function Toolbar() {
  const currentFile = useStore((s) =>
    s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
  );

  if (!currentFile) return null;

  return (
    <h1 className="truncate text-[13px] font-semibold text-foreground">
      {currentFile.name}
    </h1>
  );
}
