# A read API over the store

Draft, 2026-11-24. Status: **ruled** (section 7, all four as recommended, 2026-11-24). Phase 0 built in the
cashierfu repository (pull request 29); phase 2 built here as 0.4.15 (section 8).

The One Clean Stack plan, step 4: CashierFu stops running SQL on the engine's tables. Today it does, in 41
files of its `lib/` and 9 of its scripts (`engine-holding-list.md` line 7 in the cashierfu repository; that
count may not grow). This draft says what the engine adds so each of those reads has a public door, and in
what order.

## 1. What holds

- **In process, not over the network.** CashierFu runs the engine inside itself, on one database, and never
  calls hosted Crubal (One Clean Stack, decision 1). The API is TypeScript on `PgStore` and `Host`. The HTTP
  surface may grow from it later; nothing here waits on that.
- **The store answers by key, by selection and by condition; the index answers pages, counts and search**
  (`store.md`, point 6 and "Reads"). Every addition below is one indexed query over the store's tables, or a
  declared view served by the index. No addition loads the whole state.
- **Proved on Postgres.** These are reads of the store's tables, as `get`, `records` and `installed` are; the
  memory backend has none of them (its whole state is in hand). Each is proved in the Postgres suites
  (`crubal-postgres/test/read-api.test.ts`, the host suite). Corrected 2026-11-24: the first draft said both
  backends and the corpus.
- **Owner-scoped first.** A store is one owner's. Reads across owners are the host's and are few, named and
  separate (phase 5).
- **The app writes no engine table.** It writes none of records, log or chains today; the few writes it does
  make (indexes, API keys, index tables in scripts) each get a door or go.

## 2. What the app asks today

From a read of the cashierfu repository at `brief/128-one-kit`, 2026-11-24. The app's SQL is unqualified and
reaches the engine's tables through `search_path`; its own tables share the `crubal` schema.

| Group | The question | Files | Today's door |
| --- | --- | --- | --- |
| A | Records of a level or kind at an owner, newest first or by `ord`, archived left out | 9 | `records()`, oldest first only |
| B | Records by a list of ids | 5 | `getMany()` |
| C | Records that link to a record: by `of`, `within`, or a link value | 5 | `records({ of })`, `records({ key })` for one facet |
| D | Records by several values at once, through the values index | 9 | `records({ key })`, one value |
| E | Search by name (`lower(..) like`), and full-text over index rows | 4 | a view's `q`, through the index |
| F | Counts, group-bys, facet value counts, percentiles | 9 | none |
| G | Index rows by view, version, audience and bucket | 4 | `Index.serve` |
| H | A chain's head; the log after or before a position | 7 | none (`entries()` is the whole log) |
| I | Packages in force; published versions | 5 | `installed()`; none for published |
| J | Which owners are due a loop pass (`due.ts`) | 1 | none |
| K | API keys: list and delete | 4 | none |
| L | The last failed run of a send; the intake queue | 2 | none |
| M, N | Reads joined to the app's own tables (numbers, pending catalog, picture sizes) | 3 | none |

The app also **creates indexes on `records`** at run time (`records_awaiting`, `records_active`,
`records_undelivered`, `records_following`, and the `records_q_*` set of `row-query.ts`), because the reads
above needed them on a catalog of a million rows.

## 3. The additions

### 3.1 `records(where, opts)` grows (groups A to D, M, N)

Backward compatible: every call that works today returns the same.

```ts
records(where: {
  level?: string; kind?: string; of?: string | string[]; within?: string | string[];
  ids?: string[];                          // B: a list of ids
  key?: [string, Json];                    // today's one value
  keys?: [string, Json][];                 // D: every one holds (containment, so the GIN answers)
  has?: string[];                          // D: each of these keys holds some value
  links?: { to: string | string[]; via: string[] };  // C: records whose link names `to`, through the facets
                                           //    named (the 0.4.14 count's containment; `via` is required)
}, opts: {
  limit?: number; after?: number; before?: number;  // keyset on `ord`
  newest?: boolean;                                  // A: `ord` descending
  archived?: boolean;
  values?: string[];                                 // only these facets come back in `doc.values`
}): Promise<Record[]>
page(where, opts): Promise<{ records: Record[]; next?: number }>  // the cursor for the next page
```

