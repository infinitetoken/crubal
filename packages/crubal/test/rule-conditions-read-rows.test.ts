// 0.4.6. A rule's condition reads an aggregate over the record's rows, its parts or the records below (6.3: a
// path is an address or an aggregate), with a row filter: `when: count of shots[*] where shows is cover is 0`;
// a filter of more than one test stands in parentheses, so the line's own `and` is not read into it.
// And a join over a many-valued key of the records below is one list, each value once. Together they let a
// package say a value in tiers: the approved pictures, else the ones from before, else a live unit's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCondition, reads } from "../src/conditions.ts";
import { readDefinitions } from "../src/defs.ts";
import type { Record } from "../src/model.ts";
import { checkRules, Engine, readRules } from "../src/rules.ts";

const dict = readDefinitions(`
kind: item
  levels: product, unit
  base: Item
title$80
images^*
facet: shots
  type: compound
  pick: any
  facets:
    !shot^
    shows$80
    origin{gathered}
class: Item
  for: item
  facets:
    title
    images
    unit::images both
    shots
    unit::shots both
`);
const rules = readRules(`rule: approved
  for: product::
  when: count of shots[*] where (shows is cover and not origin has) over 0
  then: images is join of shots[*].shot where shows is cover and not origin has
  strength: should
rule: before
  for: product::
  when: count of shots[*] where (shows is cover and not origin has) is 0 and count of shots[*] where shows is cover over 0
  then: images is join of shots[*].shot where shows is cover
  strength: should
rule: lent
  for: product::
  when: count of shots[*] where shows is cover is 0
  then: images is join of unit::images
  strength: should
`);
const img = (u: string) => ({ $image: u });
const unit = (id: string, pics: string[]): Record => ({ id, kind: "item", level: "unit", of: "P-1", owner: "t", values: pics.length ? { images: pics.map(img) } : {} });
const made = (shots: object[], units: Record[] = [unit("U-1", ["u1.jpg", "shared.jpg"]), unit("U-2", ["shared.jpg", "u2.jpg"]), unit("U-3", [])]) => {
  const e = new Engine(dict, rules);
  for (const u of units) e.put(u);
  const out = e.write({ id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "A", ...(shots.length ? { shots } : {}) } } as Record);
  const hit = out.find((r) => r.address === "images");
  return hit ? [hit.rule, ((hit.value as { $image: string }[]) ?? []).map((v) => v.$image)] : null;
};

test("a condition's aggregate with a row filter is one path; its verb is the last comparison", () => {
  assert.deepEqual(reads(parseCondition("count of shots[*] where (shows is cover and not origin has) over 0")), ["count of shots[*] where (shows is cover and not origin has)"]);
  assert.deepEqual(reads(parseCondition("count of shots[*] where shows is cover is not 0")), ["count of shots[*] where shows is cover"]);
});

test("a value in tiers: the approved, else the ones from before, else the units' own, one list with each once", () => {
  assert.deepEqual(made([]), ["lent", ["u1.jpg", "shared.jpg", "u2.jpg"]]);
  assert.deepEqual(made([{ shot: img("part.jpg"), shows: "part:x" }]), ["lent", ["u1.jpg", "shared.jpg", "u2.jpg"]]);
  assert.deepEqual(made([{ shot: img("g.jpg"), shows: "cover", origin: "gathered" }]), ["before", ["g.jpg"]]);
  assert.deepEqual(made([{ shot: img("g.jpg"), shows: "cover", origin: "gathered" }, { shot: img("a.jpg"), shows: "cover" }]), ["approved", ["a.jpg"]]);
  // No unit holds a picture and the product none: nothing is produced.
  assert.equal(made([], [unit("U-3", [])]), null);
});

test("0.4.7: a rule that reads below the key it produces above is no circle; two rules that feed each other still are", () => {
  assert.doesNotThrow(() => checkRules(rules, dict));
  const circle = readRules(`rule: a
  for: product::
  then: title is "{images}"
  strength: should
rule: b
  for: product::
  when: title has
  then: images is join of shots[*].shot
  strength: should
rule: c
  for: product::
  then: shots is join of unit::title
  strength: should
rule: d
  for: product::
  when: count of shots[*] where shows is cover over 0
  then: title is "x"
  strength: suggest
`);
  assert.throws(() => checkRules(circle, dict), /depend on each other/);
});
