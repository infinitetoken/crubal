// through.ts: what a record reads through from the record above it (1.7), and the keys its classes place and
// hold at both at a level (5.3.3). Pure: nothing from Node, so the rule engine and the views that read it stay
// usable in a page (the package's browser entry). lifecycle.ts, which lands and merges and so needs the Store,
// says these again for whoever reads them from there.
import type { ClassDef, Dictionary } from "./defs.ts";
import type { Json, JsonObject, Record } from "./model.ts";

const isObjV = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** The keys held at both at a record's level (1.7, 5.3.3 `both`), by the classes named. */
export function bothKeys(dict: Dictionary, wears: string[], level: string): Set<string> {
  const keys = new Set<string>();
  for (const w of wears) for (const l of classLines(dict, w)) if (l.level === level && l.held === "both") keys.add(l.facet);
  return keys;
}

/**
 * The classes a record wears: its kind's base class, whether or not `wears` lists it (5.5), then its own.
 * With the record above, the classes that say what this record holds: the ones above, then its own.
 */
export function wornBy(dict: Dictionary, r: Record | undefined): string[] {
  if (!r) return [];
  const base = dict.kinds.get(r.kind)?.base;
  return [...new Set([...(base ? [base] : []), ...(r.wears ?? [])])];
}

/** Whether a record wears a class: its own, its kind's base, or one of those through what it `uses` (5.5). */
export function wearsClass(dict: Dictionary, r: Record | undefined, cls: string): boolean {
  const seen = new Set<string>();
  const reach = (name: string): boolean => {
    if (name === cls) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (dict.classes.get(name)?.uses ?? []).some(reach);
  };
  return wornBy(dict, r).some(reach);
}

/** The keys the classes named place at a level (5.3.3: a `level::` line declares a vary step beside the kind's own). */
export function placedKeys(dict: Dictionary, wears: string[], level: string): Set<string> {
  const keys = new Set<string>();
  for (const w of wears) for (const l of classLines(dict, w)) if (l.level === level) keys.add(l.facet);
  return keys;
}

/** What a record reads from the values above it: all of them, less the keys held at both at its level. */
export function readThrough(dict: Dictionary | undefined, up: Record, r: Record, above: JsonObject): JsonObject {
  if (!dict) return above;
  const both = bothKeys(dict, [...wornBy(dict, up), ...wornBy(dict, r)], r.level);
  if (!both.size) return above;
  const out = { ...above };
  for (const k of both) delete out[k];
  return out;
}

/** The values above a record under its keys held at both, each at its level's address (`product::qty`, 1.10). */
export function aboveBoth(dict: Dictionary, up: Record, r: Record, above: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const k of bothKeys(dict, [...wornBy(dict, up), ...wornBy(dict, r)], r.level)) if (above[k] !== undefined) out[`${up.level}::${k}`] = above[k] as Json;
  return out;
}

/** A part above as a record at `level` reads it: its values, less the keys its classes hold at both there. */
export function partThrough(dict: Dictionary | undefined, part: JsonObject, level: string): JsonObject {
  if (!dict || !isObjV(part.values)) return part;
  const both = bothKeys(dict, (Array.isArray(part.wears) ? part.wears : []).map(String), level);
  if (!both.size) return part;
  const values = { ...part.values };
  for (const k of both) delete values[k];
  return { ...part, values };
}

/** A class's lines with those of every class it uses, each once. */
export function classLines(dict: Dictionary, name: string, seen = new Set<string>()): ClassDef["lines"] {
  if (seen.has(name)) return [];
  seen.add(name);
  const c = dict.classes.get(name);
  if (!c) return [];
  return [...c.uses.flatMap((u) => classLines(dict, u, seen)), ...c.lines];
}

