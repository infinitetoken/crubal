# CRUBAL 2 vs the Token Universe: gap analysis

**Date:** 2026-10-14. Read-only survey of the earlier CRUBAL system, to decide whether the CRUBAL 2 reference
implementation evolves it or starts fresh.

## What exists

| Piece | Where | State |
|---|---|---|
| **CRUBA engine** `@nes4less/core` | `nes4less/kit` `packages/core` (~2 MB of TypeScript in 60+ modules) + 128 SQL migrations | the platform engine: tokens, flows, transports, rendering |
| **Facet Library** | `nes4less/shell` `api/facets/` (155 files) | the facet server behind `facets.crubal.com`; live today, serving `cashierfu.Product v1` |
| **crubal.com** | `nes4less/shell`, on Vercel | live web app on Supabase (`crubal_tokens`, `cruba_edges`) |
| `@cruba/render` 0.0.8 | npm, Jun 19 | compiles the facets feed to HTML or a JSON node graph |
| `@cruba/core` 0.1.0 | npm, Apr 5 (`TokenBase`) | 39 universal base models, traits and compounds (Entity, View, Filter, Product, Unit, Order…) |
| Tokenbasement | `nes4less/Tokenbasement` | a hardware-up computing architecture spec (C ABI headers in kit) |

ME depends on none of it: no reference to `crubal.com` or `@cruba/*` anywhere in this repo.

**Scope is the first finding.** The Token Universe is an application platform: peer-to-peer sync, transports
(down to acoustic encoding), a flow VM with lowering to SQL, a render tree, identity and trust scoring,
handshakes between parties, an encryption-backed visibility stack, AI copilots, diagnostics, a kernel ABI.
CRUBAL 2 is one layer of that idea: the facet-level language and engine. Most of the Token Universe is outside
CRUBAL 2's scope, neither kept nor replaced by it.

## Chapter by chapter

