import Konva from "konva";
import type { Node } from "konva/lib/Node";

const activeTweens = new WeakMap<Node, Konva.Tween>();

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function easeOutQuart(t: number, _b: number, c: number, d: number): number {
  t /= d;
  t--;
  return -c * (t * t * t * t - 1);
}

function setFill(node: Node, target: string): void {
  (node as unknown as { fill: (c: string) => void }).fill(target);
}

/** Animate node.fill to target as a 120 ms ease-out-quart tween. */
export function tweenFill(node: Node, target: string): void {
  const old = activeTweens.get(node);
  if (old) old.destroy();

  if (prefersReducedMotion() || target.startsWith("hsl(")) {
    setFill(node, target);
    return;
  }

  const tween = new Konva.Tween({
    node,
    duration: 0.12,
    fill: target,
    easing: easeOutQuart,
  });
  activeTweens.set(node, tween);
  tween.play();
}
