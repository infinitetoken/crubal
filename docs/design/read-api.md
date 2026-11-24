# A read API over the store

Draft, 2026-11-24. Status: **for the operator's rulings** (section 7). Nothing here is built.

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
- **Both backends.** Every new read is implemented by the memory backend too and proved by the corpus, as
  every store read is today (`store.md`, point 3).
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
  level?: string; kind?: string; of?: string; within?: string;
  ids?: string[];                          // B: a list of ids
  key?: [string, Json];                    // today's one value
  keys?: [string, Json][];                 // D: every one holds (containment, so the GIN answers)
  links?: { to: string; via?: string[] };  // C: records that link to `to`; `via` defaults to every
                                           //    link facet the level declares (the 0.4.14 count's query)
}, opts: {
  limit?: number; after?: number; before?: number;  // keyset on `ord`
  newest?: boolean;                                  // A: `ord` descending
  archived?: boolean;
  values?: string[];                                 // only these facets come back in `doc.values`
}): Promise<Record[]>
```

A read joined to an app table becomes two: the store returns ids (or the facets asked), the app joins on its
side. Where that doubles a hot path (the matcher's "changed since", `matcher.ts:170`), the app keeps a
cursor of its own over the log (3.3) in place of a join.

### 3.2 `count(where)` (part of group F)

The number of records `records(where)` would return, with no `limit`. One query; the same indexes. Whether
counts by a facet's value (a group-by) are the store's or a view's is ruling 1.

### 3.3 The log (group H)

```ts
head(chain?: string): Promise<{ chain: string; seq: number; hash: string } | undefined>
entries(opts?: { chain?: string; after?: number; before?: number; limit?: number; newest?: boolean }): Promise<Entry[]>
```

`entries()` with no options is today's whole log, unchanged.

### 3.4 Packages (group I)

`installed()` stays. The host adds `published(owner, pkg?)`: the versions an owner has published, from
`host_published`.

### 3.5 Keys and queues (groups K and L)

- The host adds `keys(owner)` and `revokeKey(owner, id)`. The app's two deletes (`bench.ts:1876`,
  `sources.ts:187`) go through it.
- The store adds `runs({ send?, state?, limit?, newest? })` and `intake({ ... })`. Their exact filters are
  read off `sends.ts:29` and `vocabulary.ts:34` when they are built.

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

## 7. Rulings asked

1. **Counts and reports: a declared view, or a store call?** Recommended: views (3.6), the engine's own
   rule that the index answers counts; the store keeps only `count(where)`. The cost: every report becomes
   package text. The other way: a store `tally(where, by)` for group-bys, narrower to build and outside
   the views.
2. **The app's tables move to a `cashierfu` schema?** Recommended: yes, in phase 0, so the guard can be a
   plain check on schema names. It is a production migration.
3. **One-off scripts archived, not ported?** Recommended: the ME conversion scripts and `place-128` are
   archived; the scripts still run (`row-indexes`, `index-touches`, `fill-derived` and the bench's) are
   ported.
4. **Decision 11 (one shared copy)** decides phase 5. Ruled 2026-11-18 per the holding list; confirm it
   stands.
