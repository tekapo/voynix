import { useEffect } from "react";
import { Track } from "../types";

/**
 * The player bar's real height varies (a large system font stretches it
 * further). The sidebar / track list / lyrics panel reserve space for it via
 * --player-height-mobile, so measure the bar and feed the actual value back.
 * The CSS keeps 120px as the static fallback.
 */
export function usePlayerBarHeight(currentTrack: Track | null) {
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>(".player-bar");
    if (!bar) {
      document.documentElement.style.setProperty("--player-height-mobile", "0px");
      return;
    }
    if (typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const h = Math.round(bar.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty("--player-height-mobile", `${h}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [currentTrack]);
}
