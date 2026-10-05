import { useRef, useState } from "react";
import { skipTarget } from "../playback";
import { createPlaybackClock, PlaybackClock } from "../playbackClock";
import { createEngine } from "../player/createEngine";
import { PlayerEngine } from "../player/engine";
import { Track } from "../types";

interface UseAudioPlayerParams {
  currentTrack: Track | null;
}

// Owns the playback engine (see src/player/engine.ts) plus its transport
// controls (play/pause flag, seek, ±skip, volume) and the playback clock
// App.tsx ticks on every position update. Loading a track, and the engine's
// other event side effects (media session, podcast resume save, cursor save,
// play-count) stay in App.tsx — they depend on viewMode/currentTrack/
// refreshPlaylists and read the engine returned here.
export function useAudioPlayer({ currentTrack }: UseAudioPlayerParams) {
  const engineRef = useRef<PlayerEngine | null>(null);
  if (!engineRef.current) engineRef.current = createEngine();
  const engine = engineRef.current;

  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const clockRef = useRef<PlaybackClock | null>(null);
  if (!clockRef.current) clockRef.current = createPlaybackClock();
  const clock = clockRef.current;

  const handleSeek = (time: number) => {
    engine.seek(time);
    clock.set(time);
  };

  const handleVolumeChange = (vol: number) => {
    setVolume(vol);
    engine.setVolume(vol);
  };

  // ±10s skip. Reuses handleSeek so the native media session position updates too.
  const handleSkip = (delta: number) => {
    if (!currentTrack) return;
    handleSeek(skipTarget(engine.getCurrentTime(), delta, engine.getDuration() || duration || 0));
  };

  return {
    engine,
    isPlaying,
    setIsPlaying,
    duration,
    setDuration,
    volume,
    setVolume,
    clock,
    handleSeek,
    handleVolumeChange,
    handleSkip,
  };
}
