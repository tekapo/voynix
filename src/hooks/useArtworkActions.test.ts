import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
const albumArt = vi.hoisted(() => ({ invalidateAlbumArt: vi.fn() }));
const artistArt = vi.hoisted(() => ({ invalidateArtistArt: vi.fn() }));
const db = vi.hoisted(() => ({
  getAlbumCover: vi.fn(),
  getArtistCoverKeys: vi.fn(),
  setAlbumCover: vi.fn(),
  setArtistCover: vi.fn(),
  updateTrackTags: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("../albumArt", () => albumArt);
vi.mock("../artistArt", () => artistArt);
vi.mock("../db", () => db);

import { useArtworkActions } from "./useArtworkActions";

const track = (over: Record<string, unknown> = {}) =>
  ({
    id: "t1",
    title: "Song",
    artist: "Artist",
    album: "Album",
    file_path: "/music/Artist/Album/song.mp3",
    file_name: "song.mp3",
    track_key: "key-1",
    disc_no: 1,
    track_no: 2,
    ...over,
  }) as never;

const fields = (over: Record<string, unknown> = {}) => ({
  title: "Song",
  artist: "Artist",
  album: "Album",
  disc_no: 1,
  track_no: 2,
  ...over,
}) as never;

function setup(artists: string[] = []) {
  const params = {
    setError: vi.fn(),
    refreshPlaylists: vi.fn().mockResolvedValue(undefined),
    patchCurrentTrackIfId: vi.fn(),
    artists,
  };
  const { result } = renderHook(() => useArtworkActions(params));
  return { params, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  invoke.mockResolvedValue(undefined);
  dialog.open.mockResolvedValue(null);
  db.getAlbumCover.mockResolvedValue(null);
  db.getArtistCoverKeys.mockResolvedValue(new Set());
  db.setAlbumCover.mockResolvedValue(undefined);
  db.setArtistCover.mockResolvedValue(undefined);
  db.updateTrackTags.mockResolvedValue(undefined);
});

describe("handleShowInFinder", () => {
  it("asks the native layer to reveal the file", async () => {
    const { result } = setup();
    await act(() => result.current.handleShowInFinder(track()));
    expect(invoke).toHaveBeenCalledWith("show_in_finder", { path: "/music/Artist/Album/song.mp3" });
  });

  it("surfaces a failure through setError", async () => {
    invoke.mockRejectedValue("boom");
    const { params, result } = setup();
    await act(() => result.current.handleShowInFinder(track()));
    expect(params.setError).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

describe("handleSetArtwork", () => {
  it("does nothing when the picker is cancelled", async () => {
    const { params, result } = setup();
    await act(() => result.current.handleSetArtwork(track()));
    expect(invoke).not.toHaveBeenCalled();
    expect(params.setError).not.toHaveBeenCalled();
  });

  it("embeds the image, then clears the album thumbnail cache and invalidates the art", async () => {
    dialog.open.mockResolvedValue("/img/cover.png");
    const { result } = setup();
    await act(() => result.current.handleSetArtwork(track()));
    expect(invoke).toHaveBeenNthCalledWith(1, "set_track_artwork", {
      path: "/music/Artist/Album/song.mp3",
      imagePath: "/img/cover.png",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "clear_album_thumb_cache", { artist: "Artist", album: "Album" });
    expect(albumArt.invalidateAlbumArt).toHaveBeenCalledTimes(1);
  });

  it("reports a failed write and leaves the cache alone", async () => {
    dialog.open.mockResolvedValue("/img/cover.png");
    invoke.mockRejectedValue("disk full");
    const { params, result } = setup();
    await act(() => result.current.handleSetArtwork(track()));
    expect(params.setError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(albumArt.invalidateAlbumArt).not.toHaveBeenCalled();
  });
});

describe("handleSaveTrackTags", () => {
  beforeEach(() => {
    invoke.mockResolvedValue({ track_key: "key-2", content_hash: "hash-2" });
  });

  it("writes the file, re-keys the DB row, patches the current track and refreshes", async () => {
    const { params, result } = setup();
    const f = fields({ title: "New Title" });
    await act(() => result.current.handleSaveTrackTags(track(), f));
    expect(invoke).toHaveBeenCalledWith("write_track_tags", { path: "/music/Artist/Album/song.mp3", edit: f });
    expect(db.updateTrackTags).toHaveBeenCalledWith("t1", "key-1", f, "key-2", "hash-2");
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({
      title: "New Title",
      track_key: "key-2",
      content_hash: "hash-2",
    }));
    expect(params.refreshPlaylists).toHaveBeenCalled();
  });

  it("leaves the cover cache alone when neither artist nor album changed", async () => {
    const { result } = setup();
    await act(() => result.current.handleSaveTrackTags(track(), fields({ title: "Only Title" })));
    expect(invoke).not.toHaveBeenCalledWith("clear_album_thumb_cache", expect.anything());
    expect(albumArt.invalidateAlbumArt).not.toHaveBeenCalled();
  });

  it("clears the cache under the OLD key when the album changes", async () => {
    const { result } = setup();
    await act(() => result.current.handleSaveTrackTags(track(), fields({ album: "Renamed" })));
    expect(invoke).toHaveBeenCalledWith("clear_album_thumb_cache", { artist: "Artist", album: "Album" });
    expect(albumArt.invalidateAlbumArt).toHaveBeenCalledTimes(1);
  });

  it("stores a cleared tag as undefined on the current track", async () => {
    const { params, result } = setup();
    await act(() => result.current.handleSaveTrackTags(track(), fields({ artist: "", album: "" })));
    expect(params.patchCurrentTrackIfId).toHaveBeenCalledWith("t1", expect.objectContaining({
      artist: undefined,
      album: undefined,
    }));
  });
});

describe("handleSaveAlbumTags", () => {
  const two = () => [
    track({ id: "a", file_name: "a.mp3", file_path: "/m/Artist/Album/a.mp3", track_key: "ka" }),
    track({ id: "b", file_name: "b.mp3", file_path: "/m/Artist/Album/b.mp3", track_key: "kb" }),
  ];

  it("is a no-op for an empty album", async () => {
    const { params, result } = setup();
    await act(() => result.current.handleSaveAlbumTags([], { artist: "X", album: "Y" } as never, vi.fn()));
    expect(invoke).not.toHaveBeenCalled();
    expect(params.refreshPlaylists).not.toHaveBeenCalled();
  });

  it("rewrites every track, keeps title/disc/track per track, and reports progress", async () => {
    invoke.mockResolvedValue({ track_key: "new", content_hash: "h" });
    const onProgress = vi.fn();
    const { params, result } = setup();
    await act(() => result.current.handleSaveAlbumTags(two(), { artist: "Artist", album: "Album" } as never, onProgress));
    expect(invoke).toHaveBeenCalledWith("write_track_tags", {
      path: "/m/Artist/Album/a.mp3",
      edit: { title: "Song", artist: "Artist", album: "Album", disc_no: 1, track_no: 2 },
    });
    expect(db.updateTrackTags).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
    expect(params.refreshPlaylists).toHaveBeenCalledTimes(1);
    // Nothing was renamed, so the cover is neither moved nor invalidated.
    expect(db.getAlbumCover).not.toHaveBeenCalled();
    expect(albumArt.invalidateAlbumArt).not.toHaveBeenCalled();
  });

  it("carries the cover override over to the new key and clears both thumbnails on a rename", async () => {
    invoke.mockResolvedValue({ track_key: "new", content_hash: "h" });
    db.getAlbumCover.mockResolvedValue("data:image/png;base64,AAA");
    const { result } = setup();
    await act(() => result.current.handleSaveAlbumTags(two(), { artist: "Artist", album: "Renamed" } as never, vi.fn()));
    expect(db.getAlbumCover).toHaveBeenCalledWith("Artist", "Album");
    expect(db.setAlbumCover).toHaveBeenNthCalledWith(1, "Artist", "Renamed", "data:image/png;base64,AAA");
    expect(db.setAlbumCover).toHaveBeenNthCalledWith(2, "Artist", "Album", null);
    expect(invoke).toHaveBeenCalledWith("clear_album_thumb_cache", { artist: "Artist", album: "Album" });
    expect(invoke).toHaveBeenCalledWith("clear_album_thumb_cache", { artist: "Artist", album: "Renamed" });
    expect(albumArt.invalidateAlbumArt).toHaveBeenCalledTimes(1);
  });

  it("keeps going past a failed file, then throws a summary naming it", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { path: string }) => {
      if (args.path.endsWith("a.mp3")) throw new Error("locked");
      return { track_key: "new", content_hash: "h" };
    });
    const { params, result } = setup();
    await expect(act(() =>
      result.current.handleSaveAlbumTags(two(), { artist: "Artist", album: "Album" } as never, vi.fn()),
    )).rejects.toThrow("1/2 files failed: a.mp3");
    // The file that succeeded was still written, and the library still refreshed.
    expect(db.updateTrackTags).toHaveBeenCalledTimes(1);
    expect(params.refreshPlaylists).toHaveBeenCalled();
  });
});

describe("album cover overrides", () => {
  it("sets a picked image as the cover for that (artist, album)", async () => {
    dialog.open.mockResolvedValue("/img/c.jpg");
    invoke.mockResolvedValue("data:image/jpeg;base64,BBB");
    const { result } = setup();
    await act(() => result.current.handleSetAlbumCover(track()));
    expect(invoke).toHaveBeenCalledWith("read_image_as_data_uri", { imagePath: "/img/c.jpg" });
    expect(db.setAlbumCover).toHaveBeenCalledWith("Artist", "Album", "data:image/jpeg;base64,BBB");
    expect(albumArt.invalidateAlbumArt).toHaveBeenCalledTimes(1);
  });

  it("keys an untagged album by its folder name", async () => {
    dialog.open.mockResolvedValue("/img/c.jpg");
    invoke.mockResolvedValue("data:x");
    const { result } = setup();
    await act(() => result.current.handleSetAlbumCover(track({ album: undefined })));
    expect(db.setAlbumCover).toHaveBeenCalledWith("Artist", "Album", "data:x");
  });

  it("does nothing when the picker is cancelled", async () => {
    const { result } = setup();
    await act(() => result.current.handleSetAlbumCover(track()));
    expect(db.setAlbumCover).not.toHaveBeenCalled();
  });

  it("resets by writing null", async () => {
    const { result } = setup();
    await act(() => result.current.handleResetAlbumCover(track()));
    expect(db.setAlbumCover).toHaveBeenCalledWith("Artist", "Album", null);
    expect(albumArt.invalidateAlbumArt).toHaveBeenCalledTimes(1);
  });

  it("reports a failed reset", async () => {
    db.setAlbumCover.mockRejectedValue("nope");
    const { params, result } = setup();
    await act(() => result.current.handleResetAlbumCover(track()));
    expect(params.setError).toHaveBeenCalledWith(expect.stringContaining("nope"));
    expect(albumArt.invalidateAlbumArt).not.toHaveBeenCalled();
  });

  it("applies a downloaded cover from a URL", async () => {
    invoke.mockResolvedValue("data:fetched");
    const { result } = setup();
    await act(() => result.current.applyAlbumCoverUrl(track(), "https://img/c.jpg"));
    expect(invoke).toHaveBeenCalledWith("fetch_image_as_data_uri", { url: "https://img/c.jpg" });
    expect(db.setAlbumCover).toHaveBeenCalledWith("Artist", "Album", "data:fetched");
    expect(albumArt.invalidateAlbumArt).toHaveBeenCalledTimes(1);
  });
});

describe("artist image overrides", () => {
  it("sets a picked image for the artist", async () => {
    dialog.open.mockResolvedValue("/img/a.png");
    invoke.mockResolvedValue("data:artist");
    const { result } = setup();
    await act(() => result.current.handleSetArtistImage("Artist"));
    expect(invoke).toHaveBeenCalledWith("read_image_as_data_uri", { imagePath: "/img/a.png" });
    expect(db.setArtistCover).toHaveBeenCalledWith("Artist", "data:artist");
    expect(artistArt.invalidateArtistArt).toHaveBeenCalledTimes(1);
  });

  it("resets by writing null and reports a failure", async () => {
    const { params, result } = setup();
    await act(() => result.current.handleResetArtistImage("Artist"));
    expect(db.setArtistCover).toHaveBeenCalledWith("Artist", null);

    db.setArtistCover.mockRejectedValue("denied");
    await act(() => result.current.handleResetArtistImage("Artist"));
    expect(params.setError).toHaveBeenCalledWith(expect.stringContaining("denied"));
  });

  it("applies a downloaded picture from a URL", async () => {
    invoke.mockResolvedValue("data:pic");
    const { result } = setup();
    await act(() => result.current.applyArtistImageUrl("Artist", "https://img/a.jpg"));
    expect(invoke).toHaveBeenCalledWith("fetch_image_as_data_uri", { url: "https://img/a.jpg" });
    expect(db.setArtistCover).toHaveBeenCalledWith("Artist", "data:pic");
  });
});

describe("handleFetchMissingArtistImages", () => {
  it("skips Unknown Artist and artists that already have a cover, then clears the progress", async () => {
    db.getArtistCoverKeys.mockResolvedValue(new Set(["have"]));
    invoke.mockImplementation(async (_cmd: string, args: { artist: string }) =>
      args.artist === "Found" ? "data:found" : null);
    const { result } = setup(["Found", "Nothing", "Have", "Unknown Artist"]);
    await act(() => result.current.handleFetchMissingArtistImages());

    const asked = invoke.mock.calls.filter(c => c[0] === "auto_artist_image").map(c => c[1].artist).sort();
    expect(asked).toEqual(["Found", "Nothing"]);
    expect(db.setArtistCover).toHaveBeenCalledTimes(1);
    expect(db.setArtistCover).toHaveBeenCalledWith("Found", "data:found");
    expect(artistArt.invalidateArtistArt).toHaveBeenCalledTimes(1);
    expect(result.current.artistImageFetchProgress).toBeNull();
  });

  it("reports an empty result (0/0) and does no lookups when nothing is missing", async () => {
    db.getArtistCoverKeys.mockResolvedValue(new Set(["a"]));
    const { result } = setup(["A", "Unknown Artist"]);
    await act(() => result.current.handleFetchMissingArtistImages());
    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.artistImageFetchProgress).toEqual({ done: 0, total: 0, found: 0 });
    expect(artistArt.invalidateArtistArt).not.toHaveBeenCalled();
  });

  it("counts a failed lookup as done but not found, and carries on", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { artist: string }) => {
      if (args.artist === "Bad") throw new Error("network");
      return "data:ok";
    });
    const { result } = setup(["Bad", "Good"]);
    await act(() => result.current.handleFetchMissingArtistImages());
    expect(db.setArtistCover).toHaveBeenCalledTimes(1);
    expect(db.setArtistCover).toHaveBeenCalledWith("Good", "data:ok");
    expect(result.current.artistImageFetchProgress).toBeNull();
  });

  it("stops looking up further artists once cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    invoke.mockImplementation(async () => { await gate; return null; });
    const { result } = setup(["A", "B", "C", "D", "E", "F"]);

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.handleFetchMissingArtistImages();
      await Promise.resolve();
    });
    // Let the first two workers start (pool concurrency is 2), then cancel.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    result.current.cancelFetchMissingArtistImages();
    release();
    await act(() => running);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.artistImageFetchProgress).toBeNull();
  });
});
