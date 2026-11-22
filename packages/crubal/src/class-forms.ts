// A class is its own keep form (7.7, revision 64). A package need not write a class's lines a second time
// as a form's needs: the engine reads one from the class, named `class:<Class>`. Its fields are the class's
// own lines (the classes it uses have their own), in the class's order and sections; each answer lands on
// its facet by name. A written form is untouched and runs beside it.
import type { ClassLine, Dictionary } from "./defs.ts";
import type { Record } from "./model.ts";
import type { Contract } from "./store.ts";

/** The prefix of a class's own form: `class:Release`. A written contract's name never holds a colon. */
export const CLASS_FORM = "class:";

/** The name of a class's own keep form. */
export const classFormName = (cls: string): string => `${CLASS_FORM}${cls}`;

/** The class a name asks the form of, or undefined where the name is not a class's own form. */
export const classOfForm = (name: string): string | undefined => (name.startsWith(CLASS_FORM) ? name.slice(CLASS_FORM.length) : undefined);

/** Every class a list of worn classes reaches: each, and what each uses, all the way down. */
export function reached(dict: Dictionary, wears: readonly string[]): Set<string> {
  const out = new Set<string>();
  const walk = (name: string) => {
    if (out.has(name)) return;
    out.add(name);
    for (const u of dict.classes.get(name)?.uses ?? []) walk(u);
  };
  for (const w of wears) walk(w);
  return out;
}

/**
 * The lines of a class a record may answer through the class's own form. A line placed at a level
 * (`unit::`) is answered on a record of that level alone, whose own classes or the ones above it reach the
 * class. A line placed nowhere is answered on a record whose own classes reach it. `own` and `above` are
 * the classes the record wears and the ones worn above it (the base class of its kind among its own).
 */
export function classFormLines(dict: Dictionary, cls: string, level: string, own: readonly string[], above: readonly string[] = []): ClassLine[] {
  const c = dict.classes.get(cls);
  if (!c) return [];
  const mine = reached(dict, own).has(cls);
  const over = mine || reached(dict, above).has(cls);
  return c.lines.filter((l) => !!l.facet && (l.level ? l.level === level && over : mine));
}

/**
 * A class's own keep form for a record at `level`: undefined where the class is unknown. Its origin is what
 * a person does at that level: `observed` at the last level of a kind that has more than one (the thing in
 * hand), `declared` anywhere else. Who may run it is not said here: whoever may keep the record through a
 * written keep form of its own (the exchange decides, 7.7).
 */
export function classForm(dict: Dictionary, name: string, r: Pick<Record, "kind" | "level">, own: readonly string[], above: readonly string[] = []): Contract | undefined {
  const cls = classOfForm(name);
  const c = cls === undefined ? undefined : dict.classes.get(cls);
  if (!c || cls === undefined) return undefined;
  const levels = dict.kinds.get(r.kind)?.levels ?? [];
  const inHand = levels.length > 1 && levels.at(-1) === r.level;
  // The line as the record holds it: placed at its own level, it is the record's own key.
  const needs = classFormLines(dict, cls, r.level, own, above).map(({ level: _level, ...l }) => l);
  return {
    name,
    kind: "form",
    role: "keep",
    origin: inHand ? "observed" : "declared",
    reads: needs.map((l) => ({ from: l.facet, to: l.facet, values: [], line: l.line, valueLines: [] })),
    writes: [],
    stores: [],
    terms: {},
    ignore: [],
    keepRaw: [],
    absorb: true,
    lands: "value",
    line: c.line,
    needs,
    gives: [],
    stream: [],
    parts: { for: cls, ...(c.label ? { label: c.label } : {}), class: cls },
    partLines: {},
  };
}
