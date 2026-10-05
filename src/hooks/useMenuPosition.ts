import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Keeps a `position: fixed` context menu fully on screen without assuming
 * a fixed height. Menus render at wildly different heights (3 items vs. a
 * full Kind + Add-to-Playlist list), so clamping against a guessed max
 * height pushes short menus far from the cursor when opened low on screen.
 *
 * Instead, this measures the menu after it paints (useLayoutEffect, so
 * there's no visible flash) and only nudges it if it would overflow:
 * flips above the cursor if it overflows the bottom, and pulls left if it
 * overflows the right.
 */
export function useMenuPosition(visible: boolean, x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number }>({ top: y, left: x });

  useLayoutEffect(() => {
    if (!visible) return;
    const el = ref.current;
    if (!el) {
      setStyle({ top: y, left: x });
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    let top = y;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, y - height);
    }
    let left = x;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, x - width);
    }
    setStyle({ top, left });
  }, [visible, x, y]);

  return { ref, style };
}
