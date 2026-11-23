// packages.ts: package files (spec chapter 11). A file may hold several packages, each starting at a
// `package:` line. The checks here are 11.1's prefixes, 11.3's trust entries and 11.4's rule that an
// extending package may add to what it extends but never change it.

import type { JsonObject } from "./model.ts";
import { type Dictionary, emptyDictionary, type Facet, isPrefixedBlock, readDefinitions, unquote } from "./defs.ts";
import { LANGUAGE } from "./read-text.ts";
import { readContracts } from "./store.ts";
import { type Permissions, readAccess } from "./access.ts";
import { readViews } from "./views.ts";
import { CrubalError, innerText, type Node, readTree } from "./tree.ts";
import { type Act, type ActWhen, checkActList, readAct, readWhen, termsOf } from "./acts.ts";

export type PackageInfo = {
  name: string;
  version: string;
  owner: string;
  line: number;
  /** The language version it is written in (11.8), and the line that says so. */
  crubal: number;
  crubalLine: number;
  extends: { name: string; version: string; line: number }[];
  prefixes: Map<string, { target: string; line: number }>;
  trust: { entry: string; line: number }[];
  dict: Dictionary;
  contracts: string[];
  /** The rest of the header (11.1), as written. */
  header: { [key: string]: string };
  terms: { [audience: string]: string };
  /** The utilities the package declares (11.1, `utility:` blocks). */
  utilities: Utility[];
  /** The acts the package declares in words (15, revision 25), beside the utilities' lists of names. */
  acts: Act[];
  /** Revision 58: the blocks the package brings under a prefix (11.9), carried as written and understood by whoever owns the prefix. */
  blocks: PrefixedBlock[];
};

/**
 * Revision 58 (11.9, 13.5): a block under a prefix, `<prefix>:<word>: <name> /<version>`. The engine reads its
 * first line and nothing inside it: `lines` is the inside as written, comments removed, indentation kept
 * relative to the first line. It is a member that holds no value (`block:<prefix>:<word>/<name>`).
 */
export type PrefixedBlock = { sort: string; name: string; version: string; lines: string[]; line: number };

