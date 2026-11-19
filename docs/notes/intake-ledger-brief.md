# Brief: the intake ledger — facets without the reconcile loop

Status: agreed in discussion 2026-10-15, not built. Spec: crubal repo `spec/09-intake.md` (intake and
review), `spec/04-facets.md` §4.1 (identity, lifecycle), `spec/11-packages.md` (packages, kinds).

## What changes

Facets stop being discovered from data and start being decided. Foreign metadata is kept exactly as it
arrived. Each foreign key gets one recorded decision. Our facets are produced from the raw data plus those
decisions, and can be produced again at any time with the same result. The 1.0 tables keep running, but
only as output that the current pages read.

## Why

This is the seventh facet reconcile, and the ghosts keep coming back. The cause is in the engine, not the
data:

1. **The data writes the dictionary.** `facet_conformance_slice` and `register_facet_keys` add a
   `facet_curation` row for every key they find in stored metadata. Any importer, enrichment job, eBay pick,
   bulk edit or test that writes a stray key creates a facet. Delete the row and the next walk puts it back
   (`strip_facet_key` documents having to work around exactly this). The 25 "no type" rows from Oct 13
   (`cover_art`, `images`, `source`, `sku`, `itemId`, `_test_new_facet_*`) all came in this way.
2. **Nothing checks writes.** No write path asks whether a key is in the dictionary or whether a value fits.
3. **One fact has several addresses.** Bare and nested (`imdbId`, `Content.imdbId`), two levels
   (`MSRP.*` on both product and unit), two spellings (`coverArt`, `cover_art`). The page renderer falls
   back between them, so duplicates never fail visibly, and nobody can tell which copy is live without
   reading prod.
4. **A facet's type is stated in several places.** The definition, each class placement, code tables, and
   now the package file. A reconcile fixes one place and the rest still disagree.
5. **Fixes are snapshots.** Each reconcile is a one-off migration. Nothing enforces the result afterwards,
   and later function rewrites have twice silently dropped an earlier fix.
6. **One universal dictionary.** It doesn't scale, and a key loses its meaning without context.

## The model

### Raw records, kept forever

Everything that arrives from outside is stored as received: source, received time, the exact payload and
its hash, per object (products now, units the same way). That covers imports, eBay, AI enrichment, scans,
and today's `products.metadata` as a one-time `legacy` source. Raw records are never edited.

### The decision ledger: one decision per foreign key

Keyed by **source + key path** (eBay's `label` and an import's `label` may mean different things). Every
key has exactly one state:

| Decision | Effect |
|---|---|
| *(none)* | in the review queue |
| **ignore** (the default) | stays on the raw record, never becomes a facet, can be revisited later |
| **delete** | dropped at intake; reserved for real junk |
| **map** | converted to an existing facet, with an optional conversion (length → `upc`/`eanCode`, etc.) |
| **create** | a new facet is added as a *candidate*, then the key maps to it |

- Values get the same treatment. When a key maps to a choice facet, each raw spelling (`Blu-Ray`, `BD`)
  gets one recorded decision: map to a value, add as a new value, or reject.
- Decisions can be patterns ("ignore everything eBay sends under `_internal.*`").
- AI may propose decisions. It never applies them. A proposal shows the counts and examples beside it.
- Review is by key across every object, never object by object: `ebay:Studio`, 40,112 objects, 812
  distinct values.
- A decided key never comes back to the queue, including on data that arrives next year. The queue can
  only shrink.

### Decoding: facets = raw records + decisions

Decoding runs the decisions over the raw records and writes the facet values. It is deterministic and
safe to repeat. Changing a decision means rerunning decoding for the affected objects, never editing them
by hand. Values written by a person in the editor are not raw intake: they go through the same check and
must conform before they save. When a person and an import disagree, the trust order (spec §11.3) picks
the current value.

### Facets are scoped

- **Ownership is scoped by package.** No universal dictionary. Each package owns its facets, and keys
  carry their owner (`me:videoCodec`). Today: ME's video package on top of the shared `media` and
  `commerce` packages. Video games come later as their own package, not as more rows in this one.
