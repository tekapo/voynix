import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { formatDuration, isPlayedPodcast, podcastBadge, podcastDurationText } from "./trackFormat";
import { Track } from "../types";

const track = (over: Partial<Track> = {}): Track => ({
    id: "t1",
    title: "Ep",
    file_path: "/p/ep.mp3",
    file_name: "ep.mp3",
    ...over,
});

describe("formatDuration", () => {
    it("formats seconds as m:ss, zero-padded", () => {
        expect(formatDuration(65)).toBe("1:05");
        expect(formatDuration(600)).toBe("10:00");
        expect(formatDuration(5)).toBe("0:05");
    });

    it("falls back to the placeholder for 0/undefined", () => {
        expect(formatDuration(undefined)).toBe("--:--");
        expect(formatDuration(0)).toBe("--:--");
        expect(formatDuration(0, "?")).toBe("?");
    });

    it("switches to h:mm:ss past an hour, e.g. a long podcast episode", () => {
        expect(formatDuration(2 * 3600)).toBe("2:00:00");
    });
});

describe("isPlayedPodcast", () => {
    it("true only for a podcast whose play_state is 'played'", () => {
        expect(isPlayedPodcast(track({ kind: "podcast", play_state: "played" }))).toBe(true);
        expect(isPlayedPodcast(track({ kind: "podcast", play_state: "in_progress" }))).toBe(false);
        expect(isPlayedPodcast(track({ kind: "podcast" }))).toBe(false); // defaults to 'unplayed'
        expect(isPlayedPodcast(track({ kind: "music", play_state: "played" }))).toBe(false);
    });
});

describe("podcastBadge", () => {
    it("renders nothing for a non-podcast track", () => {
        const { container } = render(<>{podcastBadge(track({ kind: "music" }), i18n.t)}</>);
        expect(container).toBeEmptyDOMElement();
    });

    it("renders nothing once the episode is fully played (row is dimmed instead)", () => {
        const { container } = render(<>{podcastBadge(track({ kind: "podcast", play_state: "played" }), i18n.t)}</>);
        expect(container).toBeEmptyDOMElement();
    });

    it("renders an unplayed badge with no percentage", () => {
        render(<>{podcastBadge(track({ kind: "podcast", play_state: "unplayed" }), i18n.t)}</>);
        const badge = screen.getByLabelText("Podcast, unplayed");
        expect(badge).toHaveClass("podcast-badge--unplayed");
    });

    it("renders an in-progress badge with the rounded percent played", () => {
        render(<>{podcastBadge(track({ kind: "podcast", play_state: "in_progress", duration: 200, resume_position: 50 }), i18n.t)}</>);
        const badge = screen.getByLabelText("Podcast, 25 percent played");
        expect(badge).toHaveClass("podcast-badge--in_progress");
        expect(badge).toHaveAttribute("title", "Podcast — 25% played");
    });

    it("treats a missing duration as 0% rather than dividing by zero", () => {
        render(<>{podcastBadge(track({ kind: "podcast", play_state: "in_progress", resume_position: 50 }), i18n.t)}</>);
        expect(screen.getByLabelText("Podcast, 0 percent played")).toBeInTheDocument();
    });
});

describe("podcastDurationText", () => {
    it("shows position / duration for an in-progress podcast", () => {
        expect(podcastDurationText(track({ kind: "podcast", play_state: "in_progress", resume_position: 623, duration: 5430 }))).toBe("10:23 / 1:30:30");
    });

    it("falls back to the plain duration otherwise", () => {
        expect(podcastDurationText(track({ kind: "podcast", play_state: "unplayed", duration: 600 }))).toBe("10:00");
        expect(podcastDurationText(track({ kind: "podcast", play_state: "played", duration: 600 }))).toBe("10:00");
        expect(podcastDurationText(track({ kind: "music", play_state: "in_progress", resume_position: 5, duration: 600 }))).toBe("10:00");
        expect(podcastDurationText(track({ kind: "podcast", play_state: "in_progress", resume_position: 5 }))).toBe("--:--");
    });
});
