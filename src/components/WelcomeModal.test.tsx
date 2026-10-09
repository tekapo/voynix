import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WelcomeModal } from "./WelcomeModal";

const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

function makeProps(over: Partial<React.ComponentProps<typeof WelcomeModal>> = {}) {
    return {
        isOpen: true,
        onClose: vi.fn(),
        hasFolders: false,
        isScanning: false,
        onAddFolder: vi.fn(),
        onOpenSync: vi.fn(),
        ...over,
    };
}

describe("WelcomeModal", () => {
    it("renders nothing when closed", () => {
        render(<WelcomeModal {...makeProps({ isOpen: false })} />);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("steps through intro → add folder → sync with Back", () => {
        render(<WelcomeModal {...makeProps()} />);
        expect(screen.getByRole("dialog", { name: "Welcome to Voynix" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("heading", { name: "Add your music" })).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("heading", { name: "Sync with Android" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(screen.getByRole("heading", { name: "Add your music" })).toBeInTheDocument();
    });

    it("add-folder step calls onAddFolder and shows scan state", () => {
        const props = makeProps();
        const { rerender } = render(<WelcomeModal {...props} />);
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        fireEvent.click(screen.getByRole("button", { name: "Add Music Folder…" }));
        expect(props.onAddFolder).toHaveBeenCalledTimes(1);

        rerender(<WelcomeModal {...props} isScanning scanProgress={{ done: 3, total: 10 }} />);
        expect(screen.getByRole("button", { name: "Add Music Folder…" })).toBeDisabled();
        expect(screen.getByText("Scanning… 3 / 10")).toBeInTheDocument();

        rerender(<WelcomeModal {...props} hasFolders />);
        expect(screen.getByText(/Folder added/)).toBeInTheDocument();
    });

    it("sync step opens the sync dialog and the manual", () => {
        const props = makeProps();
        render(<WelcomeModal {...props} />);
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        fireEvent.click(screen.getByRole("button", { name: "Open Wi-Fi Sync" }));
        expect(props.onOpenSync).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "User manual" }));
        expect(openUrl).toHaveBeenCalledWith("https://tekapo.github.io/voynix/en/");
    });

    it("Skip and Escape close the dialog", () => {
        const props = makeProps();
        render(<WelcomeModal {...props} />);
        fireEvent.click(screen.getByRole("button", { name: "Skip" }));
        expect(props.onClose).toHaveBeenCalledTimes(1);

        fireEvent.keyDown(window, { key: "Escape" });
        expect(props.onClose).toHaveBeenCalledTimes(2);
    });
});
