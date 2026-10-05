import { useEffect, useRef } from "react";

interface KeyboardShortcutActions {
  togglePlay: () => void;
  /** Regular track navigation (skip button unavailable, e.g. music). */
  playNext: () => void;
  playPrevious: () => void;
  /** ±N seconds — used instead of prev/next while a podcast episode is loaded. */
  skip: (deltaSeconds: number) => void;
  isPodcast: boolean;
}

const isEditable = (el: EventTarget | null) => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
};

/**
 * Global desktop shortcuts: Space (play/pause), ←/→ (prev/next track, or
 * ±10s while a podcast episode is playing), ⌘F (focus search), Esc (blur
 * whatever's focused — mainly the search field).
 *
 * Ignored while typing in an input/textarea/select so Space still types a
 * space in the search box, etc. `actions` is read through a ref so the
 * effect only needs to attach the listener once.
 */
export function useKeyboardShortcuts(actions: KeyboardShortcutActions) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("global-search-input")?.focus();
        return;
      }

      if (isEditable(e.target)) {
        if (e.key === "Escape") (e.target as HTMLElement).blur();
        return;
      }

      // Ignore other modifier combos (e.g. ⌘R) so we don't steal them.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const { togglePlay, playNext, playPrevious, skip, isPodcast } = actionsRef.current;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          if (isPodcast) skip(10); else playNext();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (isPodcast) skip(-10); else playPrevious();
          break;
        case "Escape":
          (document.activeElement as HTMLElement | null)?.blur();
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
