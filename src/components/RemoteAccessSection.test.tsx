import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RemoteAccessSection } from "./RemoteAccessSection";
import type { RemoteAccess } from "../hooks/useRemoteServer";

function makeRemote(over: Partial<RemoteAccess> = {}): RemoteAccess {
    return {
        enabled: false,
        status: null,
        port: 8443,
        certPath: "",
        keyPath: "",
        revealSecret: vi.fn(async () => "sec-abc"),
        setEnabled: vi.fn(),
        changePort: vi.fn(),
        changeCertPaths: vi.fn(),
        regenerateSecret: vi.fn(async () => {}),
        playlistSlotJson: vi.fn(() => '{"name":"PLAYLIST"}'),
        ...over,
    };
}

describe("RemoteAccessSection", () => {
    it("is off by default and enabling goes through setEnabled", () => {
        const remote = makeRemote();
        render(<RemoteAccessSection remote={remote} />);
        const toggle = screen.getByRole("checkbox", { name: /Enable Echo playback/ });
        expect(toggle).not.toBeChecked();
        expect(screen.getByText("Not running.")).toBeInTheDocument();
        fireEvent.click(toggle);
        expect(remote.setEnabled).toHaveBeenCalledWith(true);
    });

    it("keeps the secret hidden until asked, and hides it again", async () => {
        const remote = makeRemote();
        render(<RemoteAccessSection remote={remote} />);
        expect(screen.queryByText("sec-abc")).toBeNull();
        expect(remote.revealSecret).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Show" }));
        expect(await screen.findByText("sec-abc")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Hide" }));
        await waitFor(() => expect(screen.queryByText("sec-abc")).toBeNull());
    });

    it("regenerating clears a revealed secret", async () => {
        const remote = makeRemote();
        render(<RemoteAccessSection remote={remote} />);
        fireEvent.click(screen.getByRole("button", { name: "Show" }));
        await screen.findByText("sec-abc");

        fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
        await waitFor(() => expect(screen.queryByText("sec-abc")).toBeNull());
        expect(remote.regenerateSecret).toHaveBeenCalled();
    });

    it("applies a changed port on blur and ignores an invalid one", () => {
        const remote = makeRemote();
        render(<RemoteAccessSection remote={remote} />);

        const port = screen.getByLabelText(/^Port/);
        fireEvent.change(port, { target: { value: "9000" } });
        fireEvent.blur(port);
        expect(remote.changePort).toHaveBeenCalledWith(9000);

        fireEvent.change(port, { target: { value: "99999" } });
        fireEvent.blur(port);
        expect(remote.changePort).toHaveBeenCalledTimes(1);
        expect(port).toHaveValue(8443);
    });

    it("applies the certificate and key paths together, with an explicit Apply", () => {
        const remote = makeRemote({ certPath: "/c/fullchain.pem", keyPath: "/c/privkey.pem" });
        render(<RemoteAccessSection remote={remote} />);

        const apply = screen.getByRole("button", { name: "Apply" });
        expect(apply).toBeDisabled();

        const cert = screen.getByLabelText(/Certificate file/);
        fireEvent.change(cert, { target: { value: "/new/fullchain.pem" } });
        fireEvent.blur(cert);
        expect(remote.changeCertPaths).not.toHaveBeenCalled();

        const key = screen.getByLabelText(/Private key file/);
        fireEvent.change(key, { target: { value: "/new/privkey.pem" } });
        expect(apply).toBeEnabled();
        fireEvent.click(apply);
        expect(remote.changeCertPaths).toHaveBeenCalledTimes(1);
        expect(remote.changeCertPaths).toHaveBeenCalledWith("/new/fullchain.pem", "/new/privkey.pem");
    });

    it("copies the playlist slot type for the skill model", async () => {
        const write = vi.fn(async () => {});
        Object.assign(navigator, { clipboard: { writeText: write } });
        const remote = makeRemote();
        render(<RemoteAccessSection remote={remote} />);
        fireEvent.click(screen.getByRole("button", { name: "Copy playlist names" }));
        await waitFor(() => expect(write).toHaveBeenCalledWith('{"name":"PLAYLIST"}'));
        expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("shows the port when running", () => {
        render(<RemoteAccessSection remote={makeRemote({
            enabled: true,
            status: { running: true, port: 8443, transcode_available: true },
        })} />);
        expect(screen.getByText("Running on port 8443")).toBeInTheDocument();
    });
});
