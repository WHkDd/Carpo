import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the light theme's contrast against WCAG 2.1 §1.4.3 (4.5:1 for body
 * text) and §1.4.11 (3:1 for meaningful non-text).
 *
 * This exists because the failure mode is invisible to everyone who can
 * already read the screen. `--foreground-subtle` shipped at 2.98:1 for a long
 * time carrying file extensions, block counts and page numbers at 10-12px;
 * nobody noticed, because nothing looks broken — it just cannot be read by
 * someone whose eyes are older or whose screen is in daylight. A number in a
 * test is the only thing that stays honest here.
 *
 * The pairs below are the ones that actually occur in the UI. `--surface-2`
 * is included for every text token because it is the hovered/selected row
 * background, and it is always the tighter of the two.
 */

const css = readFileSync(
  fileURLToPath(new URL("./globals.css", import.meta.url)),
  "utf8"
);

/** Reads an `--x: H S% L%` triple out of the `:root` block. */
function token(name: string): [number, number, number] {
  const match = css.match(
    new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`)
  );
  if (!match) throw new Error(`token --${name} not found in globals.css`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

type Rgb = [number, number, number];

function hslToRgb([h, s, l]: [number, number, number]): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = light - c / 2;
  const table: Rgb[] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = table[Math.floor(hp) % 6]!;
  return [r + m, g + m, b + m];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (v: number) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x
  ) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Flattens `color` at `alpha` over `backdrop`, the way a browser composites
 *  a `/70`-style Tailwind opacity modifier. */
function over(color: Rgb, backdrop: Rgb, alpha: number): Rgb {
  return color.map((c, i) => alpha * c + (1 - alpha) * backdrop[i]!) as Rgb;
}

const background = hslToRgb(token("background"));
const surface2 = hslToRgb(token("surface-2"));

describe("light theme contrast", () => {
  const text: Array<[string, string]> = [
    ["foreground", "body text"],
    ["foreground-muted", "secondary labels"],
    ["foreground-subtle", "file extensions, block counts, page badges"],
    ["destructive", "errors"],
    ["success", "the configured-provider badge"],
    ["warning", "the page-mismatch notice"],
  ];

  it.each(text)("%s meets AA on --background (%s)", (name) => {
    expect(contrast(hslToRgb(token(name)), background)).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it.each(text)("%s meets AA on --surface-2 (%s)", (name) => {
    // surface-2 is the hover/selection background, so every text token lands
    // on it somewhere. It is darker than --background, so it always binds.
    expect(contrast(hslToRgb(token(name)), surface2)).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it("keeps warning readable on its own 10% tint", () => {
    // PaddleJsonImportDialog renders `text-warning` on `bg-warning/10`, which
    // is a much tighter pairing than warning-on-white.
    const warning = hslToRgb(token("warning"));
    expect(contrast(warning, over(warning, background, 0.1))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps placeholders legible without letting them read as real values", () => {
    // Deliberately below the body-text bar: a placeholder that looks like an
    // entered value is its own bug. 3:1 is the floor, 4.5:1 the ceiling.
    const ratio = contrast(hslToRgb(token("foreground-placeholder")), background);
    expect(ratio).toBeGreaterThanOrEqual(3);
    expect(ratio).toBeLessThan(4.5);
  });

  it("keeps the unconfigured-provider dot visible as a non-text indicator", () => {
    // SettingsDialog: `bg-foreground-subtle/80` on a 6px dot. §1.4.11 → 3:1.
    const dot = over(hslToRgb(token("foreground-subtle")), background, 0.8);
    expect(contrast(dot, background)).toBeGreaterThanOrEqual(3);
  });

  it("has no opacity-modified foreground-subtle left outside disabled states", () => {
    // Darkening the base token cannot rescue a `/50` or `/70`; those had to
    // become their own tokens. The two survivors are the disabled page-jump
    // arrows, which WCAG exempts. If this count grows, the new site either
    // needs a token or needs to justify itself here.
    const root = fileURLToPath(new URL("../components", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".tsx") ? [full] : [];
      });

    const offenders = walk(root).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/foreground-subtle\/\d+/g)].map(
        (m) => `${relative(root, file)}: ${m[0]}`
      )
    );

    expect(offenders.sort()).toEqual([
      "layout/PageJumpControl.tsx: foreground-subtle/40",
      "layout/PageJumpControl.tsx: foreground-subtle/40",
      "settings/SettingsDialog.tsx: foreground-subtle/80",
    ]);
  });
});
