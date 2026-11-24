// store.ts: one owner's store on Postgres (docs/design/store.md). An entry is one transaction: lock the
// chain, build the entry, apply it with the engine's applyEntry, persist the difference, append the log.
// The log is the truth; `rebuild` gives every other table back from it.

import { compareVersions } from "@crubal/engine";
import { recordAt } from "@crubal/engine";
import { applyEntry, diffWrites, differs, type Draft, type Entry, type State, MemoryRecords } from "@crubal/engine";
import { type Contract, proposalMet, quorumHolds } from "@crubal/engine";

/** A commit refused by a contract's quorum (7.6): the contract, and the proposal cited if any. */
export class QuorumRefused extends Error {
  readonly contract: string;
  readonly cited: string | undefined;
  constructor(contract: string, cited?: string) {
    super(cited ? `${contract} needs a met proposal; ${cited} is not one` : `${contract} needs a met proposal`);
    this.name = "QuorumRefused";
    this.contract = contract;
    this.cited = cited;
  }
}
import { Engine, serialize } from "@crubal/engine";
import { CrubalError } from "@crubal/engine";
import { Access, type Edge } from "@crubal/engine";
import type { View } from "@crubal/engine";
import { apply, pending, type Store as LifecycleStore } from "@crubal/engine";
import type { Json, JsonObject, Record } from "@crubal/engine";
import { entryHash, verifyChain, writeHash, type Keys } from "@crubal/engine";
import { type Client, type Pool, transaction } from "./db.ts";
import { isObj, loadState, persist, wipeState, recordOf } from "./state.ts";
import { type Facet, type Parsed, readBundle, readBundleOnto, verifyBundle } from "@crubal/engine";
import { classify } from "@crubal/engine";
import { dryRun, restamp, type StepStats } from "@crubal/engine";
import { installsInForce, checkAll, definitionsOf, unitsExtensionOf, workingBundle } from "./definitions.ts";
import { decideReview, type Decision, openItems } from "@crubal/engine";
import { land, receive, type IntakeOutcome } from "@crubal/engine";
import { entriesSince, markStale, type Projecting, publish } from "./projector.ts";
import { copyWorking, loadWhole, Needs, settle, type WorkingRecords, workingState } from "./working.ts";
import type { StreamEntry } from "@crubal/engine";

/** A state's maps copied, so a draft can be changed without touching what was loaded. */
function draftOf(state: State): Draft {
  // A copy of the working state is itself a working state, so the draft notes what it lacks.
  const s = copyWorking(state);
  return { records: s.records, bindings: s.bindings, instructions: s.instructions as Draft["instructions"], edges: s.edges, review: s.reviews };
}

/**
 * A selection of an owner's records (read-api.md 3.1). Every member narrows; each is answered by an index:
 * the envelope's columns, or containment on the values document's GIN.
 */
export type RecordsWhere = {
  level?: string;
  kind?: string;
  /** The parent, or any of several. */
  of?: string | string[];
  /** The placement, or any of several. */
  within?: string | string[];
  /** These records, by id. */
  ids?: string[];
  /** One key's value (as before the read API). */
  key?: [string, Json];
  /** Every one of these keys holds its value (containment: a list holds a value when it contains it). */
  keys?: [string, Json][];
  /** Each of these keys holds some value. */
  has?: string[];
  /** Records whose link names `to` (or any of several), through any of the facets `via` (a single link or a list of them). */
  links?: { to: string | string[]; via: string[] };
};

export type RecordsOptions = {
  limit?: number;
  /** Keyset bounds on `ord`, the order records were first written in. */
  after?: number;
  before?: number;
  /** Newest first (`ord` descending); page with `before`. */
  newest?: boolean;
  /** `false` leaves archived records out. */
  archived?: boolean;
  /** Only these facets' values (and their sources) come back. */
  values?: string[];
};

/** The SQL for a selection: the conditions, their parameters, and a way to add one more. */
function selection(owner: string, where: RecordsWhere, archived: boolean | undefined) {
  const conds = ["owner = $1"];
  const params: unknown[] = [owner];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    conds.push(sql.replaceAll("?", `$${params.length}`));
  };
  const oneOrMany = (col: string, v: string | string[]) => (Array.isArray(v) ? add(`${col} = any(?)`, v) : add(`${col} = ?`, v));
  if (where.level) add("level = ?", where.level);
  if (where.kind) add("kind = ?", where.kind);
  if (where.of !== undefined) oneOrMany('"of"', where.of);
  if (where.within !== undefined) oneOrMany("within", where.within);
  if (where.ids) add("id = any(?)", where.ids);
  // Containment, so the GIN on the values document answers (an equality on `->` would not).
  const pairs = [...(where.key ? [where.key] : []), ...(where.keys ?? [])];
  // One containment per pair, so two values asked of one list key must both be there.
  for (const [k, v] of pairs) add("doc -> 'values' @> ?::jsonb", JSON.stringify({ [k]: v }));
  if (where.has?.length) {
    // `?&` is Postgres's "has every key"; written directly, so the placeholder in `add` does not take its `?`.
    params.push(where.has);
    conds.push(`doc -> 'values' ?& $${params.length}::text[]`);
  }
  if (where.links) {
    const to = Array.isArray(where.links.to) ? where.links.to : [where.links.to];
    // A link is `{ $link: id }`, alone or in a list; either is found by containment (as the linked count is).
    const docs = where.links.via.flatMap((f) => to.flatMap((id) => [JSON.stringify({ [f]: { $link: id } }), JSON.stringify({ [f]: [{ $link: id }] })]));
    add("doc -> 'values' @> any(?::jsonb[])", docs);
  }
  if (archived === false) add("coalesce(status ->> 'state', '') <> ?", "archived");
  return { conds, params, add };
}

export type StoreOptions = {
  /**
   * Whether `state()` and `records.all()` may load an owner's whole state. `refuse` is for a host serving
   * requests: nothing on a request path may be proportional to the catalog (brief 18, the scale rule);
   * rebuild, erase and an install's restamp read whole regardless, since they are what they are.
   */
  wholeState?: "allow" | "refuse";
  chain?: string;
  /** Definitions handed in instead of read from the store's installed bundles and define writes (tests). */
  projecting?: Projecting;
  /** Install an unsigned bundle (development only; refused by default, docs/design/publishing.md). */
  allowUnsigned?: boolean;
  /** How many of the package's own records a dry run reads at a time (5,000 unless said). */
  restampBatch?: number;
  /** Sign each entry's hash with the owner's key (8.5): the host holds the key, the store never sees it. */
  signer?: (hash: string) => string;
  /** Publish every view right after each write commits (`fresh: write`); else the host calls `project`. */
  fresh?: "write" | "asked";
  /** The signer for a person this owner hosts (14.1), made on their first write; the host holds the key. */
  hostedSigner?: (owner: string) => Promise<((hash: string) => string) | undefined>;
};

/** What two definitions of one key must agree on (11.4): the type, the unit, how many, the list of values. */
function facetShape(f: Facet): string {
  const values = Array.isArray(f.values) ? (f.values as { value: string }[]).map((v) => v.value).join("|") : "";
  const pick = f.pick !== undefined && String(f.pick) !== "1" ? `pick ${String(f.pick)}` : "";
  return [f.type, f.unit ?? "", pick, values].filter(Boolean).join(" ");
}

/** Is a record the package's own (10.4): of a kind it defines, or wearing a class it defines? */
function ownRecord(own: Parsed, r: { kind: string; wears?: string[] }): boolean {
  return own.dict.kinds.has(r.kind) || (r.wears ?? []).some((w) => own.dict.classes.has(w));
}

/**
 * The records a package's recipes restamp (10.4), asked for by name from a working set: the records of
 * each kind it defines and the wearers of each class, so a draft loads those and nothing else. Reading the
 * catalog whole and filtering it down read a million records into memory for a recipe over a dozen
 * (Media Encyclopedia's storefront install, 2026-10-22).
 */
