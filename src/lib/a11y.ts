import type { KeyboardEvent } from "react";

/**
 * Props that make a non-<button> element (typically an <li> row) behave like a
 * button for the keyboard and for screen readers: it takes Tab focus, announces
 * as a button, and Enter / Space activate it like a click. `onKey` overrides what
 * the keys do when that differs from a click (e.g. a row where click selects and
 * double-click plays: Enter should play).
 */
export function activatable(onActivate: () => void, onKey: () => void = onActivate) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      // A key pressed inside a nested control (a button, an input) is that control's.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onKey();
      }
    },
  };
}
