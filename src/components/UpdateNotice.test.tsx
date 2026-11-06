import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateNotice } from "./UpdateNotice";
import type { SelfUpdate } from "../hooks/useUpdater";

function make(over: Partial<SelfUpdate> = {}): SelfUpdate {
    return {
        status: { kind: "available", version: "1.2.3", notes: "" },
        dialogOpen: false,
        noticeDismissed: false,
        checkNow: () => {},
        install: () => {},
        dismiss: () => {},
        openDialog: () => {},
        dismissNotice: () => {},
        ...over,
    };
}

describe("UpdateNotice", () => {
    it("shows the version and opens the dialog on click", () => {
        const openDialog = vi.fn();
        render(<UpdateNotice updater={make({ openDialog })} />);
        fireEvent.click(screen.getByText("Voynix 1.2.3 available"));
        expect(openDialog).toHaveBeenCalled();
    });

    it("can be dismissed with the × button", () => {
        const dismissNotice = vi.fn();
        render(<UpdateNotice updater={make({ dismissNotice })} />);
        fireEvent.click(screen.getByLabelText("Dismiss"));
        expect(dismissNotice).toHaveBeenCalled();
    });

    it("shows nothing when idle or dismissed", () => {
        const idle = render(<UpdateNotice updater={make({ status: { kind: "idle" } })} />);
        expect(idle.container.textContent).toBe("");
        idle.unmount();
        const dismissed = render(<UpdateNotice updater={make({ noticeDismissed: true })} />);
        expect(dismissed.container.textContent).toBe("");
    });
});
