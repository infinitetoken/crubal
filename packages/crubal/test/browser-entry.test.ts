// The browser entry (src/browser.ts) reaches nothing from Node: a page, a playground or an edge runtime bundles
// it. Walked by its imports, file by file, so a new import that pulls in Node's crypto or file system fails
// here and not in a site's build (the site stopped building on 2026-11-20 this way: rules.ts read lifecycle.ts,
// which reads the Store, and finished.ts hashed with node:crypto).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("nothing the browser entry imports, at any depth, is Node's", () => {
  const seen = new Map<string, string>();
  const walk = (file: string, from: string) => {
    if (seen.has(file)) return;
    seen.set(file, from);
    const text = readFileSync(join(src, file), "utf8");
    for (const m of text.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+"([^"]+)"/gms)) {
      const what = m[1] as string;
      // A type-only import is erased and reaches nothing.
      if (/^(?:import|export)\s+type\s/.test(m[0])) continue;
      if (what.startsWith("./")) walk(what.slice(2), file);
      else assert.fail(`${file} imports "${what}" (reached from browser.ts by way of ${seen.get(file) || "itself"})`);
    }
  };
  walk("browser.ts", "");
  assert.ok(seen.size > 5, "the walk read the entry's files");
  assert.ok(!seen.has("store.ts") && !seen.has("lifecycle.ts"), "the Store stays out of a page");
});