`page` was added in the building: a record does not carry its `ord`, so a caller of `records` could not page.

A read joined to an app table becomes two: the store returns ids (or the facets asked), the app joins on its
side. Where that doubles a hot path (the matcher's "changed since", `matcher.ts:170`), the app keeps a
cursor of its own over the log (3.3) in place of a join.

### 3.2 `count(where)` (part of group F)

The number of records `records(where)` would return, with no `limit`. One query; the same indexes. Whether
counts by a facet's value (a group-by) are the store's or a view's is ruling 1.

### 3.3 The log (group H)

```ts
head(): Promise<{ seq: number; hash: string | null }>          // the store's chain; seq 0 before any entry
log(opts?: { after?: number; before?: number; limit?: number; newest?: boolean; drains?: boolean }): Promise<{ seq: number; entry: Entry }[]>
```

`entries()` stays the whole log, unchanged (`verify` reads it). `log` carries each entry's number, which the
app's cursors need; `drains: false` leaves out the drain's own entries, as two of the app's reads do.

### 3.4 Packages (group I)

`installed()` stays. The host adds `published({ owner?, package?, ids? }, { latest?, text? })`: the versions
published, from `host_published`; `latest` keeps each package's latest by the version order (11.8), and `text`
brings the text and bundle of the versions returned only.

### 3.5 Keys and queues (groups K and L)

- The host adds `keyedCallers(owner)` and `revokeKeysOf(owner, caller)`. The app's two deletes
  (`bench.ts:1876`, `sources.ts:187`) go through it.
- The store adds `runs({ contract?, record?, state? }, { limit? })`, newest first, and
  `intakes({ for?, contract? })`, in the order received and without the raw bytes (from `sends.ts:29` and
  `vocabulary.ts:34`).

### 3.6 Counts and search through views (groups E, F, G)

Reports, a lane's chip counts, the figures and storefront search become views declared in packages and
served by the index, which already pages, searches (`q`), counts by bucket and sums (spec 12.3). What the
index lacks today, if ruling 1 goes this way: a percentile, and counts nested under a group. Each would be a
spec change, proposed separately.

### 3.7 Indexes the engine owns (the app's run-time DDL)

A package says which keys a level is read by, and the engine makes and keeps the indexes. The app's
`ensure*Index` functions and `scripts/row-indexes.mts` go. This is a word in the language and so a spec
change; it is drafted after 3.1 shows which of the app's indexes the new `records()` already makes
unnecessary.

### 3.8 Across owners (group J and the rest)

- `due.ts` asks the host which owners need a loop pass, mixing the engine's cursors with the app's loop
  tables. The host adds one call per question it asks ("owners whose head is past their projection
  cursor", and so on), returning owner ids; the app keeps its own tables and filters.
- The other reads across every owner (picture shapes, the catalog store, commons works, settlement,
  short-id resolve, consumers, subjects) mostly serve the per-place mirrors of shared records. One Clean
  Stack decision 11 replaces those mirrors with one shared copy; these reads are not ported until that is
  ruled, and most should go with the mirrors.

## 4. The order

| Phase | What | Where | Release |
| --- | --- | --- | --- |
| 0 | A guard: a check that counts the app's files running SQL on engine tables, held in a record that may only go down. The app's own tables move to a schema of their own (ruling 2) | cashierfu | none |
| 1 | Reads the engine already answers move to their door: B to `getMany`, I to `installed`, the plain cases of A to `records` | cashierfu | none |
| 2 | 3.1 to 3.5 | crubal, then cashierfu | one engine release |
| 3 | 3.6 | crubal (spec), packages, cashierfu | per word |
| 4 | 3.7 | crubal (spec), packages, cashierfu | one |
| 5 | 3.8 | crubal (host), cashierfu | after decision 11 |

Each phase ends with the guard's count lowered in the same change, and the holding list's line 7 struck when
the count reaches zero.

## 5. How it is proved

- The corpus runs every new read on both backends.
- In the app, each moved read is compared before and after on the rehearsal place's data: the same rows, in
  the same order.
- The timings the app's comments record (1.3 s scans, a 15 s grouped max, a 4.3 s cold run) are measured
  again through the new door on a copy of production's size before the old query is deleted.

## 6. Not in this draft

- The HTTP form of any of it.
- The enricher, which will be a client of Crubal's public API, not of this.
- The 2 tests that touch engine tables (`test/channels.test.ts`, `test/operations.test.ts`): they move with
  the code they test.

## 7. Rulings (2026-11-24, the operator: "1. agreed 2. yes 3. yes 4. yes")

1. **Counts and reports: a declared view, or a store call?** Ruled: views. Recommended: views (3.6), the engine's own
   rule that the index answers counts; the store keeps only `count(where)`. The cost: every report becomes
   package text. The other way: a store `tally(where, by)` for group-bys, narrower to build and outside
   the views.
2. **The app's tables move to a `cashierfu` schema?** Ruled: yes. Recommended: yes, in phase 0, so the guard can be a
   plain check on schema names. It is a production migration.
3. **One-off scripts archived, not ported?** Ruled: yes. Recommended: the ME conversion scripts and `place-128` are
   archived; the scripts still run (`row-indexes`, `index-touches`, `fill-derived` and the bench's) are
   ported.
4. **Decision 11 (one shared copy)** decides phase 5. Ruled 2026-11-18 per the holding list; confirmed
   2026-11-24.

## 8. Built: 0.4.15 (2026-11-24)

On the branch `engine/read-api`. Pushing, the pull request and publishing are the operator's.

- `PgStore`: `records` grown and `page` (3.1), `count` (3.2), `head`, `log` and `lastSeq` (3.3),
  `bundlesInForce` (3.4), `runs` and `intakes` (3.5). The types `RecordsWhere` and `RecordsOptions` are exported.
- `Host`: `published` (3.4), `keyedCallers` and `revokeKeysOf` (3.5). The app's two key deletes are by
  owner and caller, which `revokeKey(raw)` could not do.
- Proved on a Postgres 17: the engine's suite 258, the store's 53 (8 of them the read API's), the host's 25
  (one new, and the published-versions checks inside the publishing test), all passing.
- No spec revision: nothing in the language changed.

## 9. Built: 0.4.16 (2026-11-24)

Two reads the app's last log and index queries wanted, found moving the app onto 0.4.15:

- `PgStore.logBrief({ limit, before, writes })`: the chain's entries newest first, each told briefly (its log
  id, moment, `by`, how many writes, the first few, the records touched), so an audit screen never loads a
  restamp's thousands of writes. The ledger's query, moved into the store.
- `Index.position(owner)`: the sum of an owner's view cursors, which a built page is stamped with.

Proved on Postgres 17: the engine's suite 258, the store's 55, the host's 26, all passing.

## 10. Phase 3, designed (2026-11-24): for the operator's rulings

Read off the 15 files still on the record for range, search and count reasons, query by query, and off what
views and the index do today (spec 12; `crubal-host/src/indexer.ts`). Nothing here is built.

### 10.1 What the reads turned out to be

They are two kinds, and ruling 1 (views, not a store tally) fits only one.

- **Screens a person browses**: the Content tower's counts, chips and word search (`row-query.ts`), the sales
  and inventory reports (`aggregates.ts`), a report's buckets (`events.ts`), the catalog's search
  (`catalog.ts`, `aggregates.ts` `searchProducts`), a product page's nested rows (`storefront.ts`), the
  storefront's suggest (`storefront-search.ts`), the record finder (`record-finder.ts`). A view is right for
  these: they page, count and search what a person looks at, and an index's lag is fine.
- **Operational reads that must be current**: the message rate limits (`messages.ts` 85, 87), the bench's
  counts of today (`bench.ts`), archiving old events (`stamps.ts`), delivering notifications
  (`notifications.ts` 962), the matcher's products with no work (`matcher.ts` 465), the threads an order
  change speaks in (`messages.ts` 707). A view is wrong for these: the index lags its log, a selection's `now`
  is frozen when a row projects (12.6), and spec 12.6.2 says an action checks the store, not an index.

### 10.2 What views and the index lack today

| Need | Today | Which reads |
| --- | --- | --- |
| A range on a moment or date (before a cut, since an instant, today in a zone) | Period buckets by the date as written, numeric `a..b` only; no zone, nothing relative to now | bench, stamps, messages, figures, aggregates (sales, increments), row-query (late) |
| Top N values by count | `list` gives the first N in view order | facet-edit, row-query chips, events |
| A sum crossed with a second filter; a percentile | Sum per bucket of one filter; no percentile | aggregates (sales by channel), figures |
| Search by prefix, on named facets, or-ed with an exact key | `q` is whole words over every string in the row, unranked | row-query, record-finder, aggregates, catalog, storefront-search |
| Keyset paging; reading rows by record ids | Offset pages only | messages (threads), catalog |
| Conditions over children (a unit with a live offer) | Read-through and rollups, but liveness against `now` goes stale | aggregates (live units, inventory), row-query |

### 10.3 Proposed

**3a. The store, no spec change (0.4.17).** Three more selections on `records`, `page` and `count`:
`range: [facet or "created" or "updated", { after?, before? }]` (text order, which is ISO moment order; read
inside the level's or kind's index, as the app's SQL does today), `lacks: string[]`, and
`keys` taking a value list (`in`). Moves the operational reads: bench, stamps, the rate limits and `systemLine`
in messages, notifications' delivery, the matcher's two loops. Small periodic sums (`figures.ts` every six
hours, `incrementCounts` daily, `liveListingsOn`) list their records through the same range and count in the
app: a percentile over a few hundred orders needs no spec.

**3b. The index, one spec revision (12.3, 12.6.1).**
- `search:` on a view: the facets `q` reads, matched by prefix (`word:*`), and `exact:` keys a whole `q`
  matches by equality (gtin, cashierfuId). Ranked as the design doc already claims, or the claim struck.
- Counts of an unlisted filter's top N by count, not the first N in view order.
- A filter's sums crossed with a second filter (`dependent` carrying `sum`).
- `serve` reads rows by record ids, and pages by keyset on the view's order.
Moves the screens: row-query, record-finder, catalog, storefront, storefront-search, events, and the
search and sales parts of aggregates.

**3c. Package text, no engine change.** Children's conditions become rollups the packages declare (a unit's
count of live offers; a product's units in stock), so a view filters on a field. Liveness against `now`
(`until`) stays a loop that writes a state when an offer lapses, not a condition read at projection.

**Left out.** `facet-edit.ts` counts the values of any key across every level: an operator's tool, rare, and
no view spans every level. It keeps its SQL until it is redesigned, or takes a narrow store read by exception.
The inventory report (`aggregates.ts` 468-497, 238 s under a walk) is the hardest: it is 3c's rollups plus 3b's
counts, last.

### 10.4 Rulings asked

1. **Narrow ruling 1**: operational reads that must be current go to the store (3a, no spec change); views
   serve the screens (3b). Recommended: yes.
2. **Small periodic sums computed in the app** from a ranged list, rather than percentiles in the spec.
   Recommended: yes.
3. **One spec revision for 3b** (search by prefix on named facets with exact keys; top N; sums by a second
   filter; reads by id and keyset). Recommended: yes, drafted after 3a ships.
4. **`facet-edit.ts`** keeps its SQL for now. Recommended: yes; it is the one file left on the record by design
   until the field screen is redesigned.
