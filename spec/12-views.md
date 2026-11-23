# 12. Views

A **view** is a curated display that data is mapped into: a selection of records, given a shape. Catalogs,
carousels, search results, landing pages and a product's own page are all views. Views read; they never
write. Like contracts, they refer only to rules, classes and facets.

A view has two halves. **The store decides**: which records, which values, for which audience, because that
needs the rules and the audience. **An index serves**: pages, counts, search and caching, because that is
performance and presentation (12.6).

## 12.1 Shapes

A **shape** is the display side of a view: named slots, filled by map lines exactly like a send contract's
`writes` (chapter 7.3), in the direction values flow.

```crubal
shape: card
  slots:
    cover -> image
    listingTitle -> heading
    "{format} · {releaseDate}" -> line
    least of unit::price -> price
    count of unit::status -> available
```

- The left side of a slot line is an address, an aggregate (chapter 6.3), a template (chapter 6.4.1) or a
  literal. Nothing else: a shape never computes.
- A slot whose value is empty is left out of the projection. A shape MAY mark a slot `!` to drop the record
  from the view when that slot is empty (`!cover -> image`).
- One shape serves many views: the same `card` in a catalog, a carousel and search.
- **Machine shapes** (`format: json`, `json-ld` or a package-defined feed such as a UCP catalog) give the
  same projection to software instead of people: agents and feeds get complete, structured facets without
  reading pages. A view MAY name several shapes (`shape: card, feed`); they share one selection, one
  projection's freshness and one read set.
- **The portable shape.** The core package defines `crubal:portable`, the default machine shape: every
  value as `{"key", "label", "type", "value"}`, where `value` may be empty but the other three are always
  present, and every further member is advisory. A consumer that knows nothing of CRUBAL reads the four and
  ignores the rest.
- **Page shapes** describe a whole page over one record. Their slots MAY hold other views, which then run with
  the page's record as their context (12.2, `of`).

## 12.2 Views

```crubal
view: dvds
  label: DVDs
  select:
    level: product
    wears: OpticalDisc
    when: format is DVD and count of unit::status over 0
  pin: P-4QX7, P-9KD2
  hide: P-1AAA
  order: releaseDate after, title
  page: 48
  shape: card
  filters: condition, genres, decade
  index: genres, decade
  show: public
  fresh: write
```

