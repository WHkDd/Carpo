import { memo, useMemo } from "react";
import { Group, Rect, Text } from "react-konva";
import { cssHsl } from "@/lib/article-color-token";

export interface SelectionOrderLabelProps {
  x: number;
  y: number;
  order: number;
  colorVersion: number;
}

function SelectionOrderLabelImpl({ x, y, order, colorVersion }: SelectionOrderLabelProps) {
  const PAD = 4;
  const FONT_SIZE = 11;
  const MIN_W = 18;
  const H = 18;
  const text = String(order);
  // Approximate width: each digit ~7px at 11px font + 8px padding
  const textW = Math.max(MIN_W, text.length * 7 + 8);

  // `colorVersion` is referenced only to re-run the memo after a theme change;
  // the token cache was already cleared by the same event.
  const bgFill = useMemo(() => {
    void colorVersion;
    return cssHsl("--primary", 1, "0 0% 15%");
  }, [colorVersion]);
  const textFill = useMemo(() => {
    void colorVersion;
    return cssHsl("--primary-foreground", 1, "60 3% 97%");
  }, [colorVersion]);

  return (
    <Group x={x + PAD} y={y + PAD} listening={false}>
      <Rect
        width={textW}
        height={H}
        fill={bgFill}
        cornerRadius={3}
        listening={false}
      />
      <Text
        text={text}
        width={textW}
        height={H}
        align="center"
        verticalAlign="middle"
        fontSize={FONT_SIZE}
        fontFamily='"PingFang SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,sans-serif'
        fill={textFill}
        listening={false}
      />
    </Group>
  );
}

export const SelectionOrderLabel = memo(SelectionOrderLabelImpl);
