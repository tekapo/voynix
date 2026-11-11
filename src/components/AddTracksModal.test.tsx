import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ADD_TRACKS_ROW_LIMIT, AddTracksModal } from "./AddTracksModal";
import { Track } from "../types";

function track(id: string, title: string, artist = "Artist A"): Track {
    return {
        id, title, artist, album: "Album A",
        file_path: `/music/${id}.mp3`, file_name: `${id}.mp3`,
        duration: 180, disc_no: 1, track_no: 1,
    };
}

const library = [track("1", "Alpha"), track("2", "Bravo", "Artist B"), track("3", "Charlie")];

const open = (over: Partial<React.ComponentProps<typeof AddTracksModal>> = {}) => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    render(<AddTracksModal isOpen tracks={library} onAdd={onAdd} onClose={onClose} {...over} />);
    return { onAdd, onClose };
};

describe("AddTracksModal", () => {
    it("renders nothing while closed", () => {
        render(<AddTracksModal isOpen={false} tracks={library} onAdd={() => {}} onClose={() => {}} />);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("keeps Add disabled until a song is ticked, then adds the ticked songs in library order", () => {
        const { onAdd } = open();
        const add = screen.getByRole("button", { name: "Add" });
        expect(add).toBeDisabled();
        fireEvent.click(screen.getByRole("checkbox", { name: /Charlie/ }));
        fireEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
        fireEvent.click(screen.getByRole("button", { name: "Add 2 songs" }));
        expect(onAdd).toHaveBeenCalledWith([library[0], library[2]]);
    });

    it("narrows the list by the search box but keeps earlier ticks", () => {
        const { onAdd } = open();
        fireEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bravo" } });
        expect(screen.queryByRole("checkbox", { name: /Alpha/ })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("checkbox", { name: /Bravo/ }));
        fireEvent.click(screen.getByRole("button", { name: "Add 2 songs" }));
        expect(onAdd).toHaveBeenCalledWith([library[0], library[1]]);
    });

    it("says so when nothing matches", () => {
        open();
        fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
        expect(screen.getByText("No songs found.")).toBeInTheDocument();
    });

    it("draws only the first rows of a big library and says how many there are", () => {
        const many = Array.from({ length: ADD_TRACKS_ROW_LIMIT + 5 }, (_, i) => track(`m${i}`, `Song ${i}`));
        open({ tracks: many });
        expect(screen.getAllByRole("checkbox")).toHaveLength(ADD_TRACKS_ROW_LIMIT);
        expect(screen.getByText(`Showing ${ADD_TRACKS_ROW_LIMIT} of ${ADD_TRACKS_ROW_LIMIT + 5} songs. Search to narrow them down.`)).toBeInTheDocument();
    });

    it("closes on Cancel and on Escape without adding", () => {
        const { onAdd, onClose } = open();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(onAdd).not.toHaveBeenCalled();
    });

    it("starts clean each time it opens", () => {
        const { rerender } = render(<AddTracksModal isOpen tracks={library} onAdd={() => {}} onClose={() => {}} />);
        fireEvent.click(screen.getByRole("checkbox", { name: /Alpha/ }));
        rerender(<AddTracksModal isOpen={false} tracks={library} onAdd={() => {}} onClose={() => {}} />);
        rerender(<AddTracksModal isOpen tracks={library} onAdd={() => {}} onClose={() => {}} />);
        expect(screen.getByRole("checkbox", { name: /Alpha/ })).not.toBeChecked();
    });
});
