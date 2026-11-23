// finished.ts: a list a person has said is all of it (1.6, revision 61). Having items says the work started,
// never that it ended: a many-valued key or a part slot is open until someone who may edit the record says it
// is finished. The mark holds what the list was when it was said, so the list is finished only while it is
// still that list: adding or removing an item unsays it, with no write and no hook to forget.
import { serialize } from "./canonical.ts";
import type { Dictionary } from "./defs.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
import { sha256Hex } from "./sha256.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** `parts.<slot>`: the slot an address names, when it names one. */
const slotOf = (address: string) => address.match(/^parts\.(\w+)$/)?.[1];

/** The items a list holds, each by what makes it that item: a row by its key, a plain item by its value. */
function itemsOf(r: Record, address: string, dict: Dictionary): string[] {
  const slot = slotOf(address);
  if (slot) {
    const wears = (r.wears ?? []).flatMap((w) => dict.classes.get(w)?.parts ?? []).find((s) => s.slot === slot)?.wears;
    return (r.parts ?? []).filter(isObj).filter((p) => wears !== undefined && Array.isArray(p.wears) && p.wears.includes(wears)).map((p) => String(p.$row));
  }
  const v = r.values[address];
  if (v === undefined || (isObj(v) && "$empty" in v)) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (isObj(x) && "$row" in x ? String(x.$row) : serialize(x)));
}

/** What a list is, as one short word: the same items give the same word, in any order. */
export function listMark(r: Record, address: string, dict: Dictionary): string {
  const items = itemsOf(r, address, dict).sort();
  return `${items.length}:${sha256Hex(items.join("\n")).slice(0, 16)}`;
}

/** Whether an address may be finished: a many-valued facet, or a part slot of a class the record wears. */
export function finishable(r: Record, address: string, dict: Dictionary): boolean {
  const slot = slotOf(address);
  if (slot) return (r.wears ?? []).some((w) => (dict.classes.get(w)?.parts ?? []).some((s) => s.slot === slot));
  const f = dict.facets.get(address);
  return !!f && (f.many === true || f.type === "compound");
}

/** Say a list is finished: every item there is held. Said by a person, with a source; an intake never says it. */
export function sayFinished(r: Record, address: string, dict: Dictionary, source?: Source): Record {
  if (!finishable(r, address, dict)) throw new Error(`${address} is not a list of ${r.id}: only a many-valued key or a part slot is finished`);
  return { ...r, finished: { ...(r.finished ?? {}), [address]: { of: listMark(r, address, dict), ...(source ? { source } : {}) } } };
}

/** Take the saying back: the list is open again. */
export function unsayFinished(r: Record, address: string): Record {
  if (!r.finished?.[address]) return r;
  const { [address]: _gone, ...rest } = r.finished;
  const { finished: _f, ...bare } = r;
  return Object.keys(rest).length ? { ...bare, finished: rest } : bare;
}

/** Is the list finished now: said so, and still the list it was when that was said. */
export function isFinished(r: Record, address: string, dict: Dictionary): boolean {
  const m = r.finished?.[address];
  return !!m && m.of === listMark(r, address, dict);
}
