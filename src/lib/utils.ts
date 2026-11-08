import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Selected row in a gray side list (scan queue, settings rail): lifts off the
 *  rail as a white card, so it never reads as the gray hover state. */
export const ACTIVE_ROW =
  "bg-white text-foreground shadow-[0_0_0_1px_hsl(var(--border)/0.75),0_1px_3px_rgb(0_0_0/0.07)]";
