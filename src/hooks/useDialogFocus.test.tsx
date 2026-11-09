import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

function Harness({ withAutoFocus = false }: { withAutoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useDialogFocus(open);
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      <button>outside</button>
      {open && (
        <div ref={ref} role="dialog" aria-modal="true" aria-label="Test">
          <button>first</button>
          <input aria-label="field" autoFocus={withAutoFocus} />
          <button onClick={() => setOpen(false)}>last</button>
        </div>
      )}
    </>
  );
}

const open = () => fireEvent.click(screen.getByText("opener"));

describe("useDialogFocus", () => {
  it("moves focus to the first control when the dialog opens", () => {
    render(<Harness />);
    screen.getByText("opener").focus();
    open();
    expect(screen.getByText("first")).toHaveFocus();
  });

  it("leaves focus alone when something inside already has it", () => {
    render(<Harness withAutoFocus />);
    open();
    expect(screen.getByLabelText("field")).toHaveFocus();
  });

  it("wraps Tab and Shift+Tab inside the dialog", () => {
    render(<Harness />);
    open();
    screen.getByText("last").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByText("first")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByText("last")).toHaveFocus();
  });

  it("pulls focus back in if it somehow left the dialog", () => {
    render(<Harness />);
    open();
    screen.getByText("outside").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByText("first")).toHaveFocus();
  });

  it("returns focus to the opener on close", () => {
    render(<Harness />);
    const opener = screen.getByText("opener");
    opener.focus();
    open();
    fireEvent.click(screen.getByText("last"));
    expect(opener).toHaveFocus();
  });
});

const outerFocused = vi.fn();

function Stacked() {
  const [inner, setInner] = useState(false);
  const outerRef = useDialogFocus(true);
  const innerRef = useDialogFocus(inner);
  return (
    <>
      <div ref={outerRef} role="dialog" aria-label="Outer">
        <button onFocus={outerFocused} onClick={() => setInner(true)}>open-inner</button>
        <button onFocus={outerFocused}>outer-last</button>
      </div>
      {inner && (
        <div ref={innerRef} role="dialog" aria-label="Inner">
          <button>inner-first</button>
          <button>inner-last</button>
        </div>
      )}
    </>
  );
}

describe("useDialogFocus stacking", () => {
  it("lets only the topmost dialog handle Tab", () => {
    render(<Stacked />);
    fireEvent.click(screen.getByText("open-inner"));
    expect(screen.getByText("inner-first")).toHaveFocus();
    outerFocused.mockClear();
    screen.getByText("inner-first").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    // The outer trap must not yank focus back out of the inner dialog.
    expect(screen.getByText("inner-first")).toHaveFocus();
    screen.getByText("inner-last").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByText("inner-first")).toHaveFocus();
    expect(outerFocused).not.toHaveBeenCalled();
  });
});
