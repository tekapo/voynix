import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const db = vi.hoisted(() => ({
  getLibrarySyncSources: vi.fn(),
  resetPlaylistManualOrder: vi.fn(),
  setLibrarySyncSources: vi.fn(),
  setPlaylistKind: vi.fn(),
  setPlaylistSyncToDevice: vi.fn(),
  setTrackRating: vi.fn(),
  setTrackKind: vi.fn(),
  setTrackPlayState: vi.fn(),
}));

vi.mock("../db", () => db);

import { usePlaylistActions } from "./usePlaylistActions";

const track = (over: Record<string, unknown> = {}) => ({ id: "t1", favorite: 0, ...over }) as never;

const playlist = (over: Record<string, unknown> = {}) =>
  ({ id: "p1", name: "P", tracks: [{ id: "t1" }], sync_to_device: 0, ...over }) as never;

async function setup(playlists: unknown[] = [], sources: string[] = []) {
  db.getLibrarySyncSources.mockResolvedValue(sources);
  const params = {
    playlists: playlists as never,
    refreshPlaylists: vi.fn().mockResolvedValue(undefined),
    setError: vi.fn(),
    patchCurrentTrackIfId: vi.fn(),
    setCurrentTrack: vi.fn(),
    bumpSnapshot: vi.fn(),
    closeTrackMenu: vi.fn(),
    closePlaylistMenu: vi.fn(),
    closeLibraryMenu: vi.fn(),
  };
  const { result } = renderHook(() => usePlaylistActions(params));
  // The hook loads the saved library-sync flags on mount.
  await waitFor(() => expect(db.getLibrarySyncSources).toHaveBeenCalled());
  await act(async () => {});
  return { params, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const fn of Object.values(db)) fn.mockResolvedValue(undefined);
});

describe("handleToggleFavorite", () => {
  it("favorites an un-favorited track, patches the now-playing copy and refreshes", async () => {
    const { params, result } = await setup();
    await act(() => result.current.handleToggleFavorite(track({ favorite: 0 })));
    expect(db.setTrackRating).toHaveBeenCalledWith("t1", "up");
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({ favorite: 1 }));
    expect(params.refreshPlaylists).toHaveBeenCalled();
  });

  it("un-favorites a favorited track", async () => {
    const { params, result } = await setup();
    await act(() => result.current.handleToggleFavorite(track({ favorite: 1 })));
    expect(db.setTrackRating).toHaveBeenCalledWith("t1", "none");
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({ favorite: 0 }));
  });

  it("switches from thumbs down straight to thumbs up", async () => {
    const { params, result } = await setup();
    await act(() => result.current.handleToggleFavorite(track({ favorite: 0, disliked: 1 })));
    expect(db.setTrackRating).toHaveBeenCalledWith("t1", "up");
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({ favorite: 1, disliked: 0 }));
  });

  it("reports a failure without refreshing", async () => {
    db.setTrackRating.mockRejectedValue("db locked");
    const { params, result } = await setup();
    await act(() => result.current.handleToggleFavorite(track()));
    expect(params.setError).toHaveBeenCalledWith(expect.stringContaining("db locked"));
    expect(params.refreshPlaylists).not.toHaveBeenCalled();
  });
});

describe("handleToggleDislike", () => {
  it("thumbs-downs a track, clearing thumbs up, and refreshes", async () => {
    const { params, result } = await setup();
    await act(() => result.current.handleToggleDislike(track({ favorite: 1, disliked: 0 })));
    expect(db.setTrackRating).toHaveBeenCalledWith("t1", "down");
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({ favorite: 0, disliked: 1 }));
    expect(params.refreshPlaylists).toHaveBeenCalled();
  });

  it("removes an existing thumbs down", async () => {
    const { params, result } = await setup();
    await act(() => result.current.handleToggleDislike(track({ disliked: 1 })));
    expect(db.setTrackRating).toHaveBeenCalledWith("t1", "none");
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({ favorite: 0, disliked: 0 }));
  });
});

describe("handleSetKind", () => {
  it("sets the kind, patches the now-playing copy, refreshes and closes the menu", async () => {
    const { params, result } = await setup();
    await act(() => result.current.handleSetKind(track(), "podcast"));
    expect(db.setTrackKind).toHaveBeenCalledWith("t1", "podcast");
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({ kind: "podcast" }));
    expect(params.refreshPlaylists).toHaveBeenCalled();
    expect(params.closeTrackMenu).toHaveBeenCalledTimes(1);
  });

  it("still closes the menu when the write fails", async () => {
    db.setTrackKind.mockRejectedValue("x");
    const { params, result } = await setup();
    await act(() => result.current.handleSetKind(track(), "music"));
    expect(params.setError).toHaveBeenCalled();
    expect(params.closeTrackMenu).toHaveBeenCalledTimes(1);
  });
});

describe("handleSetPlayState", () => {
  it("marks a podcast played with the resume point reset", async () => {
    const { params, result } = await setup();
    await act(() => result.current.handleSetPlayState(track(), "played"));
    expect(db.setTrackPlayState).toHaveBeenCalledWith("t1", "played", 0);
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({
      play_state: "played",
      resume_position: 0,
    }));
    expect(params.closeTrackMenu).toHaveBeenCalledTimes(1);
  });

  it("swallows a failure quietly (no error banner) but still closes the menu", async () => {
    db.setTrackPlayState.mockRejectedValue("x");
    const { params, result } = await setup();
    await act(() => result.current.handleSetPlayState(track(), "unplayed"));
    expect(params.setError).not.toHaveBeenCalled();
    expect(params.closeTrackMenu).toHaveBeenCalledTimes(1);
  });
});