- **Relevance is scoped by class.** A value is valid on an object only when a class the object wears asks
  for that facet. `discFormat` means something on an Optical Disc product and nothing on a game.
- **Not one facet per class.** The same fact in two classes is one facet, shared through a module both
  classes use (`regionCode` on DVD and Blu-ray). The same word with two meanings is two facets with two
  keys.

### Placement: by request, with suggestions

A new facet starts as a candidate and is unplaced: valid and decoded, but not shown on any class.
Placing it (on its own, in a module, in a class) is a design decision the operator makes. The system can
suggest a placement ("always appears with these four keys on Blu-ray products"). Unplaced facets get their
own list, which also only shrinks. The type lives only in the definition; a placement chooses where a facet
appears, never what it is.

### Rules that keep it from looping

1. A dictionary row is created only by a *create* decision or by hand, never because a key was seen in data.
2. Facet values are written only by decoding or by a checked editor write.
3. One address per fact. Old spellings live in an alias map that converts them at decoding. The page
   renderer stops falling back between addresses.
4. Two numbers are always visible and should only go down: keys without a decision, and facet values that
   don't conform. A standing check alarms when either goes up.

## How it sits on the 1.0 engine

No rewrite and no flag day. 2.0 sits in front:

- **2.0 is where everything is authored:** raw records, the ledger, the package files. Every write and
  decision goes through them.
- **1.0 becomes output.** `facet_curation`, `products.metadata` and the class tables are generated from
  2.0. The current pages and the ~20 SQL functions keep reading them unchanged. Nothing writes to them
  directly anymore.
- **Displays move to 2.0 one at a time** later. That is the work paused until 2.0.

## First step, and why it is bigger than first said

In discussion I called "switch off the automatic registration" a small first step. Reading the code, it
isn't a switch:

- Registration is deliberate, tested 1.0 behaviour. New keys arrive as hidden, unreviewed rows (the
  "arrivals lane"), and about ten DB test suites assert it (`facet-key-registration`,
  `authored-facet-pipeline-db`, `meta-defs-curated`, `admin-facets-strip` and others).
- The conformance walk registers and judges in the same pass, so removing registration changes what the
  walk judges.
- `register_module_child_keys` is different: it creates rows from class declarations, not from data. It
  stays for now, but it is where the untyped nested rows (`Manifest.*`, `Cut.cutName`, `Cast.character`)
  come from, because a placement can declare a child with no type.

So step 1 is to **redirect, not delete**: the walk and `register_facet_keys` record an unknown key in the
ledger's review queue instead of creating a `facet_curation` row. The arrivals lane then reads the ledger.
That stops new ghosts without losing sight of new keys, and it is the ledger's first table.

## Build order

1. **Ledger table + redirect.** The ledger (decisions keyed by source + key path), with the two observation
   registrars writing unknown keys there instead of into the dictionary. Update the tests that assert
   registration.
2. **Raw records.** The intake record table, and snapshot today's `products.metadata` as the `legacy`
   source. Read-only: nothing changes on products yet.
3. **The review screen.** One row per undecided key across all objects, with counts, examples and the four
   decisions. Value decisions for keys mapped to choice facets.
4. **Decoder.** Decisions + raw records → facet values, writing the 1.0 tables. Run it on a copy first, and
   diff the output against today's data before it writes anything real.
5. **Writers move over.** Importers, enrichment, eBay pick and bulk edit write raw records instead of
   metadata. The editor writes through the check.
6. **Standing check.** The two numbers, visible in admin, with an alarm.
7. **Today's 34 and the rest of the backlog** are decided in the review screen as ordinary ledger rows.
   No separate reconcile.

## Open questions

- **First-pass scope.** All legacy product data, or only DVD and Blu-ray with video-game keys parked as
  ignored?
- **Units.** Unit metadata is written by the Unitizer, a person, not an import. Does it need raw records, or
  only the editor's check?
- **Where raw records live.** In ME's database, or in Cashierfu as the platform layer?