function readPrefixedBlock(node: Node): PrefixedBlock {
  const [name = "", version = ""] = node.value.split(/\s+\//).map((s) => s.trim());
  if (!/^[A-Za-z][\w-]*$/.test(name)) throw new CrubalError(`a prefixed block is "${node.key}: <name> /<version>", the name one word: ${node.value}`, node.line);
  const inside = innerText(node);
  return { sort: node.key as string, name, version, lines: inside ? inside.split("\n") : [], line: node.line };
}

/**
 * A utility block (11.1): a named, versioned tool a platform mounts for the presets, relations or audiences
 * it `serves`, the packages and utilities it `needs`, and the connections and settings a deployment must
 * provide in `setup`. Read like any block; a reader that doesn't know it carries it unchanged (13.5).
 */
export type Utility = {
  name: string;
  version: string;
  /** Revision 32: the group the utility stands in where a room segments its rows (Org, Platform, Services, Clients). */
  group?: string;
  /** Revision 57: whom what the utility stands for belongs to (the place, the platform, a person, an outside service), a surface's own lower-case word; the engine carries it and judges nothing of it. */
  owner?: string;
  label?: string;
  describe?: string;
  /** `curator(ship, returns)` → `{ as: "curator", items: ["ship", "returns"] }`; `controller` → no items. */
  serves: { as: string; items?: string[]; line: number }[];
  /** Package identities (`domain/name`, optionally ` /version`) and bare utility names. */
  needs: { name: string; version?: string; line: number }[];
  setup: ({ connection: string; line: number } | { setting: string; line: number })[];
  /** The acts the utility provides by name (11.1, `acts:`), which a lane's presses may name (12.10). */
  acts: { name: string; line: number }[];
  /** The utility's look wherever it shows (11.1, `mark:`, revision 13): a glyph the mounting app's kit
   * draws and a hue from the eight words. */
  mark?: { glyph: string; hue: Hue; line: number };
  line: number;
};

/** Revision 57: an owner is one lower-case word that belongs to the surface drawing it. */
const ownerWord = (v: string, line: number): string => {
  if (!/^[a-z][a-z0-9-]*$/.test(v)) throw new CrubalError(`owner is one lower-case word, a surface's name for whom the thing belongs to: ${v}`, line);
  return v;
};

/** The eight hue words a mark may name (11.1, revision 13); an app maps each to its own colors. */
export const HUES = ["amber", "blue", "violet", "slate", "teal", "plum", "coral", "olive"] as const;
export type Hue = (typeof HUES)[number];
export const isHue = (v: unknown): v is Hue => typeof v === "string" && (HUES as readonly string[]).includes(v);

const ORIGINS = new Set(["observed", "declared", "derived", "reported"]);
const AUDIENCES = new Set(["public", "member", "staff", "owner"]);

const splitList = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** Split at commas outside parentheses: `controller, curator(ship, returns)` → two pieces. */
function splitServes(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Read one `utility:` block. */
function readUtility(node: Node): Utility {
  const [name = "", version = ""] = node.value.split(/\s+\//).map((s) => s.trim());
  if (!/^[a-z][\w-]*$/.test(name)) throw new CrubalError(`a utility is "utility: <name> /<version>", the name a lower-case word: ${node.value}`, node.line);
  const u: Utility = { name, version, serves: [], needs: [], setup: [], acts: [], line: node.line };
  for (const c of node.children) {
    if (!c.key) continue;
    if (c.key === "label") u.label = unquote(c.value.trim());
    else if (c.key === "describe") u.describe = unquote(c.value.trim());
    else if (c.key === "group") {
      const g = unquote(c.value.trim());
      if (!g) throw new CrubalError("group names the group the utility stands in: a word", c.line);
      u.group = g;
    } else if (c.key === "owner") u.owner = ownerWord(c.value.trim(), c.line);
    else if (c.key === "serves") {
      for (const p of splitServes(c.value)) {
        const m = p.match(/^([A-Za-z][\w-]*)(?:\((.*)\))?$/);
        if (!m) throw new CrubalError(`serves: ${p} is not a name, or a name with items in parentheses`, c.line);
        u.serves.push({ as: m[1] as string, ...(m[2] !== undefined ? { items: splitList(m[2]) } : {}), line: c.line });
      }
    } else if (c.key === "needs") {
      for (const n of splitList(c.value)) {
        const [nm = "", ver] = n.split(/\s+\//).map((s) => s.trim());
        if (!/^([a-z0-9.-]+\/[a-z][\w-]*|[a-z][\w-]*)$/.test(nm)) throw new CrubalError(`needs: ${nm} is not a package identity (domain/name) or a utility name`, c.line);
        u.needs.push({ name: nm, ...(ver ? { version: ver } : {}), line: c.line });
      }
    } else if (c.key === "setup") {
      for (const s of splitList(c.value)) {
        const m = s.match(/^(connection|setting)\s+(\S+)$/);
        if (!m) throw new CrubalError(`setup: ${s} is not "connection <name>" or "setting <facet>"`, c.line);
        u.setup.push(m[1] === "connection" ? { connection: m[2] as string, line: c.line } : { setting: m[2] as string, line: c.line });
      }
    } else if (c.key === "acts") {
      for (const a of splitList(c.value)) {
        if (!/^[a-z][\w-]*$/.test(a)) throw new CrubalError(`acts: ${a} is not a lower-case word`, c.line);
        u.acts.push({ name: a, line: c.line });
      }
    } else if (c.key === "mark") {
      const m = c.value.trim().match(/^([a-z][\w-]*)\s+([a-z]+)$/);
      if (!m) throw new CrubalError(`mark: is "<glyph> <hue>", the glyph a lower-case word and the hue one of ${HUES.join(", ")}: ${c.value.trim()}`, c.line);
      if (!isHue(m[2])) throw new CrubalError(`mark: ${m[2]} is not a hue; the eight are ${HUES.join(", ")}`, c.line);
      u.mark = { glyph: m[1] as string, hue: m[2], line: c.line };
    } else throw new CrubalError(`a utility has label, describe, group, owner, serves, needs, setup, acts and mark, not ${c.key}`, c.line);
  }
  return u;
}

/** Split a file into its packages, keeping line numbers true. */
export function readPackages(source: string): PackageInfo[] {
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((l, i) => (/^package: /.test(l) ? [i] : []));
  return starts.map((start, n) => {
    const end = starts[n + 1] ?? lines.length;
    const text = lines.map((l, i) => (i >= start && i < end ? l : "")).join("\n");
    const [head, ...rest] = readTree(text);
    if (!head) throw new CrubalError("an empty package", start + 1);
    const [name = "", version = ""] = head.value.split(/\s+\//).map((s) => s.trim());
    const info: PackageInfo = { name, version, owner: "", line: head.line, crubal: LANGUAGE, crubalLine: head.line, extends: [], prefixes: new Map(), trust: [], dict: emptyDictionary(), contracts: [], header: {}, terms: {}, utilities: [], acts: [], blocks: [] };
    for (const c of head.children) {
      if (c.key === "owner") info.owner = c.value;
      if (c.key === "crubal") {
        info.crubal = Number(c.value);
        info.crubalLine = c.line;
      }
      if (c.key === "extends") {
        for (const e of c.value.split(",")) {
          const [en = "", ev = ""] = e.trim().split(/\s+\//);
          info.extends.push({ name: en.trim(), version: ev.trim(), line: c.line });
        }
      }
      if (c.key === "prefixes") for (const p of c.children) if (p.key) info.prefixes.set(p.key, { target: p.value, line: p.line });
      if (c.key === "terms") for (const t of c.children) if (t.key) info.terms[t.key] = t.value.trim();
      if (c.key && !["owner", "crubal", "extends", "prefixes", "terms"].includes(c.key)) info.header[c.key] = c.value.trim();
    }
    for (const node of rest) {
      if (node.key === "trust") for (const t of node.children) info.trust.push({ entry: t.text.trim(), line: t.line });
      if (node.key === "utility") {
        const u = readUtility(node);
        if (info.utilities.some((x) => x.name === u.name)) throw new CrubalError(`the utility ${u.name} twice in one package`, node.line);
        info.utilities.push(u);
      }
      if (isPrefixedBlock(node.key)) {
        const b = readPrefixedBlock(node);
        if (info.blocks.some((x) => x.sort === b.sort && x.name === b.name)) throw new CrubalError(`the ${b.sort} ${b.name} twice in one package`, node.line);
        info.blocks.push(b);
      }
      if (node.key === "act") {
        const a = readAct(node);
        if (info.acts.some((x) => x.name === a.name)) throw new CrubalError(`the act ${a.name} twice in one package`, node.line);
        info.acts.push(a);
      }
    }
    // Definitions are everything after the header block.
    const headerEnd = Math.max(start, ...head.children.flatMap(function deep(c): number[] { return [c.line - 1, ...c.children.flatMap(deep)]; }));
    const defs = text.split("\n").map((l, i) => (i > headerEnd ? l : "")).join("\n");
    readDefinitions(defs, info.dict);
    info.contracts = readContracts(defs).map((c) => c.name);
    return info;
  });
}

function sameDefinition(base: Facet, mine: Facet): string | null {
  if (base.type !== mine.type) return "type";
  if (base.pick !== mine.pick) return "pick";
  if ((base.unit ?? "") !== (mine.unit ?? "")) return "unit";
  const baseValues = (base.values ?? []).map((v) => v.value);
  const mineValues = (mine.values ?? []).map((v) => v.value);
  if (mine.values && baseValues.some((v) => !mineValues.includes(v))) return "values";
  return null;
}

/** Check every package in a file (11.1, 11.3, 11.4). Throws the first problem. */
export function checkPackages(source: string): PackageInfo[] {
  // 11.2: a kind's vary step names a level of its kind and facets of this package (a key of another package
  // carries its prefix and is checked where that package is resolved).
  {
    const d = readDefinitions(source);
    for (const [level, keys] of d.vary) {
      if (!d.levels.has(level)) throw new CrubalError(`vary names ${level}, which isn't a level`, d.varyLines.get(level));
      for (const k of keys) if (!k.includes(":") && !d.facets.has(k)) throw new CrubalError(`vary at ${level} names ${k}, which isn't a facet`, d.varyLines.get(level));
    }
    // Revision 35: a level's quantity is a number facet of this package.
    for (const k of d.kinds.values())
      for (const [level, facet] of Object.entries(k.shares ?? {})) {
        const f = d.facets.get(facet);
        if (!f && !facet.includes(":")) throw new CrubalError(`shares at ${level} names ${facet}, which isn't a facet`, k.sharesLine);
        if (f && f.type !== "number") throw new CrubalError(`shares at ${level} names ${facet}, which isn't a number`, k.sharesLine);
      }
  }
  const pkgs = readPackages(source);
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  for (const p of pkgs) {
    // Language versions (11.8): never above this reader's, and never extending a package above one's own.
    if (!Number.isInteger(p.crubal) || p.crubal < 1) throw new CrubalError(`${p.name}: the language version is a whole number`, p.crubalLine);
    if (p.crubal > LANGUAGE) throw new CrubalError(`${p.name} is written in CRUBAL ${p.crubal}; this reader knows ${LANGUAGE}`, p.crubalLine);
    for (const e of p.extends) {
      const base = byName.get(e.name);
      if (base && base.crubal > p.crubal) throw new CrubalError(`${p.name} (CRUBAL ${p.crubal}) extends ${e.name}, written in CRUBAL ${base.crubal}, which it couldn't read`, e.line);
    }
    for (const [prefix, { target, line }] of p.prefixes) {
      if (prefix === "crubal") throw new CrubalError("the prefix crubal is reserved for the core", line);
      if (prefix === p.name && target !== `${p.owner}/${p.name}`) throw new CrubalError(`${p.name} can't map its own name to something else`, line);
    }
    for (const { entry, line } of p.trust) {
      if (entry === "person" || ORIGINS.has(entry)) continue;
      const bare = entry.startsWith(`${p.name}:`) ? entry.slice(p.name.length + 1) : entry;
      if (p.contracts.includes(bare)) continue;
      if (!entry.includes(":") && entry.includes(".")) continue; // a party's domain
      throw new CrubalError(`${entry} is not a contract of this package`, line);
    }
    for (const f of p.dict.facets.values()) {
      const m = f.key.match(/^([a-z][a-z0-9-]*):(.+)$/);
      if (!m || m[1] === "crubal") continue;
      const base = byName.get(m[1] as string);
      if (!base || !p.extends.some((e) => e.name === base.name)) continue;
      const original = base.dict.facets.get(m[2] as string);
      if (!original) continue;
      const changed = sameDefinition(original, f);
      if (changed) throw new CrubalError(`${p.name} changes ${f.key}'s ${changed}; an extending package may only add to it`, f.line);
    }
  }
  checkUtilities(source, pkgs);
  checkActs(source, pkgs);
  checkFormUtilities(source, pkgs);
  return pkgs;
}

/**
 * Utility blocks (11.1): what a utility `serves` is a preset, a relation or an audience the file declares,
 * and the items in parentheses are presets, menu items or relations; a `setting` in `setup` is a facet the
 * file defines. Packages the file doesn't hold are named by prefix and checked where they are resolved.
 */
function checkUtilities(source: string, pkgs: PackageInfo[]): void {
  if (!pkgs.some((p) => p.utilities.length)) return;
  const { perms } = readAccess(source);
  const dict = readDefinitions(source);
  const known = (n: string) => perms.presets.has(n) || perms.relations.has(n) || AUDIENCES.has(n);
  const item = (n: string) => perms.presets.has(n) || perms.menu.has(n) || perms.relations.has(n);
  for (const p of pkgs) {
    for (const u of p.utilities) {
      for (const s of u.serves) {
        if (!known(s.as)) throw new CrubalError(`${u.name} serves ${s.as}, which isn't a preset, relation or audience here`, s.line);
        for (const i of s.items ?? []) if (!item(i)) throw new CrubalError(`${u.name} serves ${s.as}(${i}): ${i} isn't a preset, menu item or relation here`, s.line);
      }
      for (const s of u.setup) if ("setting" in s && !s.setting.includes(":") && !dict.facets.has(s.setting)) throw new CrubalError(`${u.name} needs the setting ${s.setting}, which isn't a facet here`, s.line);
      if (u.needs.some((n) => n.name === u.name)) throw new CrubalError(`${u.name} needs itself`, u.line);
    }
  }
}

/**
 * A form's utility and act (7.7, revision 16): a form names a utility its package declares, an act that
 * utility provides, and no two forms name one act of a utility. File-local, as the lane checks are.
 */
function checkFormUtilities(source: string, pkgs: PackageInfo[]): void {
  const forms = readContracts(source).filter((c) => c.kind === "form" && c.parts.utility !== undefined);
  if (!forms.length) return;
  const utilities = new Map(pkgs.flatMap((p) => p.utilities).map((u) => [u.name, u] as const));
  const taken = new Map<string, string>();
  for (const c of forms) {
    const name = c.parts.utility as string;
    const u = utilities.get(name);
    if (!u) throw new CrubalError(`the form ${c.name} names the utility ${name}, which this package doesn't declare`, c.partLines.utility ?? c.line);
    const act = c.parts.act;
    if (act === undefined) continue;
    if (!u.acts.some((a) => a.name === act)) throw new CrubalError(`the form ${c.name} names the act ${act}, which ${name} doesn't provide`, c.partLines.act ?? c.line);
    const key = `${name}/${act}`;
    const was = taken.get(key);
    if (was) throw new CrubalError(`the forms ${was} and ${c.name} both name the act ${act} of ${name}: one form per act`, c.partLines.act ?? c.line);
    taken.set(key, c.name);
  }
}

/** The file-local act checks (15): strict for a package that extends nothing, deferring what it cannot see otherwise. */
function checkActs(source: string, pkgs: PackageInfo[]): void {
  if (!pkgs.some((p) => p.acts.length)) return;
  const dict = readDefinitions(source);
  for (const p of pkgs)
    checkActList(p.acts, {
      utilities: p.utilities,
      levels: new Set(dict.levels.keys()),
      kinds: new Set(dict.kinds.keys()),
      classes: new Set(dict.classes.keys()),
      facets: new Set(dict.facets.keys()),
      facetOf: (k) => dict.facets.get(k),
      aspects: aspectsOf(dict),
      shares: sharesOf(dict),
      strict: p.extends.length === 0,
      here: "of this package",
    });
}

/** The act checks over the packages in force together (11.4): what a file-local check deferred. */
export function checkActsInForce(p: { info: Pick<PackageInfo, "acts" | "utilities">; dict: Dictionary }): void {
  if (!p.info.acts.length) return;
  checkActList(p.info.acts, {
    utilities: p.info.utilities,
    levels: new Set(p.dict.levels.keys()),
    kinds: new Set(p.dict.kinds.keys()),
    classes: new Set(p.dict.classes.keys()),
    facets: new Set(p.dict.facets.keys()),
    facetOf: (k) => p.dict.facets.get(k),
    aspects: aspectsOf(p.dict),
    shares: sharesOf(p.dict),
    inertTelling: true,
    strict: true,
    here: "in force here",
  });
}

/** Every aspect the kinds declare under `follow:` (11.2, revision 31), which an act's `tells:` may name. */
/** Level → the facet that is its quantity, over every kind's `shares:` (11.2, revision 35). */
export const sharesOf = (dict: Dictionary): Map<string, string> => new Map([...dict.kinds.values()].flatMap((k) => Object.entries(k.shares ?? {})));
const aspectsOf = (dict: Dictionary): Set<string> => new Set([...dict.kinds.values()].flatMap((k) => Object.values(k.follow ?? {}).flat()));