describe("handleToggleLibrarySync", () => {
  it("loads the saved flags on mount", async () => {
    const { result } = await setup([], ["favorites"]);
    expect(result.current.librarySyncSources).toEqual(["favorites"]);
  });

  it("adds a source, persists it, rebuilds the snapshot and closes the menu", async () => {
    const { params, result } = await setup([], ["favorites"]);
    await act(() => result.current.handleToggleLibrarySync("recent" as never));
    expect(db.setLibrarySyncSources).toHaveBeenCalledWith(["favorites", "recent"]);
    expect(result.current.librarySyncSources).toEqual(["favorites", "recent"]);
    expect(params.bumpSnapshot).toHaveBeenCalledTimes(1);
    expect(params.closeLibraryMenu).toHaveBeenCalledTimes(1);
  });

  it("removes a source that is already on", async () => {
    const { result } = await setup([], ["favorites", "recent"]);
    await act(() => result.current.handleToggleLibrarySync("favorites" as never));
    expect(db.setLibrarySyncSources).toHaveBeenCalledWith(["recent"]);
    expect(result.current.librarySyncSources).toEqual(["recent"]);
  });

  it("keeps the old flags and skips the snapshot rebuild when the write fails", async () => {
    db.setLibrarySyncSources.mockRejectedValue("x");
    const { params, result } = await setup([], ["favorites"]);
    await act(() => result.current.handleToggleLibrarySync("recent" as never));
    expect(result.current.librarySyncSources).toEqual(["favorites"]);
    expect(params.bumpSnapshot).not.toHaveBeenCalled();
    expect(params.setError).toHaveBeenCalled();
    expect(params.closeLibraryMenu).toHaveBeenCalledTimes(1);
  });
});

describe("handleToggleSyncToDevice", () => {
  it("turns an off playlist on", async () => {
    const { params, result } = await setup([playlist({ sync_to_device: 0 })]);
    await act(() => result.current.handleToggleSyncToDevice("p1"));
    expect(db.setPlaylistSyncToDevice).toHaveBeenCalledWith("p1", true);
    expect(params.refreshPlaylists).toHaveBeenCalled();
    expect(params.closePlaylistMenu).toHaveBeenCalledTimes(1);
  });

  it("turns an on playlist off", async () => {
    const { result } = await setup([playlist({ sync_to_device: 1 })]);
    await act(() => result.current.handleToggleSyncToDevice("p1"));
    expect(db.setPlaylistSyncToDevice).toHaveBeenCalledWith("p1", false);
  });

  it("reports a failure and still closes the menu", async () => {
    db.setPlaylistSyncToDevice.mockRejectedValue("x");
    const { params, result } = await setup([playlist()]);
    await act(() => result.current.handleToggleSyncToDevice("p1"));
    expect(params.setError).toHaveBeenCalled();
    expect(params.closePlaylistMenu).toHaveBeenCalledTimes(1);
  });
});

describe("handleSetPlaylistKind", () => {
  it("reclassifies the playlist and updates the now-playing track only if it is in it", async () => {
    const { params, result } = await setup([playlist({ tracks: [{ id: "t1" }] })]);
    await act(() => result.current.handleSetPlaylistKind("p1", "podcast"));
    expect(db.setPlaylistKind).toHaveBeenCalledWith("p1", "podcast");
    expect(params.refreshPlaylists).toHaveBeenCalled();
    expect(params.closePlaylistMenu).toHaveBeenCalledTimes(1);

    const updater = params.setCurrentTrack.mock.calls[0][0] as (prev: unknown) => unknown;
    expect(updater({ id: "t1", kind: "music" })).toEqual(expect.objectContaining({ id: "t1", kind: "podcast" }));
    const other = { id: "other", kind: "music" };
    expect(updater(other)).toBe(other);
    expect(updater(null)).toBeNull();
  });

  it("reports a failure and leaves the now-playing track alone", async () => {
    db.setPlaylistKind.mockRejectedValue("x");
    const { params, result } = await setup([playlist()]);
    await act(() => result.current.handleSetPlaylistKind("p1", "podcast"));
    expect(params.setCurrentTrack).not.toHaveBeenCalled();
    expect(params.setError).toHaveBeenCalled();
    expect(params.closePlaylistMenu).toHaveBeenCalledTimes(1);
  });
});

describe("handleResetManualOrder", () => {
  it("resets the order, refreshes and closes the menu", async () => {
    const { params, result } = await setup();
    await act(() => result.current.handleResetManualOrder("p1"));
    expect(db.resetPlaylistManualOrder).toHaveBeenCalledWith("p1");
    expect(params.refreshPlaylists).toHaveBeenCalled();
    expect(params.closePlaylistMenu).toHaveBeenCalledTimes(1);
  });

  it("reports a failure", async () => {
    db.resetPlaylistManualOrder.mockRejectedValue("x");
    const { params, result } = await setup();
    await act(() => result.current.handleResetManualOrder("p1"));
    expect(params.setError).toHaveBeenCalled();
    expect(params.refreshPlaylists).not.toHaveBeenCalled();
  });
});
