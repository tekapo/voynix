import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getArtistCover = vi.fn(async (_artist: string) => null as string | null);
vi.mock("../db", () => ({ getArtistCover: (...a: [string]) => getArtistCover(...a) }));

import { invalidateArtistArt } from "../artistArt";
import { initialOf, placeholderHue, TrackCover } from "./CoverArt";

beforeEach(() => {
    getArtistCover.mockReset().mockResolvedValue(null);
    invalidateArtistArt();
});

describe("TrackCover", () => {
    it("shows the cover when there is one, without asking for the artist image", () => {
        render(<TrackCover track={{ artist: "Ann", title: "T" }} artUrl="data:cover" className="c" alt="cover" />);
        expect(screen.getByAltText("cover")).toHaveAttribute("src", "data:cover");
        expect(getArtistCover).not.toHaveBeenCalled();
    });

    it("falls back to the artist's image when there is no cover", async () => {
        getArtistCover.mockResolvedValue("data:artist");
        render(<TrackCover track={{ artist: "Ann", title: "T" }} artUrl={null} className="c" alt="cover" />);
        await waitFor(() => expect(screen.getByAltText("cover")).toHaveAttribute("src", "data:artist"));
    });

    it("falls back to the artist's initial when neither image exists", async () => {
        render(<TrackCover track={{ artist: "ann", title: "Zed" }} artUrl={null} className="c" />);
        await waitFor(() => expect(getArtistCover).toHaveBeenCalledWith("ann"));
        expect(screen.getByText("A")).toHaveClass("c", "library-thumb-placeholder");
    });

    it("uses the title's initial when the track has no artist", () => {
        render(<TrackCover track={{ title: "Zed" }} artUrl={null} className="c" />);
        expect(screen.getByText("Z")).toBeInTheDocument();
        expect(getArtistCover).not.toHaveBeenCalled();
    });
});

describe("placeholder helpers", () => {
    it("derives a stable hue and an upper-case initial", () => {
        expect(placeholderHue("Ann")).toBe(placeholderHue("Ann"));
        expect(placeholderHue("Ann")).toBeGreaterThanOrEqual(0);
        expect(placeholderHue("Ann")).toBeLessThan(360);
        expect(initialOf("  bob")).toBe("B");
        expect(initialOf("")).toBe("?");
    });
});
