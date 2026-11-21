# Origins: both, over, options from above, finished (proposal, 2026-11-20)

**Status:** ruled 2026-11-20 (the six questions at the end, all as proposed; on `both`: "don't assume based on the parent template"). `over` and `both` are built on this branch as revision 59 (spec 1.7, 1.10, 5.3.3; tests `held-over`, `held-both`; corpus forms/006, forms/007, store/026). `from` is built as revision 60 (5.3.1; test `options-from`; corpus forms/008) and finished as revision 61 (1.6; test `finished`), held as a mark of what the list was, so no write is needed to reopen it. Not built: the refusal of an undeclared lower value (question 5); a text form for finished; a contract or form press that says it (the functions `sayFinished` and `unsayFinished` are there, nothing calls them yet); a corpus case for finished. Written for the operator to correct. The need comes from
CashierFu's brief 128 (`cashierfu/docs/cashierfu/128-engine-audit.md`): Media Encyclopedia 1.0's facet design
had four traits this language cannot say. Each is given here as what it means, the spec text it would
change, what the code does today, and the size of the change. The open questions are at the end.

## 0. What the code does today (read 2026-11-20, engine 0.4.1)

Where a value lives is decided in one place in the language (1.7: a key is **folded**, stored at the highest
level where it is true, or **owned**, varying at a lower level) and in several in the code:

- **Reading** is `effective()`: `{ ...effective(above), ...own values }`. It is written three times
  (`lifecycle.ts`, `exchange.ts`, `views.ts`) and does not look at which keys vary. So for every reader a
  lower record's own value stands over the one above, whatever the key.
- **Writing** (`store.ts` `land`) does not look at `of` or at `vary`. A value written to a unit under a
  folded key is stored on the unit.
- **Which keys a record owns** (`ownedKeys`, `ownedPartKeys` in `lifecycle.ts`) is read by attach, detach
  and the form of a mirrored part, and by a rule's `storesAt`.
- **Forms** (`forms.ts`) already give a lower record's parts as the convergence the spec describes (1.6):
  rows by slot, each field with its current value read through, `editable: false` where the level does not
  own it.

Two things follow that the spec does not say:

1. **An override already happens, unsaid.** 1.7 says a lower record "stores none" of the folded keys. Nothing
   refuses it, and when it happens the lower value is read in place of the one above. In CashierFu's copy of
   production, 20 units attached to a product store `title`, `brand` and `gtin` of their own.
2. **A key held at two levels already happens, unsaid.** Every product there holds `cashierfuId`, and the
   Item class places `unit::cashierfuId`. A unit with none of its own would read its product's.

So the two traits are not new behaviour to add so much as behaviour to **declare, name and bound**: today
the code does one thing for every key, and the language says it does another.

## 1. Over: a baseline above, a value below that stands in its place

**Means.** The record above publishes the value. A lower record reads it, and MAY hold one of its own, which
is read in its place. Media Encyclopedia's "unit override".

**Written.** A placement word after the level prefix on a class line (5.3.3):

```crubal
facets:
  weight
  unit::weight over        // the product's weight, unless this unit says otherwise
```

**Proposed text, 1.7, a third kind of key:**

> - **Keys held over.** A facet placed `over` at a level is stored above, as a folded key is, and a record at
>   that level MAY hold a value of its own. Read at that level and below, the key is the record's own value
>   when it holds one and the value above when it does not. Writing it at the lower level writes the lower
>   record and never the one above. Removing the lower value returns the key to the value above. The value
>   above is read from below at its level's address (`product::weight`, 1.10).

**Proposed answers.**

- *Clearing the lower value returns to the baseline.* Yes: absent below means read through.
- *A lower value equal to the baseline is kept.* It is an answer ("looked, the same"), and it stops
  following the baseline. Attaching (1.7's table) leaves an `over` key's lower value where it is.
- *A rule or rollup at the lower level reads the value in force* (the lower one when held).
- *The three empties.* `does not apply` below stands over a value above; `unknown` below does too. Only
  absence reads through.

**Size: small.** The read is what `effective()` already does. To change: the class line's parse and JSON
form (`defs.ts`, `bundle.ts`, 5.9), `ownedKeys` and attach and detach (`lifecycle.ts`), the form field
(editable, with the baseline beside the current value, `forms.ts`), `storesAt` (`rules.ts`), an
observation's `supports` (`exchange.ts`). And one refusal the spec implies and the code lacks: a lower
record holding a value under a key that is neither owned nor `over` (see question 5).

## 2. Both: a value above and a value below, neither standing in for the other

**Means.** The record above says what should be there; the lower record says what is. Two values under one
key. Media Encyclopedia's "both" (a manifest row's quantity: the release packs two, this unit has one).

**Written.**

