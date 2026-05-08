import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { Stage, Layer, Image as KImage } from "react-konva";
import useImage from "use-image";
import { ImageOff } from "lucide-react";
import { useStore } from "@/store";
import { useElementSize } from "@/hooks/useElementSize";
import { usePanZoom, type PanZoomController } from "./usePanZoom";

export type CanvasController = PanZoomController;

export const ImageCanvas = forwardRef<CanvasController, object>(
  function ImageCanvas(_props, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { width: cw, height: ch } = useElementSize(containerRef);

    const file = useStore((s) =>
      s.currentFileId ? s.files.find((f) => f.id === s.currentFileId) ?? null : null
    );
    const payload = file?.payload ?? null;

    const dataUrl = useMemo(
      () => (payload ? `data:image/png;base64,${payload.png_base64}` : ""),
      [payload]
    );
    const [image, status] = useImage(dataUrl);

    const fitKey = useMemo(() => {
      if (!file || !payload) return null;
      return `${file.id}::${payload.width}x${payload.height}::${cw}x${ch}`;
    }, [file, payload, cw, ch]);

    const { pan, scale, onWheel, onDragEnd, controller } = usePanZoom({
      containerWidth: cw,
      containerHeight: ch,
      imageWidth: payload?.width ?? null,
      imageHeight: payload?.height ?? null,
      fitKey,
    });

    useImperativeHandle(ref, () => controller, [controller]);

    const isReady = !!image && status === "loaded" && cw > 0 && ch > 0;
    const showEmpty = !file;

    return (
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
      >
        {cw > 0 && ch > 0 && (
          <Stage
            width={cw}
            height={ch}
            x={pan.x}
            y={pan.y}
            scaleX={scale}
            scaleY={scale}
            draggable={isReady}
            onWheel={onWheel}
            onDragEnd={onDragEnd}
          >
            <Layer listening={false}>
              {isReady && <KImage image={image} />}
            </Layer>
          </Stage>
        )}

        {showEmpty && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3 text-foreground-subtle">
              <ImageOff className="h-9 w-9 opacity-60" strokeWidth={1.4} />
              <div className="text-sm">将扫描件拖入此处，或使用顶栏「添加文件」</div>
              <div className="font-mono text-xs">
                支持 PNG · JPG · TIFF · BMP
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);
