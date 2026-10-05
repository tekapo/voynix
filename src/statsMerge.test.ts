import { describe, expect, it } from "vitest";
import {
    DeviceStats,
    FavoriteRow,
    mergeEvents,
    mergeFavorites,
    mergePlayStates,
    PlayEvent,
    playCount,
    PlayStateRow,
    sameStats,
    syncRoundTrip,
} from "./statsMerge";

const ev = (track: string, at: number, device: string): PlayEvent => ({
    track_key: track,
    played_at: at,
    device_id: device,
});

const fav = (track: string, favorite: number, at: number | null): FavoriteRow => ({
    track_key: track,
    favorite,
    favorite_updated_at: at,
});

const ps = (
    track: string,
    play_state: PlayStateRow["play_state"],
    resume_position: number,
    at: number | null
): PlayStateRow => ({
    track_key: track,
    play_state,
    resume_position,
    play_state_updated_at: at,
});

const device = (id: string, over: Partial<DeviceStats> = {}): DeviceStats => ({
    id,
    events: [],
    favorites: [],
    play_states: [],
    ...over,
});

describe("mergeEvents", () => {
    it("unions two logs and drops exact (device, time, track) duplicates", () => {
        const a = [ev("s1", 10, "mac"), ev("s1", 20, "mac")];
        const b = [ev("s1", 20, "mac"), ev("s2", 30, "phone")];
        const merged = mergeEvents(a, b);
        expect(merged).toHaveLength(3);
        expect(playCount(merged, "s1")).toBe(2);
        expect(playCount(merged, "s2")).toBe(1);
    });

    it("keeps two plays of one track at different times", () => {
        const merged = mergeEvents([ev("s1", 10, "phone")], [ev("s1", 11, "phone")]);
        expect(playCount(merged, "s1")).toBe(2);
    });

    it("keeps same-instant plays of one track from different devices", () => {
        const merged = mergeEvents([ev("s1", 100, "mac")], [ev("s1", 100, "phone")]);
        expect(playCount(merged, "s1")).toBe(2);
    });

    it("is commutative", () => {
        const a = [ev("s1", 10, "mac"), ev("s2", 20, "mac")];
        const b = [ev("s2", 20, "mac"), ev("s3", 30, "phone")];
        const ab = mergeEvents(a, b).map(e => `${e.device_id}/${e.played_at}/${e.track_key}`).sort();
        const ba = mergeEvents(b, a).map(e => `${e.device_id}/${e.played_at}/${e.track_key}`).sort();
        expect(ab).toEqual(ba);
    });

    it("does not mutate its inputs", () => {
        const a = [ev("s1", 10, "mac")];
        mergeEvents(a, [ev("s2", 20, "phone")]);
        expect(a).toHaveLength(1);
    });
});

describe("mergeFavorites", () => {
    it("takes the newer timestamp per track_key", () => {
        const into = [fav("s1", 1, 100), fav("s2", 0, 500)];
        const incoming = [fav("s1", 0, 200), fav("s2", 1, 300)];
        const merged = mergeFavorites(into, incoming);
        expect(merged.find(f => f.track_key === "s1")).toEqual(fav("s1", 0, 200));
        expect(merged.find(f => f.track_key === "s2")).toEqual(fav("s2", 0, 500));
    });

    it("keeps the incumbent on a timestamp tie", () => {
        const merged = mergeFavorites([fav("s1", 1, 100)], [fav("s1", 0, 100)]);
        expect(merged).toEqual([fav("s1", 1, 100)]);
    });

    it("adds a track_key it has never seen", () => {
        const merged = mergeFavorites([], [fav("s9", 1, 42)]);
        expect(merged).toEqual([fav("s9", 1, 42)]);
    });

    it("ignores incoming rows with a null timestamp", () => {
        const merged = mergeFavorites([fav("s1", 0, 100)], [fav("s1", 1, null)]);
        expect(merged).toEqual([fav("s1", 0, 100)]);
    });
});

