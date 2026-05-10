import { memo, useMemo } from "react";
import { Group, Rect, Text } from "react-konva";

function readHslVar(name: string): string {
  if (typeof document === "undefined") return "";
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw ? `hsl(${raw})` : "";
}

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

  const bgFill = useMemo(
    () => readHslVar("--primary") || "#262626",
    [colorVersion]
  );
  const textFill = useMemo(
    () => readHslVar("--primary-foreground") || "#f7f7f5",
    [colorVersion]
  );

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
