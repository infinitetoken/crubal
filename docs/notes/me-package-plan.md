# Media Encyclopedia's CRUBAL package: the plan

**Status:** plan, 2026-10-15. This is the first adopter package of CRUBAL 2, designed target-first: what ME's
data is when nothing from 1.0 is assumed. Converting what the catalog holds today is one pass after this
package closes, with recipes and a review queue, and is not part of this plan.

## Identity

`mediaencyclopedia.com/me`, owner `mediaencyclopedia.com`, written in `crubal: 2`. It extends
`cashierfu.com/product`, `mediaencyclopedia.com/media` and `cashierfu.com/commerce`, pins `crubal.com/units`, and uses
`crubal.com/party` for people and systems. Everything ME adds is `me:`; everything that is true of any
disc or any shop is proposed upward into the standard packages instead.

## Scope of the first version

- **In:** DVD, Blu-ray and 4K UHD Blu-ray releases of films and shows, sold as units; the shop (explore,
  browse, search, product and unit pages, cards, the filter rail, carousels, the Google feed); the bench
  (Unitizer, scanning, disc reads); eBay catalog and listing; the pricing utility; the ID allocator; signup
  and checkout.
- **Out, on purpose:** video games, music, books; the community kinds (collections, lists, notes, profiles)
  are declared under `ownership` but get their classes and views in the second version.

## What the standard packages must gain first

The package depends on standard definitions that don't exist yet. Each is CRUBAL work, done before ME's own:

| Package | Needs |
|---|---|
| `crubal.com/party` | landed 2026-10-16 (`std/party`, crubal docs/design/party.md): the `person`, `organization` and `system` kinds, one level each, with `roles&role*`, contact facets shown to staff, and the `connect` and `profile` forms; staff, customer and seller are roles and relations in this package, not classes (spec 11.7, 14) |
| `mediaencyclopedia.com/media` | classes by format (`DVD`, `BluRay`, `UHD`, each `uses: Release` and narrows `format`, `videoCodec`, `discFormat`, regions); `Movie`, `Series`, `BoxSet` by what the release carries; a `Case` part class; `edition`, `studio`, `subtitles`, `audioLanguages`, `originalLanguage`, `countryOfRelease` as standard facets |
| `cashierfu.com/commerce` | an `order` kind (order > line) with its `Order` class and the `checkout` contract shape |
| `cashierfu.com/product` | `identifiers` the market uses as a compound or as standard keys (`asin`, `upc` via `gtin`), `countryOfOrigin`; `condition` is there now as a ranked standard facet (new … poor): ME's grades (`NM`…`P`) narrow it in `me:Graded`, `subconditions` stay ME's |

## Kinds

- `item` (product): `group > product > unit`. A group is a variant group only (same release in different
  editions or regions); related-by-facet is a carousel, hand-made is a list.
- `work` (media): the film or show, a shared part read through `works`.
- `order` (commerce): what checkout creates for a buyer; the buyer holds a `consume` edge on it.
- `person`, `organization`, `system` (party): staff, sellers, customers, and the utilities.

## Facets

The draft (`crubal/me.crubal`, 137 facets converted from the 1.0 dictionary) is the input, not the output.
Each facet gets one ruling in a triage table, produced first and ruled by the operator:

| Ruling | Means | Expected share |
|---|---|---|
| **up** | true of any disc or any shop: proposed into media, commerce or product | a third |
| **own** | ME's: `me:` facet with its full definition | a third |
| **staff** | machinery and market identifiers (eBay and Google categories, epid, pricecharting, grading profile, SEO title, badges): `me:` facets with a `shown to staff` rule, never on a public view | the 23 already marked, and more |
| **retire** | nothing asks for it in 2.0 | the rest |

Rules for the table: a key never renames (a better spelling is a label); a value list is closed unless the
world fixes it; units come from the units table; anything that depends on context is a rule, not an alias.
The Phase 0 rulings (`docs/crubal/phase-0-2026-10-13.md`) are applied here, once.

## Classes

Modules become classes composed by `uses`, with ME narrowing what the standard classes allow:

- Worn by products: `me:Catalogued` (base: the identifiers and market facets every ME product has),
  `DVD` / `BluRay` / `UHD` from media, `Movie` / `Series` / `BoxSet` from media, `me:Graded` (the grading
  profile and subconditions, with `unit::` lines for what varies per unit).
- Worn by units: nothing of their own; they wear the product's classes and own the `unit::` keys
  (condition, price, sealed, subconditions, photos, location, serial).
- Parts: `Disc` (media; `match: discFormat`), `Case` (media), `me:Insert`.

## Rules

- `must`: the standard ones (listed needs price, DVD region fixed), plus ME's: a unit for sale has a grade
  and at least one photo; a 4K release has HEVC; `identifiers` unique per level.