describe("mergePlayStates", () => {
    it("takes the newer timestamp per track_key", () => {
        const into = [ps("p1", "in_progress", 30, 100), ps("p2", "unplayed", 0, 500)];
        const incoming = [ps("p1", "played", 0, 200), ps("p2", "in_progress", 15, 300)];
        const merged = mergePlayStates(into, incoming);
        expect(merged.find(r => r.track_key === "p1")).toEqual(ps("p1", "played", 0, 200));
        expect(merged.find(r => r.track_key === "p2")).toEqual(ps("p2", "unplayed", 0, 500));
    });

    it("keeps the incumbent on a timestamp tie", () => {
        const merged = mergePlayStates([ps("p1", "played", 0, 100)], [ps("p1", "in_progress", 30, 100)]);
        expect(merged).toEqual([ps("p1", "played", 0, 100)]);
    });

    it("adds a track_key it has never seen", () => {
        const merged = mergePlayStates([], [ps("p9", "in_progress", 45, 42)]);
        expect(merged).toEqual([ps("p9", "in_progress", 45, 42)]);
    });

    it("ignores incoming rows with a null timestamp", () => {
        const merged = mergePlayStates([ps("p1", "unplayed", 0, 100)], [ps("p1", "played", 0, null)]);
        expect(merged).toEqual([ps("p1", "unplayed", 0, 100)]);
    });

    it("replaces state and position together — never mixes an old position with a new state", () => {
        const merged = mergePlayStates(
            [ps("p1", "in_progress", 500, 10)],
            [ps("p1", "played", 0, 20)]
        );
        expect(merged).toEqual([ps("p1", "played", 0, 20)]);
    });
});

