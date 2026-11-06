import { describe, expect, it } from "vitest";

// Guard rail: the webview must never turn a string into HTML or code.
//
// The main window has broad capabilities (src-tauri/capabilities/default.json:
// reading any file, and SQL on the app database that holds the sync token and
// the Echo secret). Today nothing can run attacker-controlled script in it —
// strings from tags, lyrics, synced data and backups are rendered as React text
// nodes, and the CSP has no 'unsafe-eval'. This test keeps it that way: it
// fails when any app source starts using an API that parses a string as HTML
// or executes one, so adding such a sink becomes a deliberate, reviewed change.
//
// If one is ever really needed, add the file to ALLOWED below with a reason
// (and sanitise the input), rather than weakening the patterns.

// Every non-test source file under src/, as text (same approach as tauriCommands.test.ts).
const SOURCES = import.meta.glob<string>(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/test/**"],
  { query: "?raw", import: "default", eager: true },
);

/** Sinks that parse a string as markup or run it as code. */
const SINKS: { name: string; pattern: RegExp }[] = [
  { name: "dangerouslySetInnerHTML", pattern: /\bdangerouslySetInnerHTML\b/ },
  { name: "innerHTML", pattern: /\binnerHTML\b/ },
  { name: "outerHTML", pattern: /\bouterHTML\b/ },
  { name: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\b/ },
  { name: "createContextualFragment", pattern: /\bcreateContextualFragment\b/ },
  { name: "document.write", pattern: /\bdocument\s*\.\s*write(ln)?\s*\(/ },
  { name: "eval", pattern: /\beval\s*\(/ },
  { name: "new Function", pattern: /\bnew\s+Function\s*\(/ },
  { name: "srcDoc", pattern: /\bsrc[dD]oc\b/ },
  { name: "<iframe>/<embed>/<object>", pattern: /<\s*(iframe|embed|object|frame)\b/i },
];

/** Files allowed to use a sink, by path, with the sink names and why. Keep empty
 *  unless there is a reviewed reason. */
const ALLOWED: Record<string, { sinks: string[]; reason: string }> = {};

/** Source with comments blanked out (string literals kept, so a "//" inside a
 *  URL isn't mistaken for a comment) — comments may legitimately name a sink. */
function stripComments(source: string): string {
  return source.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, str) => (str ? match : " ".repeat(match.length)),
  );
}

/** Names of the sinks the source uses. */
function findSinks(source: string): string[] {
  const code = stripComments(source);
  return SINKS.filter((s) => s.pattern.test(code)).map((s) => s.name);
}

describe("webview HTML/code sinks", () => {
  it("the scanner detects each kind of sink (so a clean result means something)", () => {
    const samples: Record<string, string> = {
      dangerouslySetInnerHTML: "<div dangerouslySetInnerHTML={{ __html: x }} />",
      innerHTML: "el.innerHTML = x;",
      outerHTML: "el.outerHTML = x;",
      insertAdjacentHTML: "el.insertAdjacentHTML('beforeend', x);",
      createContextualFragment: "range.createContextualFragment(x);",
      "document.write": "document.write(x);",
      eval: "eval(x);",
      "new Function": "const f = new Function('return 1');",
      srcDoc: "<iframe srcDoc={x} />",
      "<iframe>/<embed>/<object>": "<embed src={x} />",
    };
    for (const sink of SINKS) {
      expect(findSinks(samples[sink.name]), sink.name).toContain(sink.name);
    }
    // Mentioning a sink in a comment is fine; using it is not.
    expect(findSinks("// never use innerHTML here\n/* eval( is banned */ const a = 1;")).toEqual([]);
    // Plain React text rendering is the supported way.
    expect(findSinks("return <p>{track.title}</p>;")).toEqual([]);
  });

  it("scans the app sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
  });

  it("no app source parses a string as HTML or executes one", () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      const allowed = ALLOWED[file.replace(/^\//, "")]?.sinks ?? [];
      for (const sink of findSinks(source)) {
        if (!allowed.includes(sink)) offenders.push(`${file.replace(/^\//, "")}: ${sink}`);
      }
    }
    expect(offenders, "render strings as React text; see the comment at the top of this file").toEqual([]);
  });
});
