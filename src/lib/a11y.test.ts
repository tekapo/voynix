import { describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { activatable } from "./a11y";

function key(k: string, target: object = {}, currentTarget: object = target) {
  const e = { key: k, target, currentTarget, preventDefault: vi.fn() };
  return e as unknown as KeyboardEvent<HTMLElement> & { preventDefault: ReturnType<typeof vi.fn> };
}

describe("activatable", () => {
  it("presents the element as a focusable button", () => {
    const p = activatable(() => {});
    expect(p.role).toBe("button");
    expect(p.tabIndex).toBe(0);
  });

  it("activates on click, Enter and Space", () => {
    const fn = vi.fn();
    const p = activatable(fn);
    p.onClick();
    const enter = key("Enter");
    p.onKeyDown(enter);
    p.onKeyDown(key(" "));
    expect(fn).toHaveBeenCalledTimes(3);
    expect(enter.preventDefault).toHaveBeenCalled();
  });

  it("ignores other keys", () => {
    const fn = vi.fn();
    activatable(fn).onKeyDown(key("a"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("ignores keys that come from a nested control", () => {
    const fn = vi.fn();
    activatable(fn).onKeyDown(key("Enter", {}, {}));
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs the separate key action for the keyboard only", () => {
    const click = vi.fn();
    const keyAction = vi.fn();
    const p = activatable(click, keyAction);
    p.onClick();
    p.onKeyDown(key("Enter"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(keyAction).toHaveBeenCalledTimes(1);
  });
});