| Part | Holds | Default |
|---|---|---|
| `select` | which records: the classes they `wear` (all of them must be worn), a `level`, and a `when` condition (chapter 6.3); or `list: L-…`, a hand-made list. `level` is optional when `wears` is given: the view then selects wearers at every level, standing-alone ones included (chapter 1.7) | required |
| `partition` | what a caller must stand in to a record to be served its row: `administered`, `controlled`, `owned`, `relation <name>` (chapter 14.10), `linked <facet>` (the caller is whom the record's link facet names: a notice addressed to them, an invitation naming them), or `none` for every row | `controlled` above `member`; `none` otherwise |
| `of` | for a view inside a page: how the page's record narrows the selection, as a condition over `context` (`work is context.work and not id is context.id`) | none |
| `pin` · `hide` | curation: records shown first, in this order · records never shown | none |
| `order` | keys to sort by, in priority order; `after` means newest or largest first, `before` the reverse | ID An order key MAY be an address that reads through a link (revision 34, erratum: `order: pickUnit.filedSlot`); the first value it reads is the key, and a record it reads nothing for sorts as empty |
| `page` | records per page | 24 |
| `shape` | the shape every record takes; several for several outputs (`card, feed`) | required |
| `filters` | the filters shoppers can pick from (12.3) | none |
| `index` | the filters whose buckets get their own indexable pages (12.5) | none |
| `show` | the audience the view is for (12.4) | `public` |
| `fresh` | `write`, or a delay such as `5m` (12.6) | `write` |
| `terms` | how each audience may use what it's shown (12.5.1) | the package's `terms` |

A **catalog** (the media package's word for a view selected by worn classes) makes "which catalog is this
in" a global rule (chapter 6.6) the engine answers from the views' selections. **"Also on other formats"** is a view inside a
product page: `select: level: product`, `of: work is context.work and not id is context.id`. **Related-by-facet
carousels** are views selected by a shared facet value. **Hand-made lists** are records (an ordered set of
links with a name and an owner), and a view shows one with `select: list: L-…`.

**How a group is shown** (its products as separate pages, or as options on one page) is a page shape's choice:
a group page whose slots hold a view of its products, or product pages that each link their siblings.

## 12.3 Filters

A **filter** is a sub-index inside its view: for each **bucket**, the records of the view's selection that
fall into it.

```crubal
filter: condition
  facet: unit::condition
  buckets:
    "Like new": NM, VG
    Good: G
    Fair: F, P

filter: decade
  facet: releaseDate
  buckets:
    1980s: 1980..1989
    1990s: 1990..1999

filter: edition
  facet: edition
  dependent: label
```

- **Buckets are the map.** Each bucket is a name and the values (or a range, `a..b`) it holds. A filter with
  no `buckets` has one bucket per value of the facet, named by its label. A facet with no value list (a link
  into a vocabulary, a number, a text) buckets by the values the records carry, each its own bucket named by
  the value; nothing is known in advance, so an index counts the buckets a page asks for (12.6.1).
- **Buckets by period.** `buckets: by day`, `by week`, `by month`, `by quarter` or `by year` on a date or
  moment facet makes one bucket per period the records' values fall in, named by the period: `2026-10-21`,
  `2026-W43` (ISO weeks, Monday first), `2026-10`, `2026-Q4`, `2026`. Nothing is listed by hand; like a
  facet with no list, an index counts the periods a page asks for.
- **Sums.** `sum: amount, qty` names facets totalled per bucket beside the count: money by its amount, a
  quantity by its count, a number as it is; a value that is none of these adds nothing. A projection
  answers `sums[filter][bucket][facet]` beside `counts`.
- **Only real values are bucketed.** New and unknown values (chapter 9) never reach a bucket, and neither do
  held values.
- **A filter over a mark (revision 34).** `buckets: marked` makes exactly two buckets: `open`, the records of
  the view's selection with no real value for the facet, and `done`, those with one. It is the one place an
  empty value is bucketed; a held, new or unknown value counts as none. The facet is then a **mark**: what a
  step leaves on the record it worked (a date for when, a yes-no, or a link to what the record was put in),
  with who and when in the write's own source (chapter 8). A lane names it as its `step` (12.10).
- **A record is in a bucket** when any of its values for the facet is (for a level-prefixed facet, when any of
  its lower records' values is). The store decides this and puts it on the record's projection row (12.6).
- **Counts.** For each bucket, the count is the number of records in the view's selection, narrowed by every
  *other* filter the shopper has picked, that fall into the bucket. Picking two buckets of one filter means
  either. The index serving the view computes counts from the rows it holds (12.6.1).
- **Dependent facets.** `dependent:` names facets that follow the filter's facet (chapter 11.2 `follows`);
  their buckets are counted inside each of its buckets.

## 12.4 Audiences and roles

**Audiences** are few and fixed, so the number of stored variants stays small:

| Audience | Who |
|---|---|
| `public` | anyone, including crawlers |
| `member` | signed-in people |
| `staff` | the owner's people |
| `owner` | the owner itself |
| named parties | other owners, by domain (chapter 7.8) |

`show` rules (chapter 6, `then: key shown to member`) decide what each audience sees: per record, per facet,
per value. A show rule's `for` scopes it: a rule for a class, kind or level decides for the records it
covers, a class over a kind or level, and a rule for `everywhere` decides for the rest; so a package may
show a location's phone to the public while a person's stays staff's. A view's `show` says which audience
its stored projection is built for.

Which callers belong to an audience is decided by edges (chapter 14.4).

**Roles** are itemized permissions that sit on top of an audience as a filter. They never change projections,
caches or indexes. A role is a **preset** of the permission menu (chapter 14.6), which is where the full set
of verbs, scopes and narrowing is defined. The `role:` block below is the short form: it reads as one preset
of that name holding one menu item per verb line, and a package MAY write either; a reader treats them as
the same declaration.

```crubal
role: buyer
  audience: staff
  may:
    see: unit::cost, unit::location
    edit: condition, unit::price
    run: ebayListing, printLabel
    review: me:videoCodec
```

- The verbs are the menu's (chapter 14.6): `see` (a value is shown), `edit` (a form may write it), `run` (a
  contract may be started), `review` (queue items may be decided) and the rest. Targets are facets, classes,
  views, contracts and queues; `*` means all.
- **A role narrows its audience; it never exceeds it.** A grant naming anything its audience can't see MUST
  be refused at publish.
- A person MAY hold several roles; their grants add up, each capped by its own audience.
- **Default deny above `member`.** A person in the `staff` audience with no role sees and does only what
  `member` can.
- Contracts use the same grants: running one needs its `run` item (chapter 14.6). A form shows or locks each
  field by `see` and `edit`.
- Roles are definitions in a package, versioned like classes. Which person holds which role is data: an edge
  (chapter 14.3) whose `grants` name it, logged like any other write, so every grant has a history.

## 12.5 Pages, search engines and structured data

- **One view, one audience.** Every view is built for exactly one audience (its `show`), and its projection
  and index hold only what that audience sees. A page for another audience (a staff catalog, a member's
  shelf) is a view of its own with that `show`, with its own projection and index. The audiences are few
  (12.4), so the projections stay few.
- **The public projection is canonical.** It is the one cached, indexed and served to crawlers.
- **Indexable filters are declared.** Each bucket of a filter listed in `index` gets its own page with a
  canonical URL (`/dvds/comedy`, `/dvds/1980s`). Every other filter combination, and every page after the
  first, is served as not-to-be-indexed. Crawlers never enter the combinations.
- **Titles point to facets.** A page shape's title slot is an address, usually a derivation or rollup
  (`listingTitle -> title`); there are no hardwired title recipes.
- **Structured data** comes from the record's kind (its schema.org type per level, chapter 11.2) and each
  facet's `same-as`, emitted for the public audience only.
- New, unknown and held values never appear in a public projection.

### 12.5.1 AI is not an audience

An unauthenticated bot is `public`, whatever it says it is; an AI that signs in is a caller like any other,
with roles. So AI gets no audience of its own. What differs for AI is how the public projection may be
**used**, which a package or view declares as **terms** per audience:

```crubal
terms:
  public: search yes, answer yes, train no
```

| Use | Means |
|---|---|
| `search` | index the pages and link to them |
| `answer` | quote or summarise them in answers, with a link |
| `train` | use them to train models |

A package MAY name other uses. CRUBAL only states the terms; the host turns them into what crawlers and
agents read (robots rules for named bots, response headers, a machine-readable terms file), the same split as
authentication (chapter 7.6). Agents that shop or act for someone read a view's machine shape and act
through contracts as callers (chapter 7).

## 12.6 Projections

A view is **stored and indexed**, never derived on every read. The store computes it; an index serves it.

The store keeps the view's **projection**: one row per selected record, for the view's audience, holding the
shape's slots and, for each filter, the buckets the record falls into. Everything that needs the rules or an
audience decision happens here: selection, values read through from upper levels, from shared parts through
their links (`works[*].genres` in a slot, a filter or a condition, 1.10), from a compound's rows by child
(`ratings[*].value`, the wildcard of chapter 6 over the record's own rows) and rolled up from lower ones,
held, new and unknown values left out, and `show` rules applied. A `show` rule on the facet a link step
finally reads decides its visibility, wherever it is read from.

- **The read set.** Every view has the set of keys its `select`, `of`, `order`, slots, filters and `show`
  rules read, worked out at publish. Rules are pure and addresses explicit, so the set is exact.
- **Staleness.** A write to a key in a view's read set, on a record or on anything it reads through (upper
  levels, shared parts, rollups from lower levels), marks that record's projection stale. Only stale rows are
  rebuilt. **The envelope is in every read set:** a change of `status`, `wears`, `within` or `of` (chapter
  1.12) changes what a view holds, what a row reads through and what its ancestors are, so it marks the
  record's row stale like a key would. Erasure (chapter 8.5.2) is such a change: the row leaves the
  projection, and the stream (below) carries its removal to every index.
- **Partitions.** In a partitioned view (12.2), every projection row carries its record's ID and ancestors
  (chapter 14.2). The host hands the index the verified caller's live edges, and the index serves a row only
  when one of those edges stands in the partition's relation to the record or an ancestor: an edge on the
  owner's root matches every row, an edge on one league matches that league's rows. Views above `member`
  are partitioned by default, so a caller with `control` over one corner of the owner's data never sees the
  rest of a staff projection. The store decides the rows and their ancestors; the index only matches.
  In a `linked <facet>` partition the row carries instead whom the record's link facet names, and the index
  serves a caller only the rows that name them: a person's own notices out of a place's thousands, bounded
  by the link, never by the view; no edge per record is needed.
- **Role marks.** In a view above `member`, a slot whose value only some roles may `see` (12.4) carries the
  role it needs. The store decides the marks; the index only drops a marked slot for a caller without that
  role, using the roles of the verified caller the host hands it (chapter 7.6). Roles never add a slot a
  view doesn't hold.
- **The projection stream.** Every change to a projection is published, in order, as a projection entry
  (12.7): the view and its version, the audience, the record, and either its new row or `"removed": true`
  when the record leaves the selection or the audience. Entries are numbered per view and audience, so an
  index resumes where it stopped.
- **Freshness.** Projection rows are never rebuilt inside the write's transaction, so a write's cost doesn't
  grow with the number of views. **`fresh: write`** puts a write's effect on the stream as soon as the write
  commits, in log order. **`fresh: 5m`** lets rebuilds batch, and the stream is never further behind than
  that.
- A new version of a view, shape or filter rebuilds its projection in full, and its stream starts over.
- **Follow and adopt (revision 4).** A record MAY name another owner's public record by that record's
  platform-wide number in a facet the host recognises as a follow (`follows`), and carry no facts of its own.
  Its public projection is then the followed record's public values beneath whatever it produces: the host
  reads them through from the followed owner's store at serve, under that owner's `show` rules, and copies
  nothing into the follower's log; a fact the follower produces stands first and is never covered. Lifting
  the follow (clearing the facet) leaves the record with what it produced. A record MAY likewise name a fold
  by its number in a facet the host recognises as an adoption (`adopts`) and read the fold's merged reading
  beneath its own; what the fold merges is the maps' business, so a fold with no maps reads nothing through.
  Neither facet moves a fact between logs; both are reads the host performs.

### 12.6.1 Indexes

An **index** is a utility that serves a view: it reads the view's projection stream and answers from it,
with pages in the view's `order`, filter counts (12.3), search and caching. Which engine it uses is its own
choice.

- An index MUST read only the projection streams of the views it serves. It never reads records, the log or
  another view's rows, so it can't show anything a view leaves out.
- It MUST serve only the rows the caller's edges match in a partitioned view (the rows that name the caller
  in a `linked` partition), MUST drop role-marked slots for callers without the role, and decides nothing
  else about visibility.
- Its pages, counts and sums MUST follow 12.2 and 12.3, over the rows it holds. For a filter whose facet
  has no value list, or whose buckets are periods (12.3), it MAY count only the buckets the request names,
  since a vocabulary's tree has thousands and time has no end; it MUST pick on any of them. A sum is read
  from the slot of the view's first shape that carries the facet, so a summed facet is one the shape shows.
- An index MAY be behind the store, and MUST say which entry number it reflects.
### 12.6.2 Subscriptions

An index subscribes through a **send contract that carries projection streams** (chapter 7): sending data to
a system is a contract, an index is a system, and nothing new is needed.

```crubal
contract: searchIndex
  kind: send
  stream: dvds, allDiscs
  to: index.example
  credential: search-index
  when: entry
```

- `stream` names the views whose streams the contract carries, and takes the place of `writes` and `needs`:
  the payload is the entries (12.7), in `seq` order, batched; nothing is mapped, because the store already
  decided every row. `to` names the party that receives them.
- **Push and pull are one contract.** `when: entry` runs it whenever one of its views publishes entries;
  with `when: asked` the index runs it as a caller and names its own cursor, and gets the entries since.
- **The owner connects an index** by writing the contract into its package, as it connects any system. An
  index never subscribes itself; a platform's shared index is each owner's contract pointed at the same `to`.
- **A cursor per contract and view.** The index acknowledges the last `seq` it holds; the store keeps it as
  the run's state and resumes from the next one. Until an acknowledgment, entries are delivered again, so an
  index applies them idempotently by (view, audience, `seq`). Each batch is one run, its idempotency key the
  contract, the view, its version and the range of `seq` it carries (chapter 7.5).
- **A new version is a new stream.** Entries name the view with its version (`dvds /2026-11-01`); the first
  entry of a new version carries `reset: true`, and the index drops the old version's rows when it arrives.
  The cursor an index acknowledged for an older version doesn't apply to the new one.
- **Order within a stream, none across streams.** Two views' entries may interleave; one view's never
  reorder.
- **Lag is visible.** The index reports the `seq` it reflects (12.6.1), and the store exposes each contract's
  cursor, so an operator sees how far behind an index is.
- **A page at a time.** A caller asking (`when: asked`) MAY name a limit per view; the answer carries at most
  that many entries of each view and says `more` when a view had that many, and the caller acknowledges the
  page and asks again from its cursor. A push goes the same way: each page is its own run, acknowledged
  before the next is read, so a stream of any size is never one payload and a run cut short resumes from the
  last page acknowledged.
- **Trust by edge.** A stream carries every row of its audience's projection, ancestors included, because
  the index does the partition matching, so the index is trusted at the level of the views it carries. A
  view at `public` goes to any party the contract names. A view above `public` goes only to a party holding
  a live `control` edge that carries `run` for the contract (chapter 14.6), granted by the owner; without
  it the run stops at `permission`.

- **Actions check again.** Nothing that acts relies on an index. A contract checks its `needs` against the
  store when it runs (chapter 7.4), so a unit that sold a moment ago and still shows can't be bought twice.
- **A stream is compacted.** An entry a later entry for the same record supersedes MAY be dropped once the
  store's row carries the later one, or once a removal stands for the record. Each record's latest entry, a
  removal that stands and every `reset` marker remain, the head keeps its number, and no entry is ever
  renumbered, so an index resuming from any cursor lands the same rows as before the compaction. A stream
  is a change log, not a history: nothing may depend on an entry a later one superseded.
- An index can be dropped and rebuilt from the projection at any time. It is never the truth.

## 12.7 The JSON form

```json
{
  "view": "dvds",
  "select": { "level": "product", "wears": ["OpticalDisc"], "when": "format is DVD" },
  "pin": ["P-4QX7"],
  "order": [ { "key": "releaseDate", "dir": "after" }, { "key": "title", "dir": "before" } ],
  "page": "48",
  "shape": "card",
  "filters": ["condition", "genres", "decade"],
  "index": ["genres", "decade"],
  "show": "public",
  "fresh": "write"
}
```

Shapes use chapter 7.9's map objects for their slots; filters hold `facet`, `buckets` (`[{"name", "values"} or
{"name", "range"}]`) or `by` (a period) or `"marked": true` (revision 34), `sum` (the facets totalled per bucket) and `dependent`; roles hold
`audience` and `may` (verb → targets).

A projection entry, as the stream carries it:

```json
{
  "projection": "dvds /2026-10-13",
  "audience": "public",
  "seq": 1042,
  "record": "P-4QX7",
  "row": { "cover": { "$image": "https://…/front.jpg" }, "heading": "Christmas Vacation", "price": "4.99 USD" },
  "buckets": { "genres": ["Comedy", "Holiday"], "decade": ["1980s"], "condition": ["Like new"] }
}
```

A record leaving the view is `{"projection", "audience", "seq", "record", "removed": true}`. An entry with a
row MAY carry `sort`, the values of the view's `order` keys as text in order, and `pin`, the record's
position among the pinned, so an index orders rows without reading records. In a view above
`member`, `marks` maps a slot to the role it needs: `"marks": { "cost": "buyer" }`. `projection` names the
view with its version when it has one (`"dvds /2026-11-01"`), and the first entry of a new version carries
`"reset": true` (12.6.2).

A display has no JSON form since revision 66 (12.9): a bundle carries such a template as a block under its
reader's prefix (11.10).

A lane, a flow and a print have no JSON form since revision 67 (12.10 to 12.12): a bundle carries each as a
block under its reader's prefix (11.10).

## 12.8 Well-formed views

A package MUST be refused at publish when:

1. a view names a shape, filter, class or list that doesn't exist, or selects a level its classes' kinds
   don't have;
2. a slot, order key or filter facet names a facet the package doesn't define;
3. a filter's bucket values aren't real values of its facet, or two buckets of one filter overlap;
4. an `index` filter isn't among the view's `filters`;
5. a role grants anything its audience can't see, or names a target that doesn't exist;
6. a public view's slots or filters read a facet that `show` rules hide from `public`;
8. (withdrawn, revision 67: a lane is no member; 12.10.)
9. (withdrawn, revision 67: a flow is no member; 12.11.)
7. (withdrawn, revision 66: a display is no member; 12.9.)

## 12.9 Displays (withdrawn, revision 66)

A display was a template for a screen over a view: a layout family, slot lines and tokens, carried as a
member under `displays`. It held no value and the engine computed nothing from it, so it was a reader's word
and never the vocabulary's. Since revision 66 it is no member this specification names:

- A package that writes `display:` is refused, as any block the vocabulary does not name is.
- A reader that draws such templates writes them under its own prefix (11.9), `cfu:display: menu /2026-12-30`,
  and reads the lines the block carries. The lines a display took (`label:`, `describe:`, `layout:`,
  `slots:` of `shapeSlot -> displaySlot`, `tokens:` of `name: value`) are that reader's to keep or change.
- A bundle or a chain written before revision 66 that holds a display still reads: what it says of one is
  read by nothing, and retiring one needs no step (10.5).

## 12.10 Lanes (withdrawn, revision 67)

A lane was a row of the grid a package declares: what it lists (a view and its picks), whom it serves, its home
card and its object cards with the presses that act on them. It held no value, and the engine computed nothing
from it: it read the block, checked what it named and carried it. Since revision 67 it is no member this
specification names:

- A package that writes `lane:` is refused, as any block the vocabulary does not name is.
- A reader that draws rows writes them under its own prefix (11.9), `cfu:lane: ordersToPick /2026-11-05`, and
  reads the lines the block carries. The lines a lane took (`label:`, `describe:`, `about:`, `sort:`,
  `owner:`, `utility:`, `view:` or `serve:`, `pick:`, `done:`, `step:`, `until:`, `after:`, `group:`, `band:`,
  `house:`, `serves:`, `home:` and `card:`) and the checks it met (its view, the view's filters and slots, its
  utility's acts, an audience no wider than its view shows) are that reader's to keep or change. Nothing
  inside a carried block is judged at publish or at install.
- A bundle or a chain written before revision 67 that holds a lane still reads: what it says of one is read by
  nothing, and retiring one needs no step (10.5).

## 12.11 Flows (withdrawn, revision 67)

A flow was an objective's line of stops over a package's lanes and forms: its stops and their acts, the cases
and questions at a link, a closed set, what it holds through its run and when a record has left the line. Its
stamps and its joins were derived from its lanes, never declared. Like a lane it held no value. Since revision
67 it is no member this specification names, on the same three terms as a lane (12.10): `flow:` is refused, a
reader writes `cfu:flow: pullPackShip /2027-01-04` under its own prefix and reads, checks and derives from the
lines itself, and a bundle or a chain from before still reads with its flows read by nothing.

What stays the vocabulary's: an act (chapter 15) and what it writes when it lands; a filter over a mark (12.3),
which a reader's step lane may stand on; and `edit flows` as a menu item's target (14.6), a gate a reader's
designer may stand behind.

## 12.12 Prints (withdrawn, revision 67)

A print was a label design: what class or kind it prints, its stock in inches, its fields and its elements on
the art's normalized boxes. It held no value, and the engine drew nothing. Since revision 67 it is no member
this specification names, on the same three terms as a lane (12.10): `print:` is refused, a reader writes
`cfu:print: tag /2026-12-31` under its own prefix and reads and checks the lines itself, and a bundle or a
chain from before still reads with its prints read by nothing. A facet that named a print by a definition link
(`&def:print`) holds its name as text where its reader says so; the sort stays readable (4.2.2).