- `should`: runtime in range, title length for listings, a product has a work.
- `suggest`: DVD is MPEG-2; format from disc format; listing title derivation `"{title} [{format}]"`;
  SEO title derivation from the pointer facet (the SEO overhaul's rule, no hardwired recipe).
- `shown to`: every staff facet, cost, location, supplier.

## Contracts

| Contract | Kind | Notes |
|---|---|---|
| `ebayCatalog` | receive | `ref: epid`, strong key `asin`, weak `gtin`; origin reported |
| `ebayListing` | send | `for: Offer`; needs title, format, price; `undo: ebayEndListing`; two-entry send |
| `unitizer` | form | the bench; origin observed; `who: caller may run unitizer` (party ruling 2: staff is a role, not a class) |
| `discRead` · `scan` · `coverOcr` | receive, `lands: observation` | evidence types `disc-read`, `scan`, `photo` |
| `pricer` | receive | the pricing utility, `lands: suggestion` |
| `ids` | receive | the CashierFu ID allocator; gives `me:cashierfuId` |
| `signup` | form | creates the person and their first edge (`consume` on the root); `relation: customer` |
| `checkout` | form | creates the order, archives the unit `sold`, grants the buyer's edge; `relation: buyer` |
| `label` | send | the label printer |
| `googleFeed` | send with `stream` | the feed is a view with a machine shape whose slots are Google's field names; the contract carries its stream to an adapter that posts it |
| `searchIndex` | send with `stream` | the site's own index |

## Views: one per display surface

Each surface declares what it reads; nothing is decided on the facet. Audiences are few; roles narrow.

| Surface | View | Audience | Notes |
|---|---|---|---|
| Explore | `explore` | public | cards; filters = the rail; `index:` the filters with their own pages |
| Browse by class | `browse` | public | one view per top-level class via `wears` |
| Search | `search` | public | `crubal:portable` beside the card shape |
| Product page | `product` (page shape) | public | slots hold `alsoOnOtherFormats`, `related`, `unitsForSale` |
| Unit page | `unit` (page shape) | public | the unit's own keys, photos, condition |
| Cards | shape `card` | | one shape for explore, browse, search and carousels |
| Carousels | `relatedByFranchise`, `sameWork` | public | `of: context.work` |
| Feeds | `googleFeed`, `searchFeed` | public | machine shapes |
| Staff catalog | `staffCatalog` | staff | partitioned `controlled`; cost and location marked |
| Seller's shelf | `myUnits` | member | `partition: relation seller` |
| Buyer's orders | `myOrders` | member | `partition: relation buyer` |

The filter rail is the `filters:` of `explore`; `index:` names the few that get canonical pages. The
"unit condition as a rail filter" question is answered here by adding it to `explore`'s filters or not.

## Access

- `permissions: me` with menu items by job (`catalog`, `bench`, `list`, `price`, `ship`, `review`,
  `grant`), presets `staff`, `bench`, `seller`, `support`; relations `customer`, `buyer`, `seller`,
  `follower`, `subscriber` (`follower` relation-only).
- `ownership: person: Collection, List, Note, Profile` (declared now, built in version two).
- Systems request items: the pricer asks `edit` on prices as suggestions; the allocator asks `edit` on
  `me:cashierfuId`; each approved as a gated `control` edge.

## Trust, thresholds, terms

- `trust: person, me:unitizer, observed, declared, ebayCatalog, reported`; `facet-trust` puts `observed`
  first for runtime, weight and barcode.
- `confirm: 2`, `split: 3`, `recur: 5`.
- `terms: public: search yes, answer yes, train …` (a decision below).

## Deliverables and proof

1. The standard-package additions above, each passing the engine's publish checks, published to crubal.com.
2. The triage table of 137 facets, ruled.
3. `crubal/me.crubal` rewritten as the 2.0 package: passes `checkPackage`, `checkViews`, `checkContracts`
   and `checkPermissions`, every public view refusing a staff facet.
4. **Adopter cases** in `crubal/cases/`: corpus-shaped cases over ME's package (a product arriving from the
   eBay catalog; a Unitizer observation confirming a runtime; a checkout archiving a unit and granting the
   buyer's edge; the explore view's projection and stream; the seller's shelf partition), run by the
   engine's corpus runner against the package.
5. The package installed on the reference host over a Postgres store, with the adopter cases passing there.

Conversion of the 1.0 catalog is the step after: one pass, recipes per facet, a review queue, nothing dropped.

## Decisions for the operator

- **The triage** of 137 facets: I produce the table with a proposed ruling each; you rule. Expect a week of
  rulings in batches rather than one sitting.
- **What is public among identifiers:** ASIN, UPC and the like on public pages, or staff only.
- **AI terms for ME:** `train yes` as on crubal.com, or `train no` for the shop.
- **Sellers in version one:** ME as the only seller (units owned by the host, staff list them), or third-party
  sellers with `relation seller` and their own shelf from the start.
- **Unit condition on the rail:** in `explore`'s filters or not.
- **Community kinds:** declared only, as proposed, or classes and views in version one.
