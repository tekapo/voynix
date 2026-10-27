import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateModal } from "./UpdateModal";
import type { SelfUpdate } from "../hooks/useUpdater";

function make(over: Partial<SelfUpdate> = {}): SelfUpdate {
    return {
        status: { kind: "available", version: "1.2.3", notes: "Fixes" },
        dialogOpen: true,
        checkNow: () => {},
        install: () => {},
        dismiss: () => {},
        ...over,
    };
}

describe("UpdateModal", () => {
    it("offers the update and lets the user install or defer", () => {
        const install = vi.fn();
        const dismiss = vi.fn();
        render(<UpdateModal updater={make({ install, dismiss })} />);
        expect(screen.getByText("Voynix 1.2.3 is available")).toBeTruthy();
        fireEvent.click(screen.getByText("Update and Restart"));
        fireEvent.click(screen.getByText("Later"));
        expect(install).toHaveBeenCalled();
        expect(dismiss).toHaveBeenCalled();
    });

    it("shows download progress and blocks dismissal", () => {
        render(<UpdateModal updater={make({ status: { kind: "downloading", version: "1.2.3", done: 50, total: 200 } })} />);
        expect(screen.getByText("Downloading… 25%")).toBeTruthy();
        expect((screen.getByText("Later") as HTMLButtonElement).disabled).toBe(true);
    });

    it("renders nothing when closed", () => {
        const { container } = render(<UpdateModal updater={make({ dialogOpen: false })} />);
        expect(container.textContent).toBe("");
    });
});
