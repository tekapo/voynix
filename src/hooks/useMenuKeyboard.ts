import { useEffect, type KeyboardEvent, type RefObject } from "react";

// Items opt in with role="menuitem"; disabled ones carry the `disabled` class.
const ENABLED_ITEM = '[role="menuitem"]:not(.disabled)';

/**
 * Keyboard behaviour for a context menu (WAI-ARIA menu pattern): focus moves
 * to the first enabled item when it opens, ↑/↓/Home/End move between items,
 * Enter/Space run the focused one, Escape or Tab close it, and focus goes back
 * to where it was. Spread the result on the menu's root element.
 */
export function useMenuKeyboard(ref: RefObject<HTMLElement | null>, visible: boolean, onClose: () => void) {
  useEffect(() => {
    if (!visible) return;
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(ENABLED_ITEM)?.focus({ preventScroll: true });
    return () => {
      // Only hand focus back if nothing else took it (a click elsewhere
      // already moved it, and that must win).
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [ref, visible]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(ENABLED_ITEM) ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => {
      e.preventDefault();
      e.stopPropagation();
      if (items.length > 0) items[(i + items.length) % items.length].focus({ preventScroll: true });
    };
    switch (e.key) {
      case "ArrowDown": focusAt(current + 1); break;
      case "ArrowUp": focusAt(current < 0 ? -1 : current - 1); break;
      case "Home": focusAt(0); break;
      case "End": focusAt(-1); break;
      case "Enter":
      case " ":
        // Stop here so Space doesn't also reach the global play/pause shortcut.
        e.preventDefault();
        e.stopPropagation();
        if (current >= 0) items[current].click();
        break;
      case "Escape":
      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
    }
  };

  return { role: "menu" as const, onKeyDown };
}
