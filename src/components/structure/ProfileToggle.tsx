import { useStore } from "@/store";

export function ProfileToggle() {
  const ocrProfile = useStore((s) => s.ocrProfile);
  const setOcrProfile = useStore((s) => s.setOcrProfile);

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium text-foreground-subtle">OCR</span>
      <div className="inline-flex h-7 items-center rounded-lg border border-border/60 bg-surface-2 p-0.5">
        {(["standard", "fast"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setOcrProfile(p)}
            className={`h-6 rounded-md px-2.5 text-[11px] font-medium transition-colors ${
              ocrProfile === p
                ? "bg-background text-foreground shadow-sm"
                : "text-foreground-subtle hover:text-foreground"
            }`}
          >
            {p === "standard" ? "标准" : "快速"}
          </button>
        ))}
      </div>
    </div>
  );
}
