// Every record wears its kind's base class, whether or not `wears` lists it (5.5): the base class's `level::`
// lines say what a record at that level holds, and a rule's produced key is stored at a level a class places
// it at, as at one the kind's `vary` names (5.3.3). Before 0.4.4 only `wears` and the kind's own steps counted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { effective, emptyStore, heldOverKeys, ownedKeys } from "../src/lifecycle.ts";
import type { Record } from "../src/model.ts";
import { Engine, readRules } from "../src/rules.ts";

const dict = readDefinitions(`
kind: item
  levels: group, product, unit
  base: Item
title$
tags$*
word$
facet: names
  type: compound
  pick: any
  facets:
    word
count#

class: Item
  for: item
  facets:
    title
    tags
    product::tags over
    unit::tags over
    names
    unit::count both
class: Disc
  for: item
  facets:
    title
`);
const group: Record = { id: "G-1", kind: "item", level: "group", owner: "t", values: {} };
const product: Record = { id: "P-1", kind: "item", level: "product", of: "G-1", owner: "t", wears: ["Disc"], values: { names: [{ word: "a" }, { word: "b" }], count: 2 } };
const unit: Record = { id: "U-1", kind: "item", level: "unit", of: "P-1", owner: "t", values: { names: [{ word: "u" }] } };

test("the base class's lines place keys for a record that does not list it", () => {
  const s = emptyStore();
  for (const r of [group, product, unit]) s.records.set(r.id, r);
  assert.deepEqual([...ownedKeys(dict, s.records, unit)].sort(), ["count", "tags"]);
  assert.deepEqual([...heldOverKeys(dict, s.records, unit)], ["tags"]);
  // Held at both by the base class: the unit does not read its product's count.
  assert.equal(effective(s.records, unit, dict).count, undefined);
});

test("a produced key is stored at a level a class places it at: under a group, and on a unit", () => {
  const rules = new Engine(dict, readRules("rule: p\n  for: product\n  then: tags is join of names[*].word\n  strength: should\nrule: u\n  for: unit\n  then: tags is join of names[*].word\n  strength: should\n"));
  rules.put(group);
  const made = (r: Record) => rules.write(r).find((x) => x.address === "tags")?.value;
  assert.deepEqual(made(product), ["a", "b"]);
  assert.deepEqual(made(unit), ["u"]);
});