function ownRecordsOf(records: { forTarget(name: string): Record[] }, own: Parsed): Record[] {
  const seen = new Set<string>();
  const out: Record[] = [];
  for (const name of [...own.dict.kinds.keys(), ...own.dict.classes.keys()]) {
    for (const r of records.forTarget(name)) {
      if (seen.has(r.id) || !ownRecord(own, r)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/**
 * The views a pin move can have changed, so only those are marked stale (12.6): a view whose own
 * definition, a shape or a filter it names changed between the two versions, or that reads a facet that
 * changed (in its order, pins, index, a slot, a filter, its condition); every view when a rule or the
 * permissions changed, since rows carry what rules produce and are cut per audience. What the recipes
 * restamped the commit marked itself. Marking every view of a million-record store for a version that
 * moved nothing queued 2.4 million rows to rebuild (Media Encyclopedia's storefront install, 2026-10-22).
 */
function viewsChangedBy(previous: JsonObject, next: JsonObject, p: Projecting): View[] | "all" {
  if (serialize((previous.permissions ?? {}) as Json) !== serialize((next.permissions ?? {}) as Json)) return "all";
  const changed = classify(previous, next).filter((c) => c.kind !== "unchanged").map((c) => c.member);
  if (!changed.length) return [];
  const of = (member: string) => new Set(changed.filter((m) => m.startsWith(`${member}:`)).map((m) => m.slice(member.length + 1)));
  const facets = of("facet");
  // A rule that changed names its facets in its words (`then: note shown to staff`, `when: qty is 0`): the
  // views reading those facets rebuild; a rule naming no facet of the dictionary marks nothing more.
  const members = new Map<string, JsonObject>();
  for (const b of [previous, next]) for (const r of (b.rules as JsonObject[] | undefined) ?? []) if (r && typeof r.rule === "string") members.set(`rule:${r.rule}`, r);
  const keys = new Set<string>([...p.dict.facets.keys()]);
  for (const name of of("rule")) {
    const r = members.get(`rule:${name}`);
    const words = JSON.stringify(r ?? {}).match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    for (const w of words) if (keys.has(w)) facets.add(w);
  }
  const shapes = of("shape");
  const filters = of("filter");
  const views = of("view");
  // The facet an address starts from: `audioTracks[*].language` reads audioTracks.
  const keyOf = (address: string) => address.split(/[.[]/)[0] ?? address;
  const touched = (v: View): boolean => {
    if (views.has(v.name) || v.shapes.some((n) => shapes.has(n)) || v.filters.some((n) => filters.has(n))) return true;
    if (!facets.size) return false;
    const reads = new Set<string>([...v.order.map((o) => keyOf(o.key)), ...v.pin.map(keyOf), ...v.hide.map(keyOf), ...v.index.map(keyOf)]);
    if (v.list) reads.add(keyOf(v.list));
    for (const n of v.shapes) for (const slot of p.views.shapes.get(n)?.slots ?? []) reads.add(keyOf(slot.from));
    for (const n of v.filters) {
      const f = p.views.filters.get(n);
      if (!f) continue;
      reads.add(f.facet);
      for (const x of [...f.sums, ...f.dependent]) reads.add(keyOf(x));
    }
    for (const k of reads) if (facets.has(k)) return true;
    return !!v.when && [...facets].some((k) => new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`).test(v.when as string));
  };
  return [...p.views.views.values()].filter(touched);
}

/** The recipes of a package that lie between two versions, oldest first (10.1): `from` at or after the installed version, `to` at or before the new one. */
function recipesBetween<R extends { from: string; to: string }>(recipes: R[], pkg: string, installed: string, target: string): R[] {
  const version = (s: string) => s.slice(s.lastIndexOf("/") + 1);
  return recipes
    .filter((r) => r.from.startsWith(`${pkg} /`) && compareVersions(version(r.from), installed) >= 0 && compareVersions(version(r.to), target) <= 0)
    .sort((a, b) => compareVersions(version(a.from), version(b.from)));
}

/** The records an entry's writes name (revision 50), each once. */
function touchedBy(entry: Entry): string[] {
  const out = new Set<string>();
  for (const w of Array.isArray(entry.writes) ? entry.writes : []) if (w && typeof w === "object" && !Array.isArray(w) && typeof w.record === "string") out.add(w.record);
  return [...out];
}

export class PgStore {
  readonly pool: Pool;
  readonly owner: string;
  readonly chain: string;
  readonly options: StoreOptions;

  constructor(pool: Pool, owner: string, options: StoreOptions | string = {}) {
    this.pool = pool;
    this.owner = owner;
    this.options = typeof options === "string" ? { chain: options } : options;
    this.chain = this.options.chain ?? "main";
  }

  /**
   * Publish the views whose rows a write made stale (12.6): every view, or the named one, for its own
   * audience or the one given. Runs outside any write transaction. Returns the stream entries published.
   */
  async project(view?: string, audience?: string, only?: (v: View) => boolean): Promise<StreamEntry[]> {
    const p = await this.projecting();
    if (!p) throw new Error("the store has no views to project");
    const names = view ? [view] : [...p.views.views.values()].filter((v) => !only || only(v)).map((v) => v.name);
    const out: StreamEntry[] = [];
    // Appended one by one: a first publish of a large view is hundreds of thousands of entries, more than a spread takes.
    for (const name of names) for (const e of await transaction(this.pool, (client) => publish(client, this.owner, p, name, audience))) out.push(e);
    return out;
  }

  /**
   * Publish every view whole next time, with a reset on each stream (12.6.2): an index that lost rows, or
   * kept rows nothing removed, is brought back to what the store holds. The named view alone when given.
   */
  async republish(view?: string): Promise<void> {
    const p = await this.projecting();
    if (!p) return;
    for (const v of p.views.views.values()) {
      if (view && v.name !== view) continue;
      await this.pool.query("insert into published (owner, view, audience, version) values ($1, $2, $3, '*') on conflict (owner, view, audience) do update set version = '*'", [this.owner, v.name, v.show]);
    }
  }

  /** The head of a view's stream for an audience (12.6.2): the last sequence number published, 0 when none. */
  async streamHead(view: string, audience?: string): Promise<number> {
    const p = await this.projecting();
    const v = p?.views.views.get(view);
    if (!v) throw new Error(`no view ${view}`);
    const { rows } = await this.pool.query("select coalesce(max(seq), 0) as seq from projection_stream where owner = $1 and view = $2 and audience = $3 and version = $4", [this.owner, view, audience ?? v.show, v.version ?? ""]);
    return Number((rows[0] as { seq: string | number }).seq);
  }

  /** The entries of a view's stream after `seq` (12.6.2). */
  async entriesSince(view: string, seq: number, audience?: string, limit?: number): Promise<StreamEntry[]> {
    const p = await this.projecting();
    if (!p) throw new Error("the store has no views");
    const client = await this.pool.connect();
    try {
      return await entriesSince(client, this.owner, p, view, seq, audience, limit);
    } finally {
      client.release();
    }
  }

  /** After a persist: mark what the entry made stale, inside the same transaction. */
  private async afterPersist(client: Client, before: State, after: State, seq: number, parsed?: Parsed): Promise<void> {
    const p = this.options.projecting ?? (parsed ? projectingOf(parsed) : await this.projectingFrom(client));
    if (p?.views.views.size && !this.skipStale) await markStale(client, this.owner, p, before, after, seq);
  }

  private async freshen(): Promise<void> {
    if (this.quiet) return;
    // Views with `fresh: write` publish now (12.6); a view with a delay waits for the loop.
    if (this.options.fresh === "write" && (await this.projecting())?.views.views.size) await this.project(undefined, undefined, (v) => v.fresh === "write");
  }

  /** Set while a bulk load runs: the per-commit publish waits for the one publish at the end. */
  private quiet = false;
  /** A bulk load that republishes at the end marks nothing stale per batch (load, `stale: false`). */
  private skipStale = false;

  /**
   * Load many records as the owner's own, in batches: one entry per batch, each record set whole with its
   * `sources` (or the `origin` given), the checks, rules and stale marks of a commit applying to every one;
   * the views publish once at the end. For a conversion or a migration (brief 18 step 1): a million rows
   * in an afternoon, not a day per hundred thousand through arrivals.
   */
  async load(records: Record[], by: JsonObject, opts: { batch?: number; at?: string; origin?: string; publish?: boolean; stale?: boolean } = {}): Promise<{ entries: string[]; records: number; published: number }> {
    const size = Math.max(1, Math.floor(opts.batch ?? 500));
    const entries: string[] = [];
    this.quiet = true;
    // `stale: false` marks nothing stale per batch: a conversion republishes every view at the end (12.6), and
    // marking a million rows one write at a time is the slowest thing a bulk load would do.
    this.skipStale = opts.stale === false;
    try {
      for (let i = 0; i < records.length; i += size) {
        const slice = records.slice(i, i + size);
        // Each record's values cite the entry that lands them (8.5), unless the record brings its own sources.
        const { rows } = await this.pool.query("select head_seq from chains where owner = $1 and chain = $2", [this.owner, this.chain]);
        const via = `L-${(rows.length ? Number((rows[0] as { head_seq: string | number }).head_seq) : 0) + 1}`;
        const e = await this.commit(
          by,
          (d) => {
            for (const r of slice) {
              const sources = r.sources ?? { "*": { origin: opts.origin ?? "reported", via } };
              d.records.set(r.id, { ...r, owner: r.owner ?? this.owner, sources } as Record);
            }
          },
          opts.at,
        );
        if (e) entries.push(String(e.log));
      }
    } finally {
      this.quiet = false;
      this.skipStale = false;
    }
    const published = opts.publish === false ? 0 : (await this.project()).length;
    return { entries, records: records.length, published };
  }

  // ─── Definitions from the store (docs/design/publishing.md) ────────────────

  private defsCache: { seq: number; parsed: Parsed } | undefined;

  /** The definitions in force: installed bundles in order, then the owner's define writes. Cached per chain head. */
  async definitions(fresh = false): Promise<Parsed> {
    const client = await this.pool.connect();
    try {
      return await this.definitionsFrom(client, fresh);
    } finally {
      client.release();
    }
  }

  /** The caller's own copy for an install's trial: `replacing` is the package taking a new version (see definitionsOf). */
  private async trialDefinitions(replacing?: string): Promise<Parsed> {
    const client = await this.pool.connect();
    try {
      return await definitionsOf(client, this.owner, [], true, replacing);
    } finally {
      client.release();
    }
  }

  /** `fresh` builds the caller's own copy to try a change on (a trial reads onto it and must not touch the shared cache). */
  private async definitionsFrom(client: Client, fresh = false): Promise<Parsed> {
    if (fresh) return definitionsOf(client, this.owner, [], true);
    const { rows } = await client.query("select head_seq from chains where owner = $1 and chain = $2", [this.owner, this.chain]);
    const seq = rows.length ? Number((rows[0] as { head_seq: string | number }).head_seq) : 0;
    if (this.defsCache && this.defsCache.seq === seq) return this.defsCache.parsed;
    const parsed = await definitionsOf(client, this.owner);
    this.defsCache = { seq, parsed };
    return parsed;
  }

  /** What the store projects with: handed in, else built from its definitions. */
  async projecting(): Promise<Projecting | undefined> {
    if (this.options.projecting) return this.options.projecting;
    const client = await this.pool.connect();
    try {
      return await this.projectingFrom(client);
    } finally {
      client.release();
    }
  }

  private async projectingFrom(client: Client): Promise<Projecting | undefined> {
    if (this.options.projecting) return this.options.projecting;
    return projectingOf(await this.definitionsFrom(client));
  }

  /**
   * Install a published version (docs/design/publishing.md): verify the hash and signature, require the
   * language version at or below ours and every extended package installed at its pinned version, write
   * the install entry and keep the bundle, restamp through the recipes when an earlier version was
   * installed, and check the definitions that result. Refused whole on any failure.
   */
  async install(bundle: JsonObject, keys?: Keys, at?: string, opts: { budgetMs?: number } = {}): Promise<Entry> {
    if (!bundle.sig && !this.options.allowUnsigned) throw new Error(`${bundle.id}: unsigned bundles are refused; a store may allow them for development`);
    const v = verifyBundle(bundle, bundle.sig ? keys : undefined);
    if (!v.valid) throw new Error(`${bundle.id}: the bundle doesn't verify (${v.reason})`);
    if (Number(bundle.crubal ?? 2) > 2) throw new Error(`${bundle.id} is written in CRUBAL ${bundle.crubal}, above this store's`);
    const installed = await this.installed();
    const have = (pkg: string) => installed.filter((i) => i.package === pkg).map((i) => String(i.version));
    for (const e of (bundle.extends as JsonObject[] | undefined) ?? []) {
      // Named by short name within the bundle's own publisher, or by id across publishers.
      const dep = String(e.package).includes("/") ? String(e.package) : `${bundle.owner}/${e.package}`;
      // A pin names the least version (11.4): a later one held satisfies it, since a revision only adds.
      if (!have(dep).some((v) => compareVersions(v, String(e.version)) >= 0)) throw new Error(`${bundle.id} extends ${e.package} /${e.version}, which isn't installed`);
    }
    const previous = have(String(bundle.id)).at(-1);
    if (previous === bundle.version) throw new Error(`${bundle.id} /${bundle.version} is already installed`);
    const prevBundle = previous ? ((await this.pool.query("select json from bundles where owner = $1 and package = $2 and version = $3", [this.owner, bundle.id, previous])).rows[0] as { json: JsonObject } | undefined)?.json : undefined;
    // The definitions that would result must pass every publish check before anything is written.
    // What will stand: every other package in force, and of this package's version in force its definitions
    // alone. Its other members are replaced whole by the new version, so a contract the new version dropped is
    // not checked again (it could name a key another package has since retired, and refuse every replacement).
    const current = await this.trialDefinitions(previous ? String(bundle.id) : undefined);
    const next = readBundleOnto(bundle, current);
    checkAll(next);
    // One dictionary (11.4): a facet another installed package defines with a different type is a collision,
    // refused here rather than letting the later definition silently win.
    const own = readBundle(bundle);
    {
      // Against each other package's version in force; a key this package's installed version already
      // defined the same way is no new collision (so two packages can unwind one, each in its turn).
      const { rows: others } = await this.pool.query("select distinct on (package) package, json from bundles where owner = $1 and package <> $2 order by package, version desc", [this.owner, bundle.id]);
      const before = prevBundle ? readBundle(prevBundle).dict.facets : new Map<string, { type: string }>();
      for (const o of others as { package: string; json: JsonObject }[]) {
        const theirs = readBundle(o.json).dict.facets;
        for (const [key, f] of own.dict.facets) {
          const t = theirs.get(key);
          if (!t) continue;
          const mine = facetShape(f);
          if (mine !== facetShape(t) && (!before.get(key) || facetShape(before.get(key) as Facet) !== mine)) throw new Error(`${bundle.id} /${bundle.version} defines ${key} as ${mine}, but ${o.package} defines it as ${facetShape(t)}; one dictionary, one key`);
        }
      }
    }
    // A version may not take away a preset or item that live edges still grant (14.12): lapse or regrant first.
    if (previous) {
      const was = prevBundle ? readBundle(prevBundle).perms : current.perms;
      const own = readBundle(bundle).perms;
      const gone = new Set([...was.presets.keys(), ...was.menu.keys()].filter((n) => !own.presets.has(n) && !own.menu.has(n)));
      if (gone.size) {
        const now = at ?? new Date().toISOString();
        const holding = [...installed.length ? (await this.edges()) : []].filter((e) => (!e.until || String(e.until) > now) && (e.grants as string[] | undefined)?.some((g) => gone.has(g)));
        if (holding.length) throw new Error(`${bundle.id} /${bundle.version} drops ${[...gone].join(", ")}, which ${holding.map((e) => String(e.edge)).join(", ")} still grant; lapse or regrant them first`);
      }
    }
    // A restamp over more records than one batch holds (a package whose kinds are the catalog) does not run
    // inside the install's entry: the pin moves in that entry, and the records are restamped afterwards in
    // batches, each its own entry, resumable after any interruption (`continueRestamp`), so no function ever
    // holds the catalog, and a budget can stop between batches and the next pass carry on.
    const batchSize = Math.max(1, this.options.restampBatch ?? 5000);
    const steppedRecipes = previous ? recipesBetween(next.recipes, String(bundle.package), previous, String(bundle.version)).filter((r) => r.steps.length) : [];
    const deferred = steppedRecipes.length > 0 && (await this.countOwnRecords(own, batchSize + 1)) > batchSize;
    // The bundle goes in first: the entry's own transaction rebuilds definitions from it. A refused install takes it out again.
    await this.pool.query("insert into bundles (owner, package, version, hash, json) values ($1, $2, $3, $4, $5) on conflict (owner, package, version) do update set hash = excluded.hash, json = excluded.json", [this.owner, bundle.id, bundle.version, bundle.hash, bundle]);
    let result: { entry: Entry | null; out: null };
    this.walking = true;
    try {
      result = await this.commitFrom((draft) => {
      const extra: JsonObject[] = [{ install: { package: String(bundle.id), version: String(bundle.version), hash: String(bundle.hash) } }];
      // A pin move restamps through every recipe between the installed version and this one (10.1, 10.4),
      // in order: a store two versions behind takes both steps, never only the first.
      if (previous && !deferred) {
        const parsedRecipes = recipesBetween(next.recipes, String(bundle.package), previous, String(bundle.version));
        for (const recipe of parsedRecipes) {
          // A recipe with no steps (a pin move, 10.1) restamps nothing and reads nothing: a package whose kinds
          // are the catalog (994,000 items and works at one owner, 2026-10-23) must not be loaded to move a pin.
          if (!recipe.steps.length) continue;
          // A recipe restamps what the store holds for the package (10.4): records of its kinds and records wearing its classes.
          const records = ownRecordsOf(draft.records, own);
          const { records: after, review } = restamp(records, recipe, next.dict);
          for (const r of after) draft.records.set(r.id, r);
          for (const item of review) draft.review.push({ ...item, step: item.step, migration: `${recipe.from} -> ${recipe.to}` });
        }
      }
      // The version's instruction blocks (10.7) are issued here; drain applies them record by record.
      for (const block of (bundle.instructions as JsonObject[] | undefined) ?? []) {
        const issuer = String(block.issuer);
        const list = (block.instructions as JsonObject[] | undefined) ?? [];
        if (list.length) draft.instructions.set(issuer, [...(draft.instructions.get(issuer) ?? []), ...list.map((i) => ({ ...i, issuer }))]);
      }
      const by: JsonObject = previous ? { migration: `${bundle.package} /${previous} -> ${bundle.package} /${bundle.version}` } : { person: "owner" };
      return { by, extra, out: null };
      }, at, {}, next);
    } catch (e) {
      // The bundle goes only when the entry did not: an install whose projection failed after its entry
      // committed kept the entry and lost the bundle, and the store then read "installed but its bundle is
      // missing" on every definitions read (the brief 37 rehearsal, 2026-10-27).
      const stands = (await this.installed().catch(() => [])).some((i) => i.package === bundle.id && String(i.version) === String(bundle.version));
      if (!stands) await this.pool.query("delete from bundles where owner = $1 and package = $2 and version = $3", [this.owner, bundle.id, bundle.version]);
      throw e;
    } finally {
      this.walking = false;
    }
    if (!result.entry) throw new Error("the install wrote nothing");
    this.defsCache = undefined;
    if (previous) {
      const p = await this.projecting();
      const which = prevBundle && p ? viewsChangedBy(prevBundle, bundle, p) : "all";
      if (which === "all" || which.length) await this.staleAll((sql, params) => this.pool.query(sql, params), p, which === "all" ? undefined : which);
    }
    if (deferred && previous) {
      await this.restampsReady();
      await this.pool.query(
        "insert into restamps (owner, package, version, from_version, after_ord, restamped, review, done, started) values ($1, $2, $3, $4, -1, 0, 0, false, $5) on conflict (owner, package, version) do update set from_version = excluded.from_version, after_ord = -1, restamped = 0, review = 0, done = false, started = excluded.started, finished = null",
        [this.owner, bundle.id, bundle.version, previous, at ?? new Date().toISOString()],
      );
      await this.continueRestamp(String(bundle.id), String(bundle.version), { ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}), ...(at ? { at } : {}) });
    }
    return result.entry;
  }

  /** How many records the package's recipes would restamp, up to a limit: enough to know whether one batch holds them. */
  private async countOwnRecords(own: Parsed, limit: number): Promise<number> {
    const kinds = [...own.dict.kinds.keys()];
    const classes = [...own.dict.classes.keys()];
    if (!kinds.length && !classes.length) return 0;
    const { rows } = await this.pool.query("select count(*)::int as n from (select 1 from records where owner = $1 and (kind = any($2::text[]) or wears && $3::text[]) limit $4) t", [this.owner, kinds, classes, limit]);
    return Number((rows[0] as { n: number }).n);
  }

  /** The table of restamps in progress, made once per process for a store migrated before it existed. */
  private restampsTable: Promise<void> | undefined;
  private restampsReady(): Promise<void> {
    this.restampsTable ??= this.pool
      .query("create table if not exists restamps (owner text not null, package text not null, version text not null, from_version text not null, after_ord bigint not null default -1, restamped integer not null default 0, review integer not null default 0, done boolean not null default false, started text, finished text, primary key (owner, package, version))")
      .then(() => undefined);
    return this.restampsTable;
  }

  /** The restamps this owner has not finished: an install whose records are still being walked. */
  async pendingRestamps(): Promise<{ package: string; version: string; from: string; afterOrd: number; restamped: number; review: number; started?: string }[]> {
    await this.restampsReady();
    const { rows } = await this.pool.query("select package, version, from_version, after_ord, restamped, review, started from restamps where owner = $1 and not done order by started", [this.owner]);
    return (rows as { package: string; version: string; from_version: string; after_ord: string | number; restamped: number; review: number; started: string | null }[]).map((r) => ({ package: r.package, version: r.version, from: r.from_version, afterOrd: Number(r.after_ord), restamped: Number(r.restamped), review: Number(r.review), ...(r.started ? { started: r.started } : {}) }));
  }

  /**
   * Carry a deferred restamp on (10.4): the package's own records after the last one done, in batches by ord,
   * each batch through every stepped recipe between the versions and committed as one entry (the records
   * that changed and the items for review), the progress written after each; it stops when the budget is
   * spent and picks up where it left off next time. Done when a batch comes up short.
   */
  async continueRestamp(pkg: string, version: string, opts: { budgetMs?: number; at?: string } = {}): Promise<{ done: boolean; restamped: number; review: number; batches: number }> {
    await this.restampsReady();
    const { rows: progress } = await this.pool.query("select from_version, after_ord, restamped, review, done from restamps where owner = $1 and package = $2 and version = $3", [this.owner, pkg, version]);
    const row = progress[0] as { from_version: string; after_ord: string | number; restamped: number; review: number; done: boolean } | undefined;
    if (!row) throw new Error(`${pkg} /${version}: no restamp is pending for ${this.owner}`);
    let restamped = Number(row.restamped);
    let review = Number(row.review);
    if (row.done) return { done: true, restamped, review, batches: 0 };
    const { rows: bundles } = await this.pool.query("select json from bundles where owner = $1 and package = $2 and version = $3", [this.owner, pkg, version]);
    const bundle = (bundles[0] as { json: JsonObject } | undefined)?.json;
    if (!bundle) throw new Error(`${pkg} /${version} is not installed for ${this.owner}`);
    const p = await this.definitions(true);
    const own = readBundle(bundle);
    const recipes = recipesBetween(p.recipes, String(bundle.package), row.from_version, version).filter((r) => r.steps.length);
    const kinds = [...own.dict.kinds.keys()];
    const classes = [...own.dict.classes.keys()];
    const size = Math.max(1, this.options.restampBatch ?? 5000);
    const migration = `${bundle.package} /${row.from_version} -> ${bundle.package} /${version}`;
    const started = Date.now();
    let after = Number(row.after_ord);
    let batches = 0;
    const finish = async (done: boolean) => {
      await this.pool.query("update restamps set after_ord = $4, restamped = $5, review = $6, done = $7, finished = case when $7 then $8 else null end where owner = $1 and package = $2 and version = $3", [this.owner, pkg, version, after, restamped, review, done, opts.at ?? new Date().toISOString()]);
      return { done, restamped, review, batches };
    };
    this.walking = true;
    try {
      for (;;) {
        if (opts.budgetMs !== undefined && batches > 0 && Date.now() - started >= opts.budgetMs) return await finish(false);
        const { rows } = await this.pool.query("select * from records where owner = $1 and (kind = any($2::text[]) or wears && $3::text[]) and ord > $4 order by ord limit $5", [this.owner, kinds, classes, after, size]);
        if (!rows.length) return await finish(true);
        const list = rows as { [column: string]: unknown }[];
        const before = list.map((r) => recordOf(r));
        // A record counts as changed by its values, its classes or its parts (a parts recipe adds rows, 2026-10-27).
        const was = new Map(before.map((r) => [r.id, JSON.stringify([r.values, r.wears ?? [], r.parts ?? []])]));
        let current = before;
        const items: JsonObject[] = [];
        for (const recipe of recipes) {
          const r = restamp(current, recipe, p.dict);
          current = r.records;
          for (const item of r.review) items.push({ ...item, step: item.step, migration });
        }
        const changed = current.filter((r) => was.get(r.id) !== JSON.stringify([r.values, r.wears ?? [], r.parts ?? []]));
        if (changed.length || items.length)
          await this.commit(
            { migration },
            (d) => {
              // The record is read into the working set before it is set, so the entry's writes are the change and not a creation.
              // The restamped members land on the record as the commit finds it, not on the copy the batch read a
              // moment ago: another hand (the drain stamping `applied`, a form) may have written it between the two,
              // and a draft built on the stale copy failed the log's own check and stalled the walk (2026-10-27).
              // So the recipes run again here, on the live record (restamp is pure and cheap per record); a record
              // the working set has not loaded yet comes on the next pass of the settle.
              const seen: JsonObject[] = [];
              for (const r of changed) {
                const live = d.records.get(r.id);
                if (!live) continue;
                let cur: Record[] = [live];
                for (const recipe of recipes) {
                  const out = restamp(cur, recipe, p.dict);
                  cur = out.records;
                  for (const item of out.review) seen.push({ ...item, step: item.step, migration });
                }
                d.records.set(r.id, cur[0] as Record);
              }
              for (const item of seen) d.review.push(item);
            },
            opts.at,
          );
        restamped += changed.length;
        review += items.length;
        batches += 1;
        after = Number(list[list.length - 1]?.ord);
        if (rows.length < size) return await finish(true);
        await finish(false);
      }
    } finally {
      this.walking = false;
    }
  }

  /**
   * Mark every row of every view stale: after a reinstall or a rebuild the next publish rebuilds and
   * compares every row and announces what left, and the stream keeps its numbering. (Wiping the stored
   * rows instead, as before 0.1.16, made the next publish a first one, which announces no removals, so an
   * index kept rows nothing ever removed: ME's index held three versions of its shop.)
   */
  private async staleAll(run: (sql: string, params: unknown[]) => Promise<unknown>, p: Projecting | undefined, only?: View[]): Promise<void> {
    if (!p) return;
    for (const v of only ?? p.views.views.values()) {
      await run(`insert into stale (owner, view, record, since) select $1, $2, id, 0 from records where owner = $1${v.level ? " and level = $3" : ""} on conflict do nothing`, v.level ? [this.owner, v.name, v.level] : [this.owner, v.name]);
      await run("insert into stale (owner, view, record, since) select owner, view, record, 0 from projections where owner = $1 and view = $2 on conflict do nothing", [this.owner, v.name]);
    }
  }

  /** Well-formed access (14.12) on what an entry changed: ownership, wearing, within, and every edge written. */
  /**
   * What the rules produce for the records an operation changed, and for their ancestors (6.4): a plain
   * write runs the productions as a border run does, so a rollup over units follows a unit written by the
   * owner's own commit. Derived values land in the draft with their rule as source, so the entry's writes
   * carry them like any other value; a person's value is never overwritten.
   */
  /** Records a `rederive` asks for, derived whether or not the operation changed them. */
  private alsoDerive?: Set<string>;

  /**
   * Run the productions over records as they stand (6.4), for records written before a rule existed: one
   * entry per call, holding only the derived values that changed. The ids are loaded into the working set
   * and derived with their ancestors; nothing else is written.
   */
  async rederive(ids: string[], by: JsonObject = { platform: "rederive" }, at?: string): Promise<Entry | null> {
    if (!ids.length) return null;
    this.alsoDerive = new Set(ids);
    try {
      return (await this.commitFrom((d) => { for (const id of ids) d.records.get(id); return { by, extra: [], out: null }; }, at)).entry;
    } finally {
      this.alsoDerive = undefined;
    }
  }

  private derive(p: Parsed, before: State, draft: Draft): void {
    if (!p.rules.some((r) => r.produces)) return;
    const changed: string[] = [];
    for (const [id, r] of draft.records) {
      const was = before.records.get(id);
      if (!was || serialize(was.values) !== serialize(r.values) || serialize(was.status ?? {}) !== serialize(r.status ?? {})) changed.push(id);
    }
    for (const id of this.alsoDerive ?? []) if (!changed.includes(id)) changed.push(id);
    if (!changed.length) return;
    const engine = new Engine(p.dict, p.rules, () => draft.records);
    for (const [, r] of draft.records) engine.put(r);
    const land = (id: string): boolean => {
      const rec = draft.records.get(id);
      if (!rec || rec.status?.state === "archived") return false;
      // What the record reads from above (1.7) must be in the engine: the chain up along `of`, asked for by
      // id so a working set loads just those, never the catalog.
      const seen = new Set<string>([id]);
      for (let up = rec.of ? draft.records.get(rec.of) : undefined; up && !seen.has(up.id); up = up.of ? draft.records.get(up.of) : undefined) {
        seen.add(up.id);
        engine.put(up);
      }
      engine.put(rec);
      const derived = engine.reproduce(id).filter((x) => (x.result === "derived" || x.result === "filled") && x.address && x.value !== undefined && x.rule);
      let moved = false;
      const values = { ...rec.values };
      const sources = { ...(rec.sources ?? {}) };
      for (const x of derived) {
        const address = x.address as string;
        if (serialize(values[address] ?? "∅") === serialize(x.value as Json)) continue;
        values[address] = x.value as Json;
        sources[address] = { origin: "derived", via: x.rule as string };
        moved = true;
      }
      if (!moved) return false;
      const next = { ...rec, values, sources } as Record;
      draft.records.set(id, next);
      engine.put(next);
      return true;
    };
    for (const id of changed) {
      land(id);
      if (engine.readsLowerLevels) for (const up of engine.ancestorsOf(id)) land(up);
      // What the record links to, and linked to before, is counted again (6.4, revision 68).
      if (engine.readsLinked) for (const to of engine.linkTargetsOf(before.records.get(id), draft.records.get(id))) land(to);
    }
  }

  private checkWrites(p: Parsed, entry: Entry, after: State): void {
    const writes = (Array.isArray(entry.writes) ? entry.writes : []) as JsonObject[];
    const touched = new Set(writes.map((w) => (typeof w.record === "string" ? w.record : "")).filter(Boolean));
    const edges = writes.filter((w) => isObj(w.edge)).map((w) => w.edge as unknown as Edge);
    if (!touched.size && !edges.length) return;
    const access = new Access(p.dict, p.perms, after.records, [...after.edges.values()] as unknown as Edge[], this.owner);
    for (const id of touched) {
      const r = after.records.get(id);
      if (!r) continue;
      access.checkOwnership(r);
      access.checkWears(r);
      // Within: the chain up from this record only, never a scan of the catalog.
      const seen = new Set<string>([id]);
      let cur = r.within;
      while (cur) {
        if (seen.has(cur)) throw new CrubalError(`${id} is within itself through ${cur}`);
        seen.add(cur);
        const up = after.records.get(cur);
        if (up && up.owner !== r.owner) throw new CrubalError(`${id} is within ${cur}, which belongs to ${up.owner}: within never crosses owners`);
        cur = up?.within;
      }
    }
    // An emergency edge is checked by the host against the platform's published terms (14.13), not here.
    for (const e of edges) if (e.relation !== "emergency") access.checkEdge(e);
  }

  /** One record by id, from its row alone (no whole state): undefined when there is none. */
  async get(id: string): Promise<Record | undefined> {
    const { rows } = await this.pool.query("select * from records where owner = $1 and id = $2", [this.owner, id]);
    return rows[0] ? recordOf(rows[0] as { [column: string]: unknown }) : undefined;
  }

  /** Several records by id in one statement, in no particular order; ids with no record are left out. */
  async getMany(ids: string[]): Promise<Record[]> {
    if (!ids.length) return [];
    const { rows } = await this.pool.query("select * from records where owner = $1 and id = any($2)", [this.owner, ids]);
    return rows.map((r) => recordOf(r as { [column: string]: unknown }));
  }

  /** The review items still open (9.5). */
  async review(): Promise<JsonObject[]> {
    const { rows } = await this.pool.query("select json from review where owner = $1 order by ord", [this.owner]);
    return openItems((rows as { json: JsonObject }[]).map((r) => r.json));
  }

  /**
   * A review decision (9.5, 11.9, 14.7, runs.md): one entry holding the review write and what it causes;
   * then the intakes the decision affects are replayed (9.6), each its own entry.
   */
  async decide(d: Decision, by: JsonObject = { person: "owner" }, at?: string): Promise<{ entry: Entry | null; replayed: string[] }> {
    const p = await this.definitions(true);
    // The operation may run more than once while the working set loads (working.ts): each run changes a copy.
    const fresh = () => ({ dict: { ...p.dict, facets: new Map(p.dict.facets) }, contracts: new Map(p.contracts.map((c) => [c.name, c])), units: [...((p as Parsed & { units?: JsonObject[] }).units ?? [])] });
    const result = await this.commitFrom((draft) => {
      const extra = decideReview(d, draft as unknown as Parameters<typeof decideReview>[1], fresh());
      return { by, extra, out: null };
    }, at);
    this.defsCache = undefined;
    const replayed = await this.replayFor(d, at);
    return { entry: result.entry, replayed };
  }

  /** Replay the kept intakes a decision reaches: by facet, by contract field, or by unit spelling (9.6). */
  private async replayFor(d: Decision, at?: string): Promise<string[]> {
    const key = d.key;
    const reaches = (o: JsonObject) =>
      (key.startsWith("facet:") && o.to === key.slice(6) && o.outcome === "new") ||
      (key.startsWith("contract:") && o.from === d.field && o.outcome === "unknown") ||
      (key.startsWith("unit:") && isObj(o.cites) && o.cites.unit === key.slice(5));
    if (!key.startsWith("facet:") && !key.startsWith("contract:") && !key.startsWith("unit:")) return [];
    if (d.decision === "reject" || d.decision === "ignore" || d.decision === "not a unit") return [];
    const p = await this.definitions(true);
    const { rows } = await this.pool.query("select intake, contract, \"for\", raw, json from intake where owner = $1 order by received", [this.owner]);
    const out: string[] = [];
    for (const row of rows as { intake: string; contract: string; for: string | null; raw: Uint8Array; json: JsonObject }[]) {
      const outcomes = (row.json.outcomes as JsonObject[] | undefined) ?? [];
      if (!outcomes.some(reaches) || !row.for) continue;
      const c = p.contracts.find((x) => x.name === row.contract);
      if (!c) continue;
      const body = Buffer.from(row.raw).toString("utf8");
      const again = receive(c, body, row.for, p.dict, row.intake);
      const recordId = row.for;
      const earlier = `L-${row.intake.slice(2)}`;
      const entry = await this.commitFrom((draft) => {
        const r = draft.records.get(recordId);
        if (!r) return { by: { migration: "replay" }, out: null };
        // What this intake landed before is replaced by its replay, never left to a tie with itself.
        const values = { ...r.values };
        const sources = { ...(r.sources ?? {}) };
        for (const [k, s] of Object.entries(sources)) if (s.via === earlier || s.via === row.intake) { delete values[k]; delete sources[k]; }
        const cleared = { ...r, values, sources };
        draft.records.set(recordId, land(cleared, { outcomes: again.outcomes as IntakeOutcome[], contract: c.name }, { origin: c.origin || "reported", via: row.intake }, p.dict.trust, p.dict.facetTrust, transitionsOf(p.dict)));
        return { by: { migration: "replay" }, extra: [], out: null };
      }, at);
      await this.pool.query("update intake set json = $3 where owner = $1 and intake = $2", [this.owner, row.intake, { ...row.json, replays: [...((row.json.replays as JsonObject[]) ?? []), { outcomes: again.outcomes as unknown as Json, contract: c.name, ...(entry.entry ? { entry: String(entry.entry.log) } : {}) }] }]);
      out.push(row.intake);
    }
    return out;
  }

  /** The compaction's two tables (schema.sql), made once per process: a store from before 0.3.33 lacks them, and the schema file is applied only to a new one. */
  private compactTable: Promise<void> | undefined;
  private compactReady(): Promise<void> {
    this.compactTable ??= (async () => {
      await this.pool.query("create table if not exists compaction_cursors (owner text not null, view text not null, version text not null, audience text not null, seq bigint not null default 0, done boolean not null default false, head bigint not null default 0, primary key (owner, view, version, audience))");
      await this.pool.query("create table if not exists compaction_removed (owner text not null, view text not null, version text not null, audience text not null, record text not null, seq bigint not null, primary key (owner, view, version, audience, record))");
    })();
    return this.compactTable;
  }

  /** The drain's walk: its cursor per owner, and the record-order index it reads by; made once per process. */
  private drainTable: Promise<void> | undefined;
  private drainReady(): Promise<void> {
    this.drainTable ??= (async () => {
      await this.pool.query("create table if not exists drain_cursors (owner text primary key, ord bigint not null default 0)");
      // Built concurrently when a store from before lacks it, never by the schema at connect: a plain create
      // over a catalog of a million records would hold the table for the build (brief 40). On its own
      // connection with no statement timeout, since a build over a million rows outlasts one; a build cut
      // short leaves an invalid index behind, which is dropped and made again.
      const { rows } = await this.pool.query("select x.indisvalid as valid from pg_index x join pg_class c on c.oid = x.indexrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = current_schema() and c.relname = 'records_ord'");
      const state = (rows[0] as { valid: boolean } | undefined)?.valid;
      if (state === true) return;
      const client = await this.pool.connect();
      try {
        await client.query("set statement_timeout = 0");
        if (state === false) await client.query("drop index if exists records_ord");
        await client.query("create index concurrently if not exists records_ord on records (owner, ord)");
      } catch {
        // Left for the next process to try again.
      } finally {
        await client.query("reset statement_timeout").catch(() => undefined);
        client.release();
      }
    })();
    return this.drainTable;
  }

  /**
   * Drain (docs/design/store.md, completion.md P): apply pending instructions to the records that have
   * them, at most `rate` records per call, fifty to an entry `by: migration: drain`; the ids done and
   * whether any still wait (brief 40: a walk by cursor in record order, never a count of what remains).
   */
  async drain(rate = 100, at?: string, budgetMs?: number): Promise<{ applied: string[]; remaining: number }> {
    const started = Date.now();
    // Nothing pending at all: no walk. The planner cannot tell that an empty issuer list makes the exists
    // below false for every row, so it read ME's 994,000 records for 27 s a tick for nothing (2026-10-26).
    if (!(await this.pool.query("select 1 from instructions where owner = $1 limit 1", [this.owner])).rows.length) return { applied: [], remaining: 0 };
    await this.drainReady();
    const dict = (await this.definitions()).dict;
    const from0 = Number(((await this.pool.query("select ord from drain_cursors where owner = $1", [this.owner])).rows[0] as { ord?: string | number } | undefined)?.ord ?? 0);
    // The records with an instruction still to apply, found by the tables (lifecycle.ts issuersFor: the
    // parent's instructions, a kind's, a class's worn by the record or its parent), in record order after the
    // cursor; a page at a time, so a tick reads `rate` matching records and what it skips, never the catalog
    // (brief 18, the scale rule). Counting what remained read every record twice a tick (2026-10-26).
    // The walk by issuer (0.3.30): one indexable branch per issuer, each carrying its own "still to apply"
    // test inline, in a union ordered by ord; no correlated test per candidate row (the exists over every
    // candidate with a lookup of the parent's classes ran 33 s a tick at Media Encyclopedia, 2026-10-28). A
    // class issuer reaches its wearers and the records of its wearers (lifecycle.ts issuersFor); a kind
    // issuer its kind's records; a record issuer the records of it.
    const issuers = (await this.pool.query("select issuer, count(*)::int as n from instructions where owner = $1 group by issuer", [this.owner])).rows as { issuer: string; n: number }[];
    // Each branch carries its own parameters: Postgres refuses a bind that supplies more than the statement
    // names (0.3.31 handed every branch the whole list and the drain applied nothing, 2026-10-28).
    const branches: { sql: string; ps: unknown[] }[] = [];
    const base = `r.owner = $1 and r.ord > $3 and coalesce(r.status ->> 'state', '') <> 'archived'`;
    const branch = (where: (ps: unknown[]) => string, issuer: string, n: number): void => {
      const ps: unknown[] = [this.owner, rate, from0];
      const w = where(ps);
      ps.push(issuer, n);
      branches.push({ sql: `select r.id, r.ord from records r where ${base} and ${w} and coalesce((r.applied ->> $${ps.length - 1})::int, 0) < $${ps.length} order by r.ord limit $2`, ps });
    };
    for (const { issuer, n } of issuers) {
      if (issuer.startsWith("class:")) {
        const name = issuer.slice(6).split("/")[0] as string;
        branch((ps) => { ps.push([name]); return `r.wears && $${ps.length}::text[]`; }, issuer, n);
        branch((ps) => { ps.push([name]); return `r."of" in (select p.id from records p where p.owner = $1 and p.wears && $${ps.length}::text[])`; }, issuer, n);
      } else if (issuer.startsWith("kind:")) {
        branch((ps) => { ps.push(issuer.slice(5).split("/")[0]); return `r.kind = $${ps.length}`; }, issuer, n);
      } else {
        branch((ps) => { ps.push(issuer); return `r."of" = $${ps.length}`; }, issuer, n);
      }
    }
    // One branch at a time, each walked by the record-order index with the page's limit, the first that
    // yields past the cursor taken: a union sorted every candidate before its limit (28 s a tick), and a
    // branch with nothing to give costs its scan once a tick, not once a row (0.3.31). A branch's records
    // behind the cursor are reached on the next pass from the start, which the walk owes until a pass finds
    // nothing.
    const from = from0;
    let rows: unknown[] = [];
    for (const b of branches) {
      rows = (await this.pool.query(b.sql, b.ps)).rows;
      if (rows.length) break;
    }
    const applied: string[] = [];
    let last = from;
    let cut = false;
    // Fifty records a commit: a commit's fixed cost (the chain lock, the base, the definitions, the entry)
    // is most of a record's three hundred milliseconds one by one, which made 139 a tick (2026-10-28). A
    // batch that fails is retried one record at a time, so one bad record never holds the others.
    const page = rows as { id: string; ord: string | number }[];
    for (let i = 0; i < page.length; i += 50) {
      // Within a budget when given: the rest of the page waits for the next tick, the cursor left on the last done.
      if (budgetMs !== undefined && Date.now() - started > budgetMs) {
        cut = true;
        break;
      }
      const group = page.slice(i, i + 50);
      const ids = group.map((row) => String(row.id));
      const batched = await this.commit({ migration: "drain" }, (d) => { for (const id of ids) apply(d as unknown as LifecycleStore, id, dict); }, at).then((e) => (e ? true : false), () => undefined);
      if (batched === undefined) {
        for (const id of ids) {
          const entry = await this.commit({ migration: "drain" }, (d) => { apply(d as unknown as LifecycleStore, id, dict); }, at);
          if (entry) applied.push(id);
        }
      } else if (batched) applied.push(...ids);
      last = Number((group[group.length - 1] as { ord: string | number }).ord);
    }
    // A full page may have more behind it: the cursor moves on. A short page reached the end of the walk: the
    // cursor returns to the start, and one more pass is owed unless this one began there and found nothing.
    const full = rows.length >= rate || cut;
    await this.pool.query("insert into drain_cursors (owner, ord) values ($1, $2) on conflict (owner) do update set ord = excluded.ord", [this.owner, full ? last : 0]);
    return { applied, remaining: full || from > 0 ? 1 : 0 };
  }

  /**
   * Compact the projection streams (12.6.2): an entry a later entry for the same record superseded is
   * dropped. Each record's latest entry stays, a removal among them, as does every `reset` marker, and the
   * head keeps its number, so an index resuming from any cursor lands the same rows. A pass walks every
   * current view's stream from its head DOWN in windows of `window` entries: walked that way, a record's
   * latest entry is met before its earlier ones, so an earlier entry is superseded when the stored row's seq
   * (a record in the view) or a removal met on the way (one that left) is above it; nothing scans ahead.
   * Each window is one read of the entries' records, a lookup of their stored rows and of the removals met,
   * and one delete by seq. A call stops at the budget and the next continues the pass from the cursors; when
   * every stream has been walked the pass is done and the next call begins another, skipping any stream whose
   * head has not moved since. Media Encyclopedia's four big streams held 2.3 million entries, 980,000 of them
   * superseded, 2.3 GB of 21 (2026-10-28).
   */
  async compact(budgetMs = 20_000, window = 10_000): Promise<{ deleted: number; done: boolean }> {
    const p = await this.projecting();
    if (!p) return { deleted: 0, done: true };
    await this.compactReady();
    const started = Date.now();
    const streams = [...p.views.views.values()].map((v) => [this.owner, v.name, v.version ?? "", v.show] as const);
    type Cursor = { seq: string | number; done: boolean; head: string | number };
    const cursorOf = async (key: readonly [string, string, string, string]) => (await this.pool.query("select seq, done, head from compaction_cursors where owner = $1 and view = $2 and version = $3 and audience = $4", [...key])).rows[0] as Cursor | undefined;
    // A pass is over when every current stream is done: the next call starts a fresh one from every head.
    const cursors = await Promise.all(streams.map(cursorOf));
    const fresh = streams.length > 0 && cursors.every((c) => c?.done);
    if (fresh) await this.pool.query("update compaction_cursors set seq = 0, done = false where owner = $1", [this.owner]);
    let deleted = 0;
    for (const [i, key] of streams.entries()) {
      const c = cursors[i];
      const was = fresh && c ? { ...c, seq: 0, done: false } : c;
      if (was?.done) continue;
      const head = Number(((await this.pool.query("select coalesce(max(seq), 0) as seq from projection_stream where owner = $1 and view = $2 and version = $3 and audience = $4", [...key])).rows[0] as { seq: string | number }).seq);
      const mark = (seq: number, done: boolean, at = head) => this.pool.query("insert into compaction_cursors (owner, view, version, audience, seq, done, head) values ($1, $2, $3, $4, $5, $6, $7) on conflict (owner, view, version, audience) do update set seq = excluded.seq, done = excluded.done, head = excluded.head", [...key, seq, done, at]);
      // The cursor is the seq the walk is below; 0 means the stream's walk has not started. A stream unmoved
      // since the last pass, or empty, is done at once: nothing new can have superseded anything.
      let from = Number(was?.seq ?? 0);
      // The head the pass began at, kept with the cursor: entries published during a pass wait for the next.
      let top = Number(was?.head ?? 0);
      if (from === 0) {
        if (head === 0 || head === top) { await mark(0, true, head); continue; }
        await this.pool.query("delete from compaction_removed where owner = $1 and view = $2 and version = $3 and audience = $4", [...key]);
        top = head;
        from = head + 1;
      }
      for (;;) {
        if (Date.now() - started > budgetMs) return { deleted, done: false };
        const rows = (await this.pool.query("select seq, json ->> 'record' as record, (json ? 'reset') as reset, (json ? 'removed') as removed from projection_stream where owner = $1 and view = $2 and version = $3 and audience = $4 and seq < $5 order by seq desc limit $6", [...key, from, window])).rows as { seq: string | number; record: string; reset: boolean; removed: boolean }[];
        if (rows.length) {
          const records = [...new Set(rows.map((r) => r.record))];
          // The removals met, this window's first: the highest seq per record, which is the one met first.
          const gone = rows.filter((r) => r.removed).map((r) => ({ record: r.record, seq: Number(r.seq) }));
          if (gone.length) await this.pool.query("insert into compaction_removed (owner, view, version, audience, record, seq) select $1, $2, $3, $4, e ->> 'record', (e ->> 'seq')::bigint from jsonb_array_elements($5::jsonb) as t(e) on conflict (owner, view, version, audience, record) do update set seq = greatest(compaction_removed.seq, excluded.seq)", [...key, JSON.stringify(gone)]);
          const above = new Map<string, number>();
          for (const r of (await this.pool.query("select record, seq from projections where owner = $1 and view = $2 and version = $3 and audience = $4 and record = any($5)", [...key, records])).rows as { record: string; seq: string | number }[]) above.set(r.record, Number(r.seq));
          for (const r of (await this.pool.query("select record, seq from compaction_removed where owner = $1 and view = $2 and version = $3 and audience = $4 and record = any($5)", [...key, records])).rows as { record: string; seq: string | number }[]) above.set(r.record, Math.max(above.get(r.record) ?? 0, Number(r.seq)));
          const superseded = rows.filter((r) => !r.reset && (above.get(r.record) ?? 0) > Number(r.seq)).map((r) => Number(r.seq));
          if (superseded.length) deleted += (await this.pool.query("delete from projection_stream where owner = $1 and view = $2 and version = $3 and audience = $4 and seq = any($5::bigint[])", [...key, superseded])).rowCount ?? 0;
          from = Number(rows[rows.length - 1]?.seq ?? from);
        }
        const finished = rows.length < window;
        await mark(finished ? 0 : from, finished, top);
        if (finished) break;
      }
    }
    return { deleted, done: true };
  }

  /** What installing a version would restamp (10.4): per recipe and step, how many values change and how many go to review. */
  async dryRun(bundle: JsonObject): Promise<{ recipes: { from: string; to: string; steps: StepStats[]; review: number }[]; records: number }> {
    const installed = await this.installed();
    const previous = installed.filter((i) => i.package === bundle.id).map((i) => String(i.version)).at(-1);
    if (!previous) return { recipes: [], records: 0 };
    const next = readBundleOnto(bundle, await this.definitions(true));
    const own = readBundle(bundle);
    const between = recipesBetween(next.recipes, String(bundle.package), previous, String(bundle.version));
    // A recipe with no steps (a pin move) restamps nothing, so no record is read for it, however many the package
    // owns. With steps, the package's own records are walked in batches by ord and each recipe's figures are
    // summed over the batches: never all of them in memory at once.
    const stepped = between.filter((r) => r.steps.length);
    const out = new Map(between.map((r) => [r, { from: r.from, to: r.to, steps: [] as StepStats[], review: 0 }]));
    let records = 0;
    if (stepped.length)
      await this.walkOwnRecords(own, (batch) => {
        records += batch.length;
        for (const r of stepped) {
          const d = dryRun(batch, r, next.dict);
          const sum = out.get(r) as { steps: StepStats[]; review: number };
          sum.review += d.review;
          d.steps.forEach((st, i) => {
            const have = sum.steps[i];
            if (have) {
              have.changed += st.changed;
              have.review += st.review;
            } else sum.steps[i] = { ...st };
          });
        }
      });
    return { recipes: between.map((r) => out.get(r) as { from: string; to: string; steps: StepStats[]; review: number }), records };
  }

  /**
   * The records the package's recipes restamp (10.4): of its kinds or wearing its classes, read on the kind and
   * wears indexes in batches by ord, never the catalog whole and never all of them at once.
   */
  private async walkOwnRecords(own: Parsed, fn: (records: Record[]) => void): Promise<void> {
    const kinds = [...own.dict.kinds.keys()];
    const classes = [...own.dict.classes.keys()];
    if (!kinds.length && !classes.length) return;
    const size = Math.max(1, this.options.restampBatch ?? 5000);
    let after = -1;
    for (;;) {
      const { rows } = await this.pool.query("select * from records where owner = $1 and (kind = any($2::text[]) or wears && $3::text[]) and ord > $4 order by ord limit $5", [this.owner, kinds, classes, after, size]);
      if (!rows.length) return;
      const list = rows as { [column: string]: unknown }[];
      fn(list.map((r) => recordOf(r)));
      after = Number(list[list.length - 1]?.ord);
      if (rows.length < size) return;
    }
  }

  /** A define write (8.5, 11.4): one member of the working package as it now stands, checked with the rest first. */
  async define(member: JsonObject, by: JsonObject = { person: "owner" }, at?: string): Promise<Entry | null> {
    // The trial is the package as it would stand with this write (a redefinition replacing, a retired member
    // gone), checked whole; only then does the write land.
    const client = await this.pool.connect();
    try {
      checkAll(await definitionsOf(client, this.owner, [member]));
    } finally {
      client.release();
    }
    const e = (await this.commitFrom(() => ({ by, extra: [{ define: member }], out: null }), at)).entry;
    this.defsCache = undefined;
    return e;
  }

  /**
   * The owner's state as the tables hold it, kept per chain head: the same head answers from memory; a
   * head a little further on replays the entries since onto a copy (the engine's own replay), so a write
   * never costs a reload of every record; a gap over 200 entries, or an entry the replay can't take,
   * reads the tables whole. A commit works on a copy of the loaded state, so a kept state is never shared
   * with a draft. (G6: Cashierfu carried this around the store until 0.1.15.)
   */
  async state(): Promise<State> {
    if (this.options.wholeState === "refuse") throw new Error(`${this.owner}: the whole state is refused on a request path; read what is needed with read(), records(), installed(), edges() or openReview()`);
    return this.wholeState();
  }

  /**
   * The whole state regardless of the option: for a rebuild, an erase, an install's restamp, an export and a
   * test's assertions. Never on a request path: `state()` is the guarded door, this one says what it is.
   */
  async wholeState(): Promise<State> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query("select head_seq from chains where owner = $1 and chain = $2", [this.owner, this.chain]);
      const seq = rows.length ? Number((rows[0] as { head_seq: string | number }).head_seq) : -1;
      // A hosted person's writes go to their own chain (14.1) and move no head of ours, so the key the
      // state is kept under takes every hosted head along: one of theirs moving reads the tables whole.
      const hostedRows = await client.query("select coalesce(sum(head_seq), 0)::text as total, count(*)::text as n from chains where owner like $1 and chain = $2", [`${this.owner}:%`, this.chain]);
      const hosted = `${(hostedRows.rows[0] as { total: string; n: string }).n}/${(hostedRows.rows[0] as { total: string; n: string }).total}`;
      const kept = this.keptState;
      if (kept && kept.seq === seq && kept.hosted === hosted) return kept.state;
      if (kept && kept.hosted === hosted && seq > kept.seq && seq - kept.seq <= 200) {
        const since = await client.query("select seq, entry from log where owner = $1 and chain = $2 and seq > $3 order by seq", [this.owner, this.chain, kept.seq]);
        const entries = since.rows as { seq: string | number; entry: Entry }[];
        const contiguous = entries.length === seq - kept.seq && entries.every((e, i) => Number(e.seq) === kept.seq + i + 1);
        if (contiguous) {
          const next = copyState(kept.state);
          try {
            for (const e of entries) applyEntry(next, e.entry);
            this.keptState = { seq, hosted, state: next };
            return next;
          } catch {
            // an entry the replay can't take: the tables, below
          }
        }
      }
      const state = await loadState(client, this.owner);
      this.keptState = { seq, hosted, state };
      return state;
    } finally {
      client.release();
    }
  }

  // ─── Reads that never load the whole state (brief 18, the scale rule) ─────

  /**
   * A read on a working set: `fn` runs on a state whose records, bindings and runs load as it asks for them
   * (by id, level, parent, target or key), and runs again until it asked for nothing new; edges,
   * instructions and the working package are loaded whole (they are small). The lists (reviews,
   * observations, installed, reads) are not loaded here: the readers below serve them. `fn` MUST be pure.
   */
  async read<T>(fn: (s: State) => T, opts: { allowAll?: boolean } = {}): Promise<T> {
    const client = await this.pool.connect();
    try {
      const needs = new Needs();
      if (this.options.wholeState === "refuse" && !opts.allowAll) needs.refuseAll = `${this.owner}: records.all() asks for the whole catalog on a request path; ask by level, parent, target or key`;
      const base = workingState(needs);
      await loadWhole(client, this.owner, base);
      const { out } = await settle(client, this.owner, base, fn);
      return out;
    } finally {
      client.release();
    }
  }

  /**
   * Records by a selection (`RecordsWhere`), in log order or newest first; paged by `ord` (read-api.md 3.1).
   * Every call that worked before the read API returns what it did.
   */
  async records(where: RecordsWhere = {}, opts: RecordsOptions = {}): Promise<Record[]> {
    return (await this.page(where, opts)).records;
  }

  /**
   * A page of `records`, and the cursor for the next: pass `next` as `after` (log order) or as `before`
   * (`newest`). No `next` when the page came back short of its limit, or when it had none.
   */
  async page(where: RecordsWhere = {}, opts: RecordsOptions = {}): Promise<{ records: Record[]; next?: number }> {
    const { conds, params, add } = selection(this.owner, where, opts.archived);
    if (opts.after !== undefined) add("ord > ?", opts.after);
    if (opts.before !== undefined) add("ord < ?", opts.before);
    const limit = opts.limit ? Math.max(1, Math.floor(opts.limit)) : undefined;
    let doc = "doc";
    if (opts.values) {
      // Only the facets asked come back, with their sources (and the record's `*` source): a list's row
      // should not carry a record's whole document across the wire.
      params.push(opts.values);
      const n = `$${params.length}`;
      doc = `jsonb_set(jsonb_set(doc, '{values}', coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(doc -> 'values') e where e.key = any(${n})), '{}'::jsonb)), '{sources}', coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(coalesce(doc -> 'sources', '{}'::jsonb)) e where e.key = any(${n}) or e.key = '*'), '{}'::jsonb)) as doc`;
    }
    const cols = `id, owner, kind, level, "of", within, status, applied, wears, created, updated, ord, ${doc}`;
    const { rows } = await this.pool.query(`select ${cols} from records where ${conds.join(" and ")} order by ord${opts.newest ? " desc" : ""}${limit ? ` limit ${limit}` : ""}`, params);
    const out = rows as { [column: string]: unknown }[];
    const last = out.at(-1);
    return { records: out.map((r) => recordOf(r)), ...(limit && out.length === limit && last ? { next: Number(last.ord) } : {}) };
  }

  /** How many records `records(where)` would return with no limit: one indexed count (read-api.md 3.2). */
  async count(where: RecordsWhere = {}, opts: { archived?: boolean } = {}): Promise<number> {
    const { conds, params } = selection(this.owner, where, opts.archived);
    const { rows } = await this.pool.query(`select count(*)::bigint as n from records where ${conds.join(" and ")}`, params);
    return Number((rows[0] as { n: string }).n);
  }

  /** Every edge of the owner (small: people and their grants). */
  async edges(): Promise<Edge[]> {
    const { rows } = await this.pool.query("select json from edges where owner = $1 order by ord", [this.owner]);
    return (rows as { json: Edge }[]).map((r) => r.json);
  }

  /** The install log as what is in force: every version taken, in order, less the packages that left (11.4). */
  async installed(): Promise<JsonObject[]> {
    return installsInForce(await this.installLog());
  }

  /** The signed bundles of the packages in force (read-api.md 3.4), in the order they are in force. */
  async bundlesInForce(): Promise<{ package: string; version: string; bundle: JsonObject }[]> {
    const inForce = (await this.installed()).map((i) => ({ package: String(i.package), version: String(i.version) }));
    if (!inForce.length) return [];
    const { rows } = await this.pool.query(
      "select package, version, json from bundles where owner = $1 and (package, version) in (select * from unnest($2::text[], $3::text[]))",
      [this.owner, inForce.map((i) => i.package), inForce.map((i) => i.version)],
    );
    const by = new Map((rows as { package: string; version: string; json: JsonObject }[]).map((r) => [`${r.package} /${r.version}`, r.json]));
    return inForce.flatMap((i) => {
      const bundle = by.get(`${i.package} /${i.version}`);
      return bundle ? [{ ...i, bundle }] : [];
    });
  }

  /** The install log whole: every version taken and every leaving, in order. */
  async installLog(): Promise<JsonObject[]> {
    const { rows } = await this.pool.query("select json from installed where owner = $1 order by ord", [this.owner]);
    return (rows as { json: JsonObject }[]).map((r) => r.json);
  }

  /**
   * A package leaves (11.4, revision 30): refused while a package in force extends it, a utility in force needs it
   * (its own excepted), or a record holds a value under a key it alone declares; else the log takes an install
   * write with `left`, and the set in force is read without it.
   */
  async leave(pkg: string, at?: string): Promise<Entry> {
    const inForce = await this.installed();
    const mine = inForce.filter((i) => i.package === pkg);
    if (!mine.length) throw new Error(`${pkg} isn't in force here`);
    const version = String(mine.at(-1)?.version);
    const others = [...new Map(inForce.filter((i) => i.package !== pkg).map((i) => [String(i.package), String(i.version)])).entries()];
    const bundleOf = async (p: string, v: string): Promise<JsonObject | undefined> =>
      ((await this.pool.query("select json from bundles where owner = $1 and package = $2 and version = $3", [this.owner, p, v])).rows[0] as { json: JsonObject } | undefined)?.json;
    const own = await bundleOf(pkg, version);
    if (!own) throw new Error(`${pkg} /${version} is installed but its bundle is missing`);
    const theirFacets = new Set<string>();
    for (const [p, v] of others) {
      const b = await bundleOf(p, v);
      if (!b) continue;
      for (const e of (b.extends as JsonObject[] | undefined) ?? []) {
        const dep = String(e.package).includes("/") ? String(e.package) : `${b.owner}/${e.package}`;
        if (dep === pkg) throw new Error(`${pkg} can't leave: ${b.id} extends it; it leaves first`);
      }
      for (const k of readBundle(b).dict.facets.keys()) theirFacets.add(k);
    }
    const parsedOwn = readBundle(own);
    const ownUtilities = new Set(parsedOwn.info.utilities.map((u) => u.name));
    const defs = await this.definitions(true);
    const needing = defs.info.utilities.filter((u) => !ownUtilities.has(u.name) && u.needs.some((n) => n.name === pkg)).map((u) => u.name);
    if (needing.length) throw new Error(`${pkg} can't leave: ${needing.join(", ")} need${needing.length === 1 ? "s" : ""} it; switch ${needing.length === 1 ? "it" : "them"} off first`);
    // The package's own keys: not the standard's (`crubal:`), not another package's in force.
    const ownKeys = [...parsedOwn.dict.facets.keys()].filter((k) => !k.startsWith("crubal:") && !theirFacets.has(k));
    if (ownKeys.length) {
      const { rows } = await this.pool.query("select count(*)::int as n from records where owner = $1 and doc -> 'values' ?| $2::text[]", [this.owner, ownKeys]);
      const n = Number((rows[0] as { n: number } | undefined)?.n ?? 0);
      if (n > 0) throw new Error(`${pkg} can't leave: ${n} record${n === 1 ? " holds" : "s hold"} values under ${ownKeys.join(", ")}; hand or cut them first (10.3)`);
    }
    const r = await this.commitFrom(() => ({ by: { person: "owner" }, extra: [{ install: { package: pkg, version, left: true } }], out: null }), at);
    if (!r.entry) throw new Error(`${pkg}: the leaving wrote no entry`);
    return r.entry;
  }

  /** The record a binding (`contract|ref`) names, if any. */
  async binding(key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query("select record from bindings where owner = $1 and key = $2", [this.owner, key]);
    return rows[0] ? String((rows[0] as { record: string }).record) : undefined;
  }

  /** The owner's working package (11.4): `<member>:<name>` → the definition as it now stands. */
  async defines(): Promise<Map<string, JsonObject>> {
    const { rows } = await this.pool.query("select key, json from definitions where owner = $1 order by ord", [this.owner]);
    return new Map((rows as { key: string; json: JsonObject }[]).map((r) => [String(r.key), r.json]));
  }

  /** Every review item ever written, decided or not, in order (9.5); `review()` is the open ones. */
  async reviews(): Promise<JsonObject[]> {
    const { rows } = await this.pool.query("select json from review where owner = $1 order by ord", [this.owner]);
    return (rows as { json: JsonObject }[]).map((r) => r.json);
  }

  /** The records several bindings name, by key: one query for an import's references. */
  async bindings(keys: string[]): Promise<Map<string, string>> {
    if (!keys.length) return new Map();
    const { rows } = await this.pool.query("select key, record from bindings where owner = $1 and key = any($2)", [this.owner, keys]);
    return new Map((rows as { key: string; record: string }[]).map((r) => [String(r.key), String(r.record)]));
  }

  /** The log of reads under an emergency edge (14.13), in order. */
  async emergencyReads(): Promise<JsonObject[]> {
    const { rows } = await this.pool.query("select json from reads where owner = $1 order by ord", [this.owner]);
    return (rows as { json: JsonObject }[]).map((r) => r.json);
  }

  /** The observations on one record, or on or supporting any of several (9.7). */
  async observationsOn(id: string | string[]): Promise<JsonObject[]> {
    return this.observations({ on: id });
  }

  /** Observations by what they are on or support, their evidence type and their address (9.7); never all of them unasked. */
  async observations(where: { on?: string | string[]; evidenceType?: string; address?: string }): Promise<JsonObject[]> {
    const conds = ["owner = $1"];
    const params: unknown[] = [this.owner];
    const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace("?", `$${params.length}`)); };
    if (where.on !== undefined) {
      const ids = Array.isArray(where.on) ? where.on : [where.on];
      params.push(ids);
      conds.push(`(json ->> 'on' = any($${params.length}) or json ->> 'supports' = any($${params.length}))`);
    }
    if (where.evidenceType) add("json ->> 'evidence-type' = ?", where.evidenceType);
    if (where.address) add("json ->> 'address' = ?", where.address);
    if (conds.length === 1) throw new Error(`${this.owner}: observations() wants what they are on, their evidence type or their address`);
    const { rows } = await this.pool.query(`select json from observations where ${conds.join(" and ")} order by ord`, params);
    return (rows as { json: JsonObject }[]).map((r) => r.json);
  }

  private keptState: { seq: number; hosted: string; state: State } | undefined;

  /** Forget the kept state: after a rewrite of history that moves no head (an erase, a rebuild). */
  forgetState(): void {
    this.keptState = undefined;
  }

  /** The owner's entries, in chain order. */
  async entries(): Promise<Entry[]> {
    const { rows } = await this.pool.query("select entry from log where owner = $1 and chain = $2 order by seq", [this.owner, this.chain]);
    return rows.map((r: { entry: Entry }) => r.entry);
  }

  /** The chain's head (read-api.md 3.3): its last sequence number (0 before any entry) and that entry's hash. */
  async head(): Promise<{ seq: number; hash: string | null }> {
    const { rows } = await this.pool.query("select head_seq, head_hash from chains where owner = $1 and chain = $2", [this.owner, this.chain]);
    const r = rows[0] as { head_seq: string | number; head_hash: string | null } | undefined;
    return { seq: r ? Number(r.head_seq) : 0, hash: r?.head_hash ?? null };
  }

  /**
   * A stretch of the chain with each entry's sequence number (read-api.md 3.3): after or before a number, in
   * order or newest first, at most `limit`. `drains: false` leaves out the drain's own entries (those `by`
   * the migration `drain`), so "has anything a person or a loop wrote landed since" is one indexed read.
   */
  async log(opts: { after?: number; before?: number; limit?: number; newest?: boolean; drains?: boolean } = {}): Promise<{ seq: number; entry: Entry }[]> {
    const conds = ["owner = $1", "chain = $2"];
    const params: unknown[] = [this.owner, this.chain];
    if (opts.after !== undefined) conds.push(`seq > $${params.push(opts.after)}`);
    if (opts.before !== undefined) conds.push(`seq < $${params.push(opts.before)}`);
    if (opts.drains === false) conds.push("coalesce(entry -> 'by' ->> 'migration', '') <> 'drain'");
    const limit = opts.limit ? ` limit ${Math.max(1, Math.floor(opts.limit))}` : "";
    const { rows } = await this.pool.query(`select seq, entry from log where ${conds.join(" and ")} order by seq${opts.newest ? " desc" : ""}${limit}`, params);
    return (rows as { seq: string | number; entry: Entry }[]).map((r) => ({ seq: Number(r.seq), entry: r.entry }));
  }

  /**
   * The number of the last entry after `after` (read-api.md 3.3), or undefined when there is none; with
   * `drains: false`, the last one the drain did not write. Only the number is read: an entry can carry
   * thousands of writes, and "has anything landed since" should not load one.
   */
  async lastSeq(opts: { after?: number; drains?: boolean } = {}): Promise<number | undefined> {
    const conds = ["owner = $1", "chain = $2"];
    const params: unknown[] = [this.owner, this.chain];
    if (opts.after !== undefined) conds.push(`seq > $${params.push(opts.after)}`);
    if (opts.drains === false) conds.push("coalesce(entry -> 'by' ->> 'migration', '') <> 'drain'");
    const { rows } = await this.pool.query(`select max(seq) as seq from log where ${conds.join(" and ")}`, params);
    const v = (rows[0] as { seq: string | number | null } | undefined)?.seq;
    return v === null || v === undefined ? undefined : Number(v);
  }

  /**
   * Runs (read-api.md 3.5; runs.md), newest first: of a contract, on a record, in a state. A run's state and
   * names are in its document, so this reads the owner's runs by `ord` and filters on them.
   */
  async runs(where: { contract?: string; record?: string; state?: string } = {}, opts: { limit?: number } = {}): Promise<{ run: string; json: JsonObject }[]> {
    const conds = ["owner = $1"];
    const params: unknown[] = [this.owner];
    for (const k of ["contract", "record", "state"] as const) {
      const v = where[k];
      if (v !== undefined) conds.push(`json ->> '${k}' = $${params.push(v)}`);
    }
    const limit = opts.limit ? ` limit ${Math.max(1, Math.floor(opts.limit))}` : "";
    const { rows } = await this.pool.query(`select run, json from runs where ${conds.join(" and ")} order by ord desc${limit}`, params);
    return rows as { run: string; json: JsonObject }[];
  }

  /** What arrived (read-api.md 3.5; 7.4), in the order received: its id, contract, the record it is for and its outcome document. The raw bytes stay behind. */
  async intakes(where: { for?: string; contract?: string } = {}): Promise<{ intake: string; contract: string | null; for: string | null; received: string | null; json: JsonObject }[]> {
    const conds = ["owner = $1"];
    const params: unknown[] = [this.owner];
    if (where.for !== undefined) conds.push(`"for" = $${params.push(where.for)}`);
    if (where.contract !== undefined) conds.push(`contract = $${params.push(where.contract)}`);
    const { rows } = await this.pool.query(`select intake, contract, "for", received, json from intake where ${conds.join(" and ")} order by received`, params);
    return rows as { intake: string; contract: string | null; for: string | null; received: string | null; json: JsonObject }[];
  }

  /** Lock the chain for this transaction and return its head. Writers to one chain serialize here. */
  private async lockChain(client: Client): Promise<{ seq: number; hash: string | null }> {
    await client.query("insert into chains (owner, chain) values ($1, $2) on conflict do nothing", [this.owner, this.chain]);
    const { rows } = await client.query("select head_seq, head_hash from chains where owner = $1 and chain = $2 for update", [this.owner, this.chain]);
    const head = rows[0] as { head_seq: string | number; head_hash: string | null };
    return { seq: Number(head.head_seq), hash: head.head_hash };
  }

  /** Link an entry to the chain's head, insert it, and move the head. The entry gets its `prev`. */
  private async link(client: Client, entry: Entry, head: { seq: number; hash: string | null }, owner = this.owner, signer = this.options.signer): Promise<Entry> {
    const linked: Entry = { ...entry };
    if (head.hash) linked.prev = `sha256:${head.hash}`;
    else delete linked.prev;
    const hash = entryHash(linked);
    if (signer) linked.sig = signer(hash);
    const seq = head.seq + 1;
    await client.query(
      "insert into log (owner, chain, seq, log_id, prev, hash, at, witnessed, entry) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [owner, this.chain, seq, String(linked.log), linked.prev ?? null, hash, typeof linked.at === "string" ? linked.at : null, linked.witnessed === true, linked],
    );
    await client.query("update chains set head_seq = $3, head_hash = $4 where owner = $1 and chain = $2", [owner, this.chain, seq, hash]);
    // Revision 50: the records this entry touches, indexed as it lands; the index is whole through this entry
    // where it was whole through the one before.
    await this.touchesReady();
    const touched = touchedBy(linked);
    if (touched.length) await client.query("insert into log_touches (owner, chain, record, seq) select $1, $2, r, $3 from unnest($4::text[]) as r on conflict do nothing", [owner, this.chain, seq, touched]);
    await client.query("insert into log_touch_cursors (owner, chain, seq) values ($1, $2, 0) on conflict do nothing", [owner, this.chain]);
    await client.query("update log_touch_cursors set seq = $3 where owner = $1 and chain = $2 and seq = $3 - 1", [owner, this.chain, seq]);
    return linked;
  }

  /** The index of the records each entry touches, and how far it is whole (revision 50); made once per process. */
  private touchTable: Promise<void> | undefined;
  private touchesReady(): Promise<void> {
    this.touchTable ??= (async () => {
      await this.pool.query("create table if not exists log_touches (owner text not null, chain text not null, record text not null, seq bigint not null, primary key (owner, chain, record, seq))");
      await this.pool.query("create table if not exists log_touch_cursors (owner text not null, chain text not null, seq bigint not null default 0, primary key (owner, chain))");
    })();
    return this.touchTable;
  }

  /**
   * Revision 50: index the entries of a log from before the index, a bounded batch at a time, oldest first.
   * The chain is held for the batch, as a write holds it, so no entry lands between the read and the cursor.
   * Answers how far the index is whole and the chain's head; they are equal when there is nothing left.
   */
  async indexTouches(limit = 500): Promise<{ through: number; head: number }> {
    await this.touchesReady();
    return transaction(this.pool, async (client) => {
      const head = await this.lockChain(client);
      await client.query("insert into log_touch_cursors (owner, chain, seq) values ($1, $2, 0) on conflict do nothing", [this.owner, this.chain]);
      const cur = await client.query("select seq from log_touch_cursors where owner = $1 and chain = $2", [this.owner, this.chain]);
      let through = Math.max(0, Number((cur.rows[0] as { seq: string | number } | undefined)?.seq ?? 0));
      if (through >= head.seq) return { through: head.seq, head: head.seq };
      const { rows } = await client.query("select seq, entry from log where owner = $1 and chain = $2 and seq > $3 order by seq limit $4", [this.owner, this.chain, through, Math.max(1, Math.floor(limit))]);
      for (const row of rows as { seq: string | number; entry: Entry }[]) {
        const touched = touchedBy(row.entry);
        if (touched.length) await client.query("insert into log_touches (owner, chain, record, seq) select $1, $2, r, $3 from unnest($4::text[]) as r on conflict do nothing", [this.owner, this.chain, Number(row.seq), touched]);
        through = Number(row.seq);
      }
      await client.query("update log_touch_cursors set seq = $3 where owner = $1 and chain = $2", [this.owner, this.chain, through]);
      return { through, head: head.seq };
    });
  }

  /**
   * Revision 50: one record as it stood at a moment (as it stands, when none is said), and when each of its
   * values last changed. Read by the index where it is whole; else by the log itself, which is slower and
   * answers the same.
   */
  async recordAt(id: string, until?: string): Promise<{ record?: Record; changed: { [address: string]: string } }> {
    await this.touchesReady();
    const { rows: at } = await this.pool.query("select c.head_seq as head, coalesce(t.seq, 0) as through from chains c left join log_touch_cursors t on t.owner = c.owner and t.chain = c.chain where c.owner = $1 and c.chain = $2", [this.owner, this.chain]);
    const where = at[0] as { head: string | number; through: string | number } | undefined;
    if (!where) return { changed: {} };
    const whole = Number(where.through) >= Number(where.head);
    const { rows } = whole
      ? await this.pool.query("select l.entry from log l join log_touches t on t.owner = l.owner and t.chain = l.chain and t.seq = l.seq where t.owner = $1 and t.chain = $2 and t.record = $3 order by l.seq", [this.owner, this.chain, id])
      : await this.pool.query("select entry from log where owner = $1 and chain = $2 and entry->'writes' @> $3::jsonb order by seq", [this.owner, this.chain, JSON.stringify([{ record: id }])]);
    return recordAt((rows as { entry: Entry }[]).map((r) => r.entry), id, until);
  }

  /**
   * A hosted person's records live in their own chain (14.1): the writes to records owned `<owner>:<id>`
   * leave the owner's entry and become one entry per person, linked and signed in the same transaction.
   * The chains lock in a fixed order (the owner's first, then the persons' by name).
   */
  private async linkSplit(client: Client, entry: Entry, head: { seq: number; hash: string | null }, after: State): Promise<{ entry: Entry | null; hosted: Entry[] }> {
    const prefix = `${this.owner}:`;
    const byOwner = new Map<string, JsonObject[]>();
    const own: JsonObject[] = [];
    for (const w of (Array.isArray(entry.writes) ? entry.writes : []) as JsonObject[]) {
      const rec = typeof w.record === "string" ? after.records.get(w.record) : undefined;
      const o = rec?.owner;
      if (o && o.startsWith(prefix)) byOwner.set(o, [...(byOwner.get(o) ?? []), w]);
      else own.push(w);
    }
    const hosted: Entry[] = [];
    for (const person of [...byOwner.keys()].sort()) {
      await client.query("insert into chains (owner, chain) values ($1, $2) on conflict do nothing", [person, this.chain]);
      const { rows } = await client.query("select head_seq, head_hash from chains where owner = $1 and chain = $2 for update", [person, this.chain]);
      const h = rows[0] as { head_seq: number | string; head_hash: string | null };
      const ph = { seq: Number(h.head_seq), hash: h.head_hash };
      const signer = this.options.hostedSigner ? await this.options.hostedSigner(person) : undefined;
      const e: Entry = { ...entry, log: `L-${ph.seq + 1}`, owner: person, writes: byOwner.get(person) as JsonObject[] };
      hosted.push(await this.link(client, e, ph, person, signer));
    }
    if (!own.length) return { entry: null, hosted };
    return { entry: await this.link(client, { ...entry, writes: own }, head), hosted };
  }

  /**
   * Append an entry made elsewhere (a rebuilt log, a hosted person's chain the host carries): it is
   * linked to this chain's head, applied with the engine's applyEntry, and its effects persisted.
   */
  async append(entry: Entry): Promise<Entry> {
    return transaction(this.pool, async (client) => {
      const head = await this.lockChain(client);
      const base = await this.base(client);
      const linked = await this.link(client, entry, head);
      const { state: after } = await settle(client, this.owner, base, (s) => applyEntry(s, linked));
      await persist(client, this.owner, base, after);
      await this.afterPersist(client, base, after, head.seq + 1);
      return linked;
    }).then(async (e) => {
      await this.freshen();
      return e;
    });
  }

  /** An empty working state with the whole small tables in it; records, bindings and runs load as needed. */
  private async base(client: Client): Promise<State> {
    const needs = new Needs();
    if (this.options.wholeState === "refuse" && !this.walking) needs.refuseAll = `${this.owner}: records.all() asks for the whole catalog inside a commit on a request path; ask by level, parent, target or key`;
    this.trace = needs;
    const base = workingState(needs);
    await loadWhole(client, this.owner, base);
    return base;
  }

  /** What the last operation loaded, for tests and for watching a store's cost. */
  trace: Needs | undefined;

  /** Set while an install restamps: its commit walks the package's records by design, whatever `wholeState` says. */
  private walking = false;

  /**
   * One operation, one entry (8.5): the engine runs on a draft of the state, what it changed becomes the
   * entry's writes (plus `extra` writes the diff can't see), and the entry is applied and persisted in the
   * same transaction. Nothing happens when nothing changed; a throw inside `mutate` rolls everything back.
   */
  /**
   * A quorum (7.6) holds a commit by hand to the same rule as a run: a cause naming a contract whose quorum
   * holds must cite a met proposal (`by.proposal`), or the commit is refused before anything is written.
   */
  private quorumGate(p: { contracts: Contract[] }, d: Draft, by: JsonObject): void {
    const name = typeof by.contract === "string" ? by.contract : undefined;
    if (!name) return;
    const c = p.contracts.find((x) => x.name === name);
    if (!c || !quorumHolds(c, d.records)) return;
    const cite = typeof by.proposal === "string" ? by.proposal : undefined;
    if (!proposalMet(d.records, cite, name)) throw new QuorumRefused(name, cite);
  }

  async commit(by: JsonObject, mutate: (draft: Draft) => void, at?: string, extra: JsonObject[] = []): Promise<Entry | null> {
    return (await this.commitFrom((d) => { mutate(d); return { by, extra, out: undefined }; }, at)).entry;
  }

  /**
   * The same, for an operation that decides its own cause and extra writes as it runs (a border run): it
   * returns `by`, `extra` and an outcome, and the outcome comes back beside the entry.
   */
  async commitFrom<T>(run: (draft: Draft) => { by: JsonObject; extra?: JsonObject[]; out: T }, at?: string, mark: { witnessed?: true } = {}, under?: Parsed): Promise<{ entry: Entry | null; out: T }> {
    return transaction(this.pool, async (client) => {
      // CRUBAL_TRACE_COMMIT=1 prints each phase's time to stderr, for a probe or a slow commit in the field.
      const T0 = Date.now();
      const tr = (label: string) => { if (process.env.CRUBAL_TRACE_COMMIT) console.error(`commit ${this.owner} ${label} ${Date.now() - T0} ms`); };
      const head = await this.lockChain(client);
      const before = await this.base(client);
      tr("base");
      const needs = before.records as WorkingRecords;
      // The operation runs until the working set holds everything it asked for (working.ts); so does the
      // entry's application. Both run on copies of the same base, so the draft and the applied state
      // hold the same records and `differs` compares like with like.
      let draft: Draft;
      let after: State;
      let entry: Entry;
      let result: { by: JsonObject; extra?: JsonObject[]; out: T };
      // An install derives under the definitions it brings (10.3: produced values are rebuilt by the new
      // rules): the store's own are still the version before until its entry lands (0.4.5).
      const p = under ?? (await this.definitionsFrom(client, false));
      tr("definitions");
      for (;;) {
        const had = needs.needs.loaded.size;
        ({ draft, result } = (await settle(client, this.owner, before, (s) => { const d = draftOf(s); const r = run(d); this.quorumGate(p, d, r.by); this.derive(p, before, d); return { draft: d, result: r }; })).out);
        const writes = [...diffWrites(before, draft), ...(result.extra ?? [])];
        if (!writes.length) return { entry: null, out: result.out };
        entry = { log: `L-${head.seq + 1}`, owner: this.owner, at: at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), by: result.by, writes, ...(mark.witnessed ? { witnessed: true } : {}) };
        const e = entry;
        // The entry applied, then checked in the same run (14.12, 5.5, 14.1), so what the check reads loads too.
        after = (await settle(client, this.owner, before, (s) => { applyEntry(s, e); this.checkWrites(p, e, s); })).state;
        if (needs.needs.loaded.size === had) break;
      }
      tr(`settled, ${needs.needs.loaded.size} records loaded`);
      const { entry: linked, hosted } = await this.linkSplit(client, entry, head, after);
      const problem = differs(after, draft);
      if (problem) throw new Error(`the log doesn't describe the change: ${problem}`);
      await persist(client, this.owner, before, after);
      tr("persisted");
      await this.afterPersist(client, before, after, head.seq + (linked ? 1 : 0), p);
      tr("stale marked");
      // The definitions in force are unchanged by an entry with no define write (an install clears the
      // cache itself), so the cache follows the head: parsing them again cost every commit, and the first
      // read after it, ~110 ms on ME.
      if (linked && this.defsCache?.seq === head.seq && !(Array.isArray(entry.writes) ? entry.writes : []).some((w) => isObj(w) && isObj(w.define))) this.defsCache = { seq: head.seq + 1, parsed: this.defsCache.parsed };
      return { entry: linked ?? (hosted[0] as Entry), out: result.out };
    }).then(async (r) => {
      if (r.entry) await this.freshen();
      return r;
    });
  }

  /**
   * Erase a record's values from the log (8.5.2): every value write to it, and every observation on it, in
   * every entry, is redacted in place; creations, envelopes and everything else stay. The state is rebuilt.
   */
  async erase(recordId: string): Promise<{ redacted: number; witnessed: string[] }> {
    const witnessed: string[] = [];
    let redacted = 0;
    await transaction(this.pool, async (client) => {
      await this.lockChain(client);
      const { rows } = await client.query("select owner, log_id, entry from log where (owner = $1 or owner like $1 || ':%') and chain = $2 and not (entry ? 'redacted') order by ord for update", [this.owner, this.chain]);
      for (const row of rows as { owner: string; log_id: string; entry: Entry }[]) {
        const writes = Array.isArray(row.entry.writes) ? row.entry.writes : [];
        const hits = writes.map((w, i) => (isObj(w) && ((w.record === recordId && typeof w.address === "string") || (isObj(w.observation) && w.observation.on === recordId)) ? i : -1)).filter((i) => i >= 0);
        if (!hits.length) continue;
        if (row.entry.witnessed === true) {
          witnessed.push(row.log_id);
          continue;
        }
        const next = [...writes];
        for (const i of hits) next[i] = { redacted: `sha256:${writeHash(writes[i] as JsonObject)}` };
        await client.query("update log set entry = $3 where owner = $1 and log_id = $2", [row.owner, row.log_id, { ...row.entry, writes: next }]);
        redacted += hits.length;
      }
    });
    // What is kept beside the log for the record goes too: the payloads sent about it.
    await this.pool.query("delete from outtake where owner = $1 and record = $2", [this.owner, recordId]);
    if (redacted) await this.rebuild();
    return { redacted, witnessed };
  }

  /** Check the chain's links and, with the owner's key, its signatures (8.5). */
  async verify(keys?: Keys): Promise<ReturnType<typeof verifyChain>> {
    return verifyChain((await this.entries()) as unknown as JsonObject[], keys);
  }

  /** Empty the owner's state tables and apply the log again, in order (8.5.3). */
  async rebuild(): Promise<State> {
    return transaction(this.pool, async (client) => {
      await this.lockChain(client);
      await wipeState(client, this.owner);
      // The owner's chain and the chains of the people it hosts (14.1), in the order they were written.
      const { rows } = await client.query("select entry from log where (owner = $1 or owner like $1 || ':%') and chain = $2 order by ord", [this.owner, this.chain]);
      for (const row of rows as { entry: Entry }[]) {
        const base = await this.base(client);
        const { state } = await settle(client, this.owner, base, (s) => applyEntry(s, row.entry));
        await persist(client, this.owner, base, state);
      }
      // Projections follow: every row of every view is marked stale, so the next publish rebuilds and
      // compares them all and announces what left.
      await this.staleAll((sql, params) => client.query(sql, params), await this.projectingFrom(client));
      return loadState(client, this.owner);
    });
  }

  /**
   * Redact one write of an entry, or the whole entry (8.5.2): the log's one update, which the trigger
   * admits and nothing else. The state is then rebuilt, so the cache forgets what the log forgot.
   */
  async redact(logId: string, writeIndex?: number): Promise<void> {
    await transaction(this.pool, async (client) => {
      await this.lockChain(client);
      const { rows } = await client.query("select entry from log where owner = $1 and log_id = $2 for update", [this.owner, logId]);
      const entry = (rows[0] as { entry: Entry } | undefined)?.entry;
      if (!entry) throw new Error(`no entry ${logId}`);
      if (entry.witnessed === true) throw new Error("a witnessed entry is never redacted");
      let next: Entry;
      if (writeIndex === undefined) {
        const writes = Array.isArray(entry.writes) ? entry.writes : [];
        for (const w of writes) if (isObj(w) && !(typeof w.record === "string" && typeof w.address === "string") && !isObj(w.observation) && typeof w.read !== "string" && typeof w.redacted !== "string") throw new Error("an entry holding a write that is never redacted is redacted write by write, never whole");
        next = { log: String(entry.log), redacted: `sha256:${entryHash(entry as unknown as JsonObject)}` };
        if (entry.prev !== undefined) next.prev = entry.prev;
        if (entry.chain !== undefined) next.chain = entry.chain;
        if (entry.sig !== undefined) next.sig = entry.sig;
      } else {
        const writes = Array.isArray(entry.writes) ? [...entry.writes] : [];
        const w = writes[writeIndex];
        if (!isObj(w)) throw new Error(`no write ${writeIndex} in ${logId}`);
        if (!(typeof w.record === "string" && typeof w.address === "string") && !isObj(w.observation) && typeof w.read !== "string") throw new Error("a write that created a record, changed its envelope or a definition, or wrote an edge, binding, review, instruction, run or install is never redacted");
        writes[writeIndex] = { redacted: `sha256:${writeHash(w)}` };
        next = { ...entry, writes };
      }
      await client.query("update log set entry = $3 where owner = $1 and log_id = $2", [this.owner, logId, next]);
    });
    await this.rebuild();
  }
}

/** The facets a dictionary declares `transitions: yes` (4.2). */
function transitionsOf(dict: { facets: Map<string, { key: string; transitions?: boolean }> }): Set<string> {
  return new Set([...dict.facets.values()].filter((f) => f.transitions).map((f) => f.key));
}

/** A state copied one level down, so replayed entries apply to a fresh object while readers keep theirs. */
function copyState(st: State): State {
  return {
    records: new MemoryRecords(st.records),
    edges: new Map(st.edges),
    bindings: new Map(st.bindings),
    instructions: new Map([...st.instructions].map(([k, v]) => [k, [...v]])),
    observations: [...st.observations],
    reviews: [...st.reviews],
    runs: new Map(st.runs),
    installed: [...st.installed],
    reads: [...st.reads],
    definitions: new Map(st.definitions),
  };
}

/** What a store projects with, from the definitions in force: nothing when there is nothing to project. */
function projectingOf(p: Parsed): Projecting | undefined {
  if (!p.views.views.size && !p.dict.facets.size) return undefined;
  return { dict: p.dict, views: p.views, perms: p.perms };
}