| Ch | CRUBAL 2 | Token Universe has | Verdict |
|---|---|---|---|
| 1 Data | records with an envelope, three empties, qualifiers, sources | **tokens**: `{id, collection, data, createdAt, updatedAt, createdBy}`; value types `text, number, enum, date, ref, url, query, select_one, select_many, gradient, image, module_ref` | **rewrite.** The token is a thinner envelope (no kind, level, owner, wears). The value types map: enum/select → choice, ref/url → link, module_ref → compound, gradient → scored choice or ranged number; `query` has no CRUBAL 2 equivalent (it's a view) |
| 2 Text | the pairs grammar | none; JSON only, plus `{path \| transform}` templates | **new** |
| 3 JSON | `$`-tagged values, sources map, canonical form | the **feed** (`shape → modules → keys`) and the **portable contract** (two flat lists, facets and modules) | **rewrite.** The portable contract's idea, a payload readable with zero connection, is CRUBAL 2's border wrapper |
| 4 Facets | definition, aliases, open/closed/fixed, versions | **`meta_def`** (key, aliases[], value_type, scope, cardinality, options, number bounds) and **`facet_def`** headings; **gatekeeper**: new defs land as candidates, are matched by `matchSimilarDefs`, a human promotes or merges into aliases; "the agent advises, never authorizes" | **keep the ideas, port the data.** The gatekeeper is chapter 9's review, almost word for word. `matchSimilarDefs` is a good reference for alias-collision checks |
| 5 Classes | composition by `uses`, meet, narrowing only | **taxonomy forest** (`classification_nodes`, Media > Movies > DVD) with **expected defs** inherited by ancestor walk (union) | **rewrite, mechanically convertible.** Each node becomes a class that `uses` its parent; since expected defs only add, the union is the same as the meet. Requiredness becomes `!` |
| 6 Rules | when → then, three strengths, productions | validation rules (required, min, max, length, pattern, custom, type-match), anti-spam and block guardrails, conditional prediction | **rewrite.** No strengths, no productions, no layering check. The validation lowering ("lower, don't bolt on": a schema becomes the rules the write boundary enforces) is the same principle as chapter 4's shortcuts |
| 7 Contracts | borders: send, receive, store, form, offer/take | **"contract" means commerce here**: financial terms on handshakes, escrow, fulfilment. Borders are **handshakes** (party connections with terms and tiers), **resolver chains** and **source catalogs** | **rewrite; rename the old one.** Old "contracts" are commerce-package machinery (agreements). Handshakes are the nearest thing to offer/take. Resolver chains are receive contracts |
| 8 Provenance | origin/via/owner, hash-linked signed logs | append-only **LogEntry** with before/after snapshots and transaction IDs; **delta-based versioning** (`VersionChain`), replicated peer to peer (Gondola) | **keep the log's shape as a reference, add what's missing**: hash links, signatures, the per-value source map. Peer-to-peer replication is beyond CRUBAL 2 (no consensus); it could be one transport for Exchange |
| 9 Intake | fold, six outcomes, review, evidence, consensus | the strongest overlap: **classify cascade** (evidence legs → mechanical consensus → write contract), **reconcile** (have-vs-expected and insert/update/skip/conflict with provenance), **title cascade**, **contained work** (a DVD contains works, keyed by imdb_id), **wildcard bag** (tier-3 item notables), `product_source_attempts` ledger | **keep as package machinery.** These are ME/media algorithms, not core. They become receive contracts and evidence contracts in a media or ME package, conforming to chapter 9's outcomes. Contained work is CRUBAL 2's shared Work part; the wildcard bag is unknown keys plus review |
| 10 Migrations | recipes and restamping | lazy migration (v6 JSONB → tokens), SQL migrations | **new** |
| 11 Packages | `domain/name`, versions, extends, trust | environments and namespaces (`cashierfu.Product v1`), publish with capability tokens, `principal_grants` | **rewrite.** Namespaces become package identities under crubal.com |
| 12 Views | selection + shape, filters, audiences, roles, projections | **render tree compiler**, `@cruba/render`, display and group tokens, a **six-layer visibility stack** with encryption boundaries, **lowering** pure-read flows to one Postgres SELECT, capability-token public render, `role_policies` and grants | **rewrite, reuse pieces.** `@cruba/render` is a shape renderer target. The visibility stack is replaced by five audiences and roles. The lowering compiler is the right technique for stored projections and SQL-compiled rules |
| 13 Conformance | levels and a corpus | unit tests | **new** |

## Name collisions to settle

| Word | Token Universe | CRUBAL 2 |
|---|---|---|
| contract | commerce terms on a handshake | a border where values cross |
| shape | a consumer's lens onto a type (a class, in effect) | a view's display slots |
| module | a UI group of keys | an authoring word only |
| scope | product vs unit (on `meta_def`) | levels |
| token | every record | (none) |
| CRUBA | the engine's verbs: create, read, update, block, archive | (none) |

CRUBAL 2 has no "block" and no "archive": records are never deleted, and removals are log entries. If you
want a soft-hide verb in CRUBAL 2, it is `held` (chapter 6.7) or a `show` rule.

## Recommendation

**Start the reference implementation fresh, and harvest specific pure modules as references.** Evolving
`@nes4less/core` would import the Token Universe's scope (tokens, blocks, snapshot logs, P2P, flows) into a
language that settled on different foundations. The old code is still valuable, file by file:

| Harvest | For |
|---|---|
| `expression/parser.ts`, `resolver.ts` | templates (6.4.1); CRUBAL 2 drops pipes and `??` |
| `query/predicate.ts`, `query/types.ts` | the condition evaluator (6.3), minus three-valued empties |
| `vocabulary/match-defs.ts` | alias collisions (4.3) and review suggestions (9.5) |
| `lowering/compile-select.ts` | compiling views and rules to SQL (12.6) |
| `_reconcile.ts`, `_classify-consensus.ts` | conflicts and consensus (9.3, 9.7) |
| `@cruba/render` | a shape renderer for HTML and JSON (12.1) |

**Publish the new implementation as `@cruba/crubal`** (`@cruba/core` is TokenBase's). Keep the Token Universe
packages as they are.

## Decisions this needs from you

1. **Fresh implementation with harvesting**, as above, or evolve `@nes4less/core`?
2. **crubal.com:** it serves the old app and the live facets feed today. Should the new spec take over the root
   domain (the spec, the registry, `crubal.com/core`…) with the old app moved to a subdomain, or retired?
3. **The live feed** at `facets.crubal.com`: is anything still reading it? Nothing in ME does.
4. **The Facet Library's data** (`meta_def`, the taxonomy, expected defs): migrate it into a CRUBAL 2 media
   package (it converts mechanically), or leave it with the old system?
