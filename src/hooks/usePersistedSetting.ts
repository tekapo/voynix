import { useCallback, useState } from "react";
import { getSetting, setSetting } from "../db";

/**
 * A React state value that's mirrored to a single `settings` row in the DB.
 *
 * Loading is NOT done by an effect in this hook: `getSetting()` must run
 * inside App's mount-time `initialize()` effect, after `initDb()` resolves,
 * in the same order the individual `getSetting(...).then(...)` calls used to
 * run inline — a hook-owned `useEffect` would fire on mount independently of
 * that ordering and could read the DB before it's open. Instead this returns
 * a `load()` function for `initialize()` to await/call alongside the others.
 *
 * `decode` returning `undefined` means "leave the current value alone" (used
 * to reproduce call sites that only applied a stored value for one specific
 * case, e.g. `if (v === "list") ...`, and otherwise kept the useState default).
 */
export function usePersistedSetting<T>(
    key: string,
    initial: T,
    decode: (raw: string | null) => T | undefined,
    encode: (value: T) => string,
) {
    const [value, setValue] = useState<T>(initial);

    const load = useCallback(() => {
        return getSetting(key).then((raw) => {
            const decoded = decode(raw ?? null);
            if (decoded !== undefined) setValue(decoded);
        }).catch(() => { /* keep the useState default */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    const set = useCallback((next: T | ((prev: T) => T)) => {
        setValue((prev) => {
            const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
            setSetting(key, encode(resolved)).catch((e) =>
                console.error(`Failed to persist ${key}:`, e));
            return resolved;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return [value, set, load] as const;
}