```crubal
facets:
  qty
  unit::qty both           // the product's count, and this unit's own count beside it
```

**Proposed text, 1.7:**

> - **Keys held at both.** A facet placed `both` at a level is stored above and varies at that level. The two
>   values are separate facts. A record at that level reads its own value, and reads nothing through: with
>   none of its own the key is absent there. The value above is read at its level's address
>   (`product::qty`), and a rule MAY compare the two (`when: qty under product::qty`).

**Proposed answers.**

- *How a rule or view names each.* By the level address 1.10 already has: `qty` is the reading record's
  own; `product::qty` is the one above; from the product, `unit::qty` reaches down as it does today.
- *A form at the lower level* gives the field as editable with its own value, and carries the value above
  beside it (`above`), to show and never to post.
- *Attaching* leaves both values where they are: neither is a copy of the other.

**Size: medium.** This is the one that changes a read. All three `effective()` must leave a `both` key of
the record above out of what the lower record reads, so each needs the dictionary and the chain's worn
classes, which today they do not take. `crubal-postgres` and `crubal-host` were not read for this note;
any projection or index row there that reads through needs the same rule.

## 3. Options from above: the record above seeds, the lower record narrows

**Means.** A lower record's choice offers only what the record above selected. Media Encyclopedia's
`optionsFrom` (a unit's resale mode, from its product's resale modes). Enforced when the value is written,
not only where it is picked.

**Written.** A narrowing on the class line (5.3.1):

```crubal
facets:
  resaleModes{sell|rent|trade}*
  unit::resaleMode from resaleModes
```

**Proposed text, 5.3.1:**

> **From another key.** A choice line MAY end `from <key>`: the values a record may answer with are the
> values held under that key, read from the record as any key is (so a folded key is read from above). The
> named key MUST be a choice facet whose list contains the line's. A value outside it is a contradiction
> citing the line.

**Proposed answers.**

- *The source later drops a value a lower record answered with.* The lower value stays; it is a
  contradiction the next time the record is checked, and goes to review (9.5). Nothing is removed.
- *The source holds nothing.* The line is unasked (5.5), as a `when` that does not hold.

**Size: medium.** A new narrowing in `defs.ts` and the JSON form; the check where a value is judged against
its facet (4.9, `dictionary.ts`, `store.ts`), which today reads only the definition and here must read the
record; the form's `values`.

## 4. Finished: a list a person has said is all of it

**Means.** "Anything that could go on indefinitely needs a finish, and should be considered active unless
someone designates it complete." Having rows says the work started, never that it ended. Kept apart from
answered. Media Encyclopedia's closure.

**Written.** Not a value: a state a record holds about one of its lists, beside `alternatives` and
`suggestions` (3). In text form, a mark on the key's line:

```crubal
cast: (3 rows) finished
```

**Proposed text, 1.6:**

> **Finished.** A record MAY say a many-valued key, or a part slot, is **finished**: every item there is
> held. It is said by a person who may edit the record, with a source. Adding or removing an item under it
> unsays it, unless the same write says it again. A rule MAY read it as a value state (6.3.2:
> `when: cast finished`), and a form asks for it where a class line is placed `finish` (5.3.3).

**Proposed answers.**

- *Who.* Anyone who may edit the record at that address (14); an intake never says it.
- *Adding a row reopens it.* Yes.
- *Down the levels.* Finished follows its key: said where the key is stored. A product's parts finished
  says the packing list is all there; it says nothing of any unit's answers.

**Size: the largest.** A new member of a record: the JSON and text forms and their readers and printers,
the canonical form, the log, `land`, the value states of rules, the form. And the stores.

## 5. Questions for the operator

1. **The words.** `over` and `both`, written after the level prefix. They are the words used in the
   rulings; the operator has said the two are easy to confuse. An alternative pair: `or` (this, or the one
   above) and `and` (this, and the one above).
2. **Does `both` read nothing through, as written?** That is the ruling ("both doesn't look for the
   override"). It means a unit with no count of its own has no count, and a page shows the product's by
   reading `product::qty` on purpose.
3. **Is an equal lower value kept under `over`?** Proposed yes.
4. **Does a value that later falls outside `from` stay?** Proposed yes, as a contradiction for review.
5. **The unsaid overrides in real data.** Declaring `over` makes every other folded key held below a
   contradiction, which the code has never refused. CashierFu's copy has 20 such units. Either they are
   told at the border from now on and those 20 are cleaned by a recipe, or the refusal is left out and
   only declared keys are spoken of. Proposed: refuse at the border, with the 20 moved first.
6. **Order.** Proposed: `over`, then `both` (the same paragraph of 1.7, and `over` is nearly a matter of
   saying what the code does), then `from`, then finished, each its own revision with its corpus cases.
