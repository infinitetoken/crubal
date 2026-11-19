# CRUBAL pages and forms: fluid, SEO-aware UI from the same language

**Status:** direction approved for development by the operator, 2026-10-13 ("I would like to develop this").
Theory only so far; nothing built. Companion to `docs/crubal/README.md`.

## The idea

A page is pairs too. Today `app/(customer)/page.tsx` stacks the home clusters in a fixed order (the name and
one sentence, search, a tile per catalog, For You, the lists switched on for home, Just In, How a Unit Gets
Here, the trust strip, email signup). Its sentences already come from Settings and its lists can be switched
on, but the order, what each card shows, and the structured data (`lib/seo/jsonld.ts`, `merchant-feed.ts`)
are hand-written. In CRUBAL the page becomes a short declaration, and the code becomes a small kit of
well-designed blocks that the declaration arranges and feeds:

```
page: home
  title: "{site.name}: used movies and games, graded by hand"
  blocks:
    - block: hero                 // the one h1 and sentence
    - block: search
    - block: tiles
      from: catalogs where visible is yes
      card: catalogTile
    - block: list
      heading: Just in
      from: units where status is active, newest first
      card: unitCard
      show: 12, then "Load more" and page links
    - block: steps                // how a unit gets here
    - block: trust
    - block: signup

card: unitCard
  shows: packagedImage, title, format, unit.condition, price
```

## What it buys

- **Fluid without code.** Reorder or switch blocks in Settings. A new catalog type gets tiles, cards and pages
  because its facets are declared.
- **One card, many places.** The same card declaration draws the home tile, the search result, the shelf label
  and the eBay preview; each facet draws with its own control (DISPLAY and COLLECT read the same definition).
- **SEO from the same declaration.**
  - Structured data: each facet's `same-as: schema:…` lets any card emit Product/Offer, a list emit
    ItemList, a catalog address emit BreadcrumbList. No hand mapping.
  - Titles and descriptions from facet templates (`"{title} [{format}]"`).
  - Headings by rule: the first block owns the one h1, block headings are h2.
  - Image alt text from the image facet plus the title.
  - Canonical URLs and paging links from the catalog address and the list.
  - Indexable filters: a facet declares whether its filter pages deserve indexing (`index: yes`), so format
    and platform pages are indexed and endless combinations stay out of Google (no crawl traps).
  - The Google Merchant feed becomes a contract, like eBay.
- **Forms are contracts.** A form is a contract's `needs` drawn with each facet's control: the Unitizer, the
  editor, customer corrections, PreScan settings, checkout's address, email signup. Validation comes from the
  definitions, so it cannot drift from what the database accepts.

## Lines to hold

- **The language picks blocks and data; components own the look.** A small hand-built block kit (hero, tiles,
  list, steps, trust, signup, …). Fully configurable pixels make every page generic. This is the operator's
  rule that widgets self-assemble from authoring, with no per-screen special rules.
- **Server-rendered, from stored data.** Page declarations are compiled once at publish into a cached plan,
  never interpreted per request. Lists read stored, indexed projections, never derived on read (the old
  `catalog_filter` cover subquery is the lesson).
- **Read the Next.js docs in `node_modules/next/dist/docs/` before writing any of it** (AGENTS.md).

## Open questions (operator)

1. Add `index: yes` (indexable filter pages) to the language now?
2. Where in the build order: after contracts (current recommendation), or the home page as the first proof?
3. Block kit v1: which blocks, and what each may be configured with.

## Next steps

1. Mockup: the home page written as a CRUBAL declaration beside the page it produces and the JSON-LD it
   emits (as an Artifact, for approval, per the mockup rule).
2. Inventory the home clusters and `lib/seo/*` into blocks, cards and SEO rules.
3. A page/card reader in `lib/crubal` (same pairs reader; new keys `page`, `block`, `card`, `shows`, `from`).