describe("syncRoundTrip", () => {
    it("converges play counts in a single round trip", () => {
        // Mac played s1 twice; phone played s1 once and s2 once.
        let mac = device("mac", { events: [ev("s1", 10, "mac"), ev("s1", 20, "mac")] });
        let phone = device("phone", { events: [ev("s1", 50, "phone"), ev("s2", 60, "phone")] });

        ({ mac, phone } = syncRoundTrip(mac, phone));

        expect(playCount(mac.events, "s1")).toBe(3);
        expect(playCount(phone.events, "s1")).toBe(3);
        expect(playCount(mac.events, "s2")).toBe(1);
        expect(playCount(phone.events, "s2")).toBe(1);
        expect(sameStats(mac, phone)).toBe(true);
    });

    it("converges a favorite toggled on the phone", () => {
        let mac = device("mac", { favorites: [fav("s1", 0, 100)] });
        let phone = device("phone", { favorites: [fav("s1", 1, 200)] });

        ({ mac, phone } = syncRoundTrip(mac, phone));

        expect(mac.favorites).toEqual([fav("s1", 1, 200)]);
        expect(phone.favorites).toEqual([fav("s1", 1, 200)]);
    });

    it("converges a favorite toggled on the Mac", () => {
        let mac = device("mac", { favorites: [fav("s1", 1, 300)] });
        let phone = device("phone", { favorites: [fav("s1", 0, 100)] });

        ({ mac, phone } = syncRoundTrip(mac, phone));

        expect(mac.favorites).toEqual([fav("s1", 1, 300)]);
        expect(phone.favorites).toEqual([fav("s1", 1, 300)]);
    });

    it("is idempotent — a second sync with no new activity changes nothing", () => {
        let mac = device("mac", {
            events: [ev("s1", 10, "mac")],
            favorites: [fav("s1", 1, 100)],
            play_states: [ps("p1", "in_progress", 30, 100)],
        });
        let phone = device("phone", {
            events: [ev("s1", 50, "phone")],
            favorites: [fav("s2", 1, 200)],
            play_states: [ps("p2", "played", 0, 200)],
        });

        ({ mac, phone } = syncRoundTrip(mac, phone));
        const macAfterFirst = mac;
        const phoneAfterFirst = phone;

        ({ mac, phone } = syncRoundTrip(mac, phone));

        expect(sameStats(mac, macAfterFirst)).toBe(true);
        expect(sameStats(phone, phoneAfterFirst)).toBe(true);
        expect(playCount(mac.events, "s1")).toBe(2);
        expect(playCount(phone.events, "s1")).toBe(2);
    });

    it("converges when both devices play the same track before syncing", () => {
        let mac = device("mac", { events: [ev("s1", 10, "mac"), ev("s1", 40, "mac")] });
        let phone = device("phone", { events: [ev("s1", 20, "phone"), ev("s1", 30, "phone")] });

        ({ mac, phone } = syncRoundTrip(mac, phone));

        expect(playCount(mac.events, "s1")).toBe(4);
        expect(playCount(phone.events, "s1")).toBe(4);
        expect(sameStats(mac, phone)).toBe(true);
    });

    it("keeps converging across rounds with activity in between", () => {
        let mac = device("mac");
        let phone = device("phone");

        phone.events.push(ev("s1", 100, "phone"));
        phone.favorites.push(fav("s1", 1, 100));
        ({ mac, phone } = syncRoundTrip(mac, phone));
        expect(sameStats(mac, phone)).toBe(true);

        // Mac plays s1 and un-favorites it; phone plays s2.
        mac.events.push(ev("s1", 200, "mac"));
        mac.favorites = mergeFavorites(mac.favorites, [fav("s1", 0, 300)]);
        phone.events.push(ev("s2", 250, "phone"));
        ({ mac, phone } = syncRoundTrip(mac, phone));

        expect(playCount(mac.events, "s1")).toBe(2);
        expect(playCount(mac.events, "s2")).toBe(1);
        expect(mac.favorites).toEqual([fav("s1", 0, 300)]);
        expect(sameStats(mac, phone)).toBe(true);
    });

    it("reaches the same Mac state regardless of the order two phones sync", () => {
        const seedMac = () => device("mac", {
            events: [ev("s1", 10, "mac")],
            favorites: [fav("s1", 0, 10)],
            play_states: [ps("p1", "unplayed", 0, 10)],
        });
        const phoneA = () => device("A", {
            events: [ev("s1", 100, "A")],
            favorites: [fav("s1", 1, 400)],
            play_states: [ps("p1", "in_progress", 500, 350)],
        });
        const phoneB = () => device("B", {
            events: [ev("s2", 200, "B")],
            favorites: [fav("s1", 0, 250)],
            play_states: [ps("p1", "played", 0, 450)],
        });

        let macAB = seedMac();
        ({ mac: macAB } = syncRoundTrip(macAB, phoneA()));
        ({ mac: macAB } = syncRoundTrip(macAB, phoneB()));

        let macBA = seedMac();
        ({ mac: macBA } = syncRoundTrip(macBA, phoneB()));
        ({ mac: macBA } = syncRoundTrip(macBA, phoneA()));

        expect(sameStats(macAB, macBA)).toBe(true);
        expect(playCount(macAB.events, "s1")).toBe(2);
        expect(playCount(macAB.events, "s2")).toBe(1);
        // Phone A's toggle at t=400 is the newest write for s1.
        expect(macAB.favorites).toEqual([fav("s1", 1, 400)]);
        // Phone B's play-state update at t=450 is the newest write for p1,
        // regardless of which phone synced first.
        expect(macAB.play_states).toEqual([ps("p1", "played", 0, 450)]);
    });

    it("does not let the phone re-push a third device's events back to the Mac", () => {
        // The Mac already knows B's event; A syncs. A must not echo B's event,
        // and counts must stay correct either way (dedup covers it).
        let mac = device("mac", { events: [ev("s1", 10, "mac"), ev("s1", 20, "B")] });
        let phone = device("A", { events: [ev("s1", 30, "A")] });

        ({ mac, phone } = syncRoundTrip(mac, phone));

        expect(playCount(mac.events, "s1")).toBe(3);
        expect(playCount(phone.events, "s1")).toBe(3);
        expect(sameStats(mac, phone)).toBe(true);
    });
});
