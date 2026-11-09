import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => !el.closest("[hidden]"));
}

/** Open dialogs, oldest first. Only the last one may trap Tab, so a dialog opened on top of another doesn't fight it. */
const openDialogs: HTMLElement[] = [];

/**
 * Focus handling for a modal dialog: puts focus inside when it opens (unless
 * something in it — an `autoFocus` field — already has it), keeps Tab and
 * Shift+Tab cycling within the dialog, and gives focus back to whatever had it
 * before when the dialog closes. Attach the returned ref to the dialog's root
 * (the `.modal-content`). Pass `active=false` while the dialog is not shown.
 */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(active = true) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const opener = document.activeElement as HTMLElement | null;

    if (!root.contains(document.activeElement)) {
      // The dialog itself takes focus when it has nothing focusable yet.
      if (!root.hasAttribute("tabindex")) root.tabIndex = -1;
      (focusables(root)[0] ?? root).focus({ preventScroll: true });
    }

    openDialogs.push(root);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || openDialogs[openDialogs.length - 1] !== root) return;
      const items = focusables(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!root.contains(current)) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      } else if (e.shiftKey && (current === first || current === root)) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const at = openDialogs.lastIndexOf(root);
      if (at >= 0) openDialogs.splice(at, 1);
      const now = document.activeElement;
      // Hand focus back unless the user already put it somewhere else.
      if (opener?.isConnected && (!now || now === document.body || root.contains(now))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [active]);

  return ref;
}
