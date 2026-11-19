# CRUBAL 2

**Status:** adopted by the operator, 2026-10-13. Draft 0.1 of the language, as built in `lib/crubal/`.
**Handbook (with cheat sheet and playground):** https://claude.ai/artifact/4pwv4RzqgvvHV5h8eSTp8x
**Blueprint (the whole system as settled in review, with the decision log):** https://claude.ai/artifact/KxmXeg77KrNVvqkvK5q4K9 (source: `blueprint.html` in this folder).
It supersedes this README where they differ: notably marks (`...`, `12.50USD`, `unit::`, `->`), classes compose
with `uses:` (no `extends`), the `compound` type, and sources being mandatory (origin, via, owner).
**Builds on:** `docs/v2-model.md` (facets as the transport language, N maps not N²), CRUBAL (2026: key/value
pairs, Facet · Module · housing, the ref/url/query triad, provenance, the empty-key floor), schema.org,
Wikidata, and the Universal Commerce Protocol (UCP, Shopify + Google, 2026-01-11, https://ucp.dev).

## Rulings (2026-10-13)

1. The name is **CRUBAL** (CRUBAL 2).
2. The syntax below is **adopted**: three levels, one meaning per mark.
3. **Storage stays JSON.** The language is read, written, shown and sent; `lib/crubal/dictionary.ts` bridges
   it to `facet_curation.definition` both ways.
4. **UCP's rules are adopted** (reverse-domain prefixes, dated versions, `extends`, negotiation). Publishing
   our catalog as a UCP catalog plus a facets extension comes once contracts exist.
5. **Combine rules are adopted**: join, sum, best, narrow, worst, deduct, replace, keep. Default join for
   many-valued facets, replace for single ones. Only `replace` depends on order.
6. Recommendations followed: our variant group = UCP product and our product = UCP variant; Wikidata items
   (`&wd:Q…`) are the first shared values; a source on a value (`[source: …]`) is optional; stored values are
   not stamped with a version (breaking changes migrate them); rules are enforced in both the database and
   the app, generated from one definition.
7. Facet rules from the design discussion: choice lists draw as bubbles only with a "pick N" indicator; date
   precision per facet (Release date any, Theatrical release date day, Launch date month); the product image
   facet stays separate from the unit photo slot for now; scored choice lists draw as bubbles with a small
   grade under each pick.

This supersedes D108-A ("no custom string grammar") for authoring and transport only: the stored arrangement
is still JSON, and CRUBAL is a text form over it.

## The one rule

Everything is a key and a value. A product's data is pairs; a facet's definition is pairs about a key; a
contract is pairs about a system. The shorthand is only a shorter way to write the same pairs.

## Level 1: data (everyone)

1. `key: value`, one per line.
2. Indent two spaces to put things inside the line above.
3. `- ` starts another item in a list; a short list can go on one line with commas.
4. `//` starts a comment (only at the start of a line or after a space, so URLs survive).

Values say what they are:

| Write | Means |
|---|---|
| `1989` · `1989-11` · `1989-12-01` | a year · a month · a day |
| `97min` · `2.4lb` · `$12.50` · `12.50eur` | a number with its unit or currency |
| `yes` · `no` | yes / no (or the facet's own words) |
| `_` | applies, not known yet |
| `-` | does not apply (only where the facet allows it) |
| `&P-4QX7` · `&wd:Q311319` · `&https://…` | a link: ours, a Wikidata item, a web page |
| `"text, with commas"` | text; quotes only when needed |
| `[region: US, source: import]` | detail about one value |

A value's shape suggests its type; the facet decides (`1989` is a year under a date, a number under a number).

## Level 2: a facet definition

```
facet: videoCodec
  label: Video codec
  ask: How is the picture encoded on the disc?
  type: choice
  values: MPEG-2, H.264, VC-1 ~vc1, HEVC, AV1
  pick: 1
  aliases: codec, "Video Format"
  same-as: schema:encodingFormat
  extends: OpticalDisc
  version: 2026-10-13
```

| Key | Holds |
|---|---|
| `type` | text, number, date, yes-no, choice, link, image, module |
| `label` · `ask` · `describe` | the name people see · the short question beside the control · what it means |
| `values` | choice: the list; `~` joins other spellings |
| `add` | choice: a last "+ Other…" bubble lets a new value join |
| `ordered` | choice or link: the order of the values means something |
| `scored` | choice: each pick also takes a 0–10 grade |
| `words` | yes-no: two words when they aren't Yes and No (`Sealed, Opened`) |
| `pick` | `1`, a number for "up to", or `any` |
| `precision` | date: year, month, day or any |
| `unit` · `range` · `places` | number: its unit; `0..10 step 0.5`; decimal places |
| `length` | text: the most characters |
| `to` | link: what it points at |
| `facets` | module: the facets inside (blocks or shorthand lines) |
| `on` | product (default), unit, or both |
| `required` · `na` · `unique` | needed to be complete · `-` allowed · one per item |
| `combine` | join, sum, best, narrow, worst, deduct, replace, keep |
| `when` | a condition: is, in, has, not, and, or |
| `aliases` · `same-as` · `extends` · `version` | other names · the same property elsewhere · the class it came from · `YYYY-MM-DD` |

Machinery slots on a stored definition (`yields`, `authority`, `identity`, `mapper`, `sum`, `scanRank`,
`closed`, `optionsFrom`) drive services, not the facet's meaning; the bridge carries them untouched.

## Level 3: shorthand (optional)

```
!title$200 ~name =schema:name
videoCodec{MPEG-2|H.264|VC-1|HEVC|AV1} ~codec =schema:encodingFormat <OpticalDisc /2026-10-13
productionFormat{Full Length Movie|Shorts|+}
releaseDate@any
unit.condition{NM|VG|G|F|P} +worst
cast(person&Person character$)* +join
```

Left to right: `!` required, `unit.` on the unit, the key, a type mark (`$` / `$80` text, `#min` number,
`@y` `@ym` `@ymd` `@any` date, `?` yes-no, `{a|b}` choice with `~` spellings and a last `+` for additions,
`&Thing` link, `^` image, `( … )` module), how many (nothing = one, `*3` up to three, `*` any), then tails:
`~` alias, `=` same as, `<` extends, `+` combine, `/` version. Settings with no mark (label, ask, describe,
ordered, scored, words, na, unique, when, range, places, on both) need the long form; the printer refuses to
squeeze them into a line rather than drop them.

## Contracts (transport)

Every system declares what it `needs`, what it `gives`, how its fields map (`reads`, `writes`, `stores`),
`when` it may run and `who` may run it. Systems map only to facets, never to each other. Inside a contract,
`>` maps our value to theirs: `Format: format {DVD>"DVD" | 4K>"4K UHD Blu-ray"}`. Not built yet.

## The code

- `lib/crubal/model.ts`: the facet shape, the eight types, combine rules.
- `lib/crubal/pairs.ts`: level 1 reader and printer.
- `lib/crubal/definition.ts`: level 2 reader and printer (strict, plain errors with line numbers).
- `lib/crubal/shorthand.ts`: level 3 reader and printer.
- `lib/crubal/check.ts`: does a value fit its facet.
- `lib/crubal/dictionary.ts`: the bridge to `facet_curation.definition`, and placement type claims.
- `scripts/crubal-dictionary.ts`: reads the live dictionary (read-only) and writes the Phase 0 report.

## Files in this folder

- `spec/`: moved to https://github.com/nes4less/crubal (the spec, the corpus and the reference implementation).
- `gap-analysis-token-universe.md`: the earlier CRUBAL (Token Universe: kit, shell, crubal.com, @cruba/*) mapped against the 13 chapters, with the rebuild-or-evolve recommendation.
- `blueprint.html`: the whole system as settled in review (seven pieces, three relationships, provenance and
  sharing, intake, evidence, migrations, marks), the CRUBAL-vs-ME gap split, and the decision log.
- `handbook.html`: the full handbook (cheat sheet, playground) as published; open it in a browser.
- `pages-and-forms.md`: the next direction, pages, cards and forms written in CRUBAL (approved to develop).
- `phase-0-2026-10-13.md`: the first run of `scripts/crubal-dictionary.ts` over prod: 34 rows need a ruling.
- `facet-design-discussion.html`, `facets-v2-brief.html`, `language-draft-ucp-math.html`: the design pages
  that led here (facet rules, IDs and versions, schema.org/Wikidata/UCP and the combine math).

## Where we stopped (2026-10-13)

- The review settled the whole system (`blueprint.html`, decision log), and the JSON form (section 15, 2026-10-14). The written spec is drafted in https://github.com/nes4less/crubal (all 13 chapters, with a corpus for every level, 2026-10-14).
  Views were designed the same day (chapter 12, blueprint section 13); every chapter is now a draft. The language work does
  not wait on the Phase 0 rulings, which are ME data.
- Waiting on the operator: the 34 Phase 0 rulings (5 type disagreements: videoCodec, discFormat, hdrFormats,
  aspectRatio, included; 4 choice lists with no values: digitalPlatform, gradingProfile, label, subgenre;
  25 untyped facets, grouped in the report). Recommendation given: the 5 become choice lists, 2 test leftovers
  are deleted, 8 ID keys become unique text, 3 image keys become images.
- Then: prod changes prepared for the operator to run, facet IDs and dated versions, and the pages work.

## Open gaps

Computed values beyond `"{title} [{format}]"` templates; a units file (UN/CEFACT codes) for conversions;
addressing inside repeated modules (`cast[2].character`); labels in other languages (`label.es`);
`unit-override` and `boolMode: existence` have no word yet; contracts, versions and IDs are not built.
