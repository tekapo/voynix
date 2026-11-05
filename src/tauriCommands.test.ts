import { describe, expect, it } from "vitest";
import libRs from "../src-tauri/src/lib.rs?raw";

// Contract between the frontend and the Rust side: every command the UI
// `invoke()`s by name must be registered in `generate_handler![…]` (lib.rs).
// A rename or a module move that drops one is otherwise only caught at runtime
// ("command X not found"), because the frontend calls commands by string.

// Every non-test source file under src/, as text (Vite resolves this at transform
// time, so the test needs no node:fs and no @types/node).
const SOURCES = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/test/**"],
  { query: "?raw", import: "default", eager: true },
);

/** Commands invoked through a variable, which the scan below can't read off the
 *  call site. Keep in step with the code; a NEW dynamic call fails the test. */
const DYNAMIC_INVOKES: Record<string, string[]> = {
  "src/hooks/useScanFolders.ts": ["scan_music_dir", "import_itunes_xml"],
};

/** Registered but not called from the frontend. */
const UNUSED_COMMANDS = new Set<string>(["greet"]);

/** Finds `invoke(...)` / `invoke<…>(...)` calls. Returns the literal command
 *  names, plus the number of calls whose first argument isn't a string literal. */
function scanInvokes(source: string): { names: string[]; dynamic: number } {
  // Comments can mention `invoke()`; blank them out (keeping string literals,
  // so a "//" inside a URL string isn't mistaken for a comment).
  const code = source.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, str) => (str ? match : " ".repeat(match.length)),
  );
  const names: string[] = [];
  let dynamic = 0;
  const re = /\binvoke\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length;
    while (/\s/.test(code[i])) i++;
    if (code[i] === "<") {
      let depth = 0;
      for (; i < code.length; i++) {
        if (code[i] === "<") depth++;
        else if (code[i] === ">" && code[i - 1] !== "=") {
          depth--;
          if (depth === 0) { i++; break; }
        }
      }
      while (/\s/.test(code[i])) i++;
    }
    if (code[i] !== "(") continue; // an import, a type, a mention in a comment…
    i++;
    while (/\s/.test(code[i])) i++;
    const quote = code[i];
    if (quote === '"' || quote === "'") {
      const end = code.indexOf(quote, i + 1);
      names.push(code.slice(i + 1, end));
    } else {
      dynamic++;
    }
  }
  return { names, dynamic };
}

function registeredCommands(): Set<string> {
  const lib = libRs;
  const start = lib.indexOf("generate_handler![");
  expect(start, "generate_handler! not found in lib.rs").toBeGreaterThan(-1);
  const body = lib.slice(start + "generate_handler![".length, lib.indexOf("]", start));
  return new Set(
    body
      .replace(/\/\/[^\n]*/g, "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.split("::").pop()!),
  );
}

describe("frontend <-> Rust command contract", () => {
  const registered = registeredCommands();
  const calls = new Map<string, { names: string[]; dynamic: number }>();
  for (const [file, code] of Object.entries(SOURCES)) {
    const found = scanInvokes(code);
    if (found.names.length || found.dynamic) calls.set(file.replace(/^\//, ""), found);
  }
  const literal = new Set([...calls.values()].flatMap(c => c.names));

  it("finds the registered command list and the frontend calls (sanity check on the scan itself)", () => {
    expect(registered.size).toBeGreaterThan(30);
    expect(literal.size).toBeGreaterThan(30);
    expect(registered.has("write_track_tags")).toBe(true);
    expect(literal.has("write_track_tags")).toBe(true);
  });

  it("registers every command the frontend invokes by name", () => {
    const missing = [...literal].filter(n => !n.includes(":") && !registered.has(n)).sort();
    expect(missing, "invoked from the UI but missing from generate_handler!").toEqual([]);
  });

  it("registers the commands that are invoked through a variable", () => {
    for (const [file, names] of Object.entries(DYNAMIC_INVOKES)) {
      for (const n of names) expect(registered.has(n), `${file} -> ${n}`).toBe(true);
    }
  });

  it("knows every call site that passes the command name in a variable", () => {
    const unknown = [...calls.entries()]
      .filter(([file, c]) => c.dynamic > 0 && !(file in DYNAMIC_INVOKES))
      .map(([file]) => file);
    expect(unknown, "add these to DYNAMIC_INVOKES (and list the commands they can send)").toEqual([]);
  });

  it("has no registered command that nothing calls (dead command or a renamed one)", () => {
    const dynamicNames = new Set(Object.values(DYNAMIC_INVOKES).flat());
    const unused = [...registered]
      .filter(n => !literal.has(n) && !dynamicNames.has(n) && !UNUSED_COMMANDS.has(n))
      .sort();
    expect(unused).toEqual([]);
  });
});
