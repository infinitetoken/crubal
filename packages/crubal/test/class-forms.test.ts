// A class is its own keep form (7.7, revision 64): `class:<Class>` is read from the class for a record, its
// fields the class's own lines; a line placed at a level is answered at that level alone; a key the class
// does not ask is told as unknown and never lands; who may run it is who may keep the record through a
// written keep form of its own.
import assert from "node:assert/strict";
import test from "node:test";
import { classForm, classFormLines, classFormName, classOfForm } from "../src/class-forms.ts";
import { Access, readAccess } from "../src/access.ts";
import { readDefinitions } from "../src/defs.ts";
import { Exchange } from "../src/exchange.ts";
import type { Record } from "../src/model.ts";
import { readContracts } from "../src/store.ts";

const text = `kind: item
  levels: product, unit
  base: Item

facet: title
  type: text
facet: speed
  type: choice
  values: SP, LP
facet: shell
  type: text
facet: tracking
  type: text
facet: region
  type: text

class: Item
  for: item
  facets:
    !title

class: Tape
  for: item
  facets:
    section: Tape
    speed
    shell
    unit::tracking

class: VHS
  for: item
  uses: Tape
  facets:
    region

contract: product
  kind: form
  role: keep
  for: Item
  needs:
    !title
`;

const dict = readDefinitions(text);
const product: Record = { id: "P-1", owner: "t.test", kind: "item", level: "product", wears: ["VHS"], values: { title: "Heat" }, sources: { title: { origin: "declared", via: "L-0" } } };
const unit: Record = { id: "U-1", owner: "t.test", kind: "item", level: "unit", of: "P-1", values: {} };
const bare: Record = { id: "P-2", owner: "t.test", kind: "item", level: "product", values: { title: "Other" } };

const exchange = () => {
  const ex = new Exchange(dict, readContracts(text));
  for (const r of [product, unit, bare]) ex.records.set(r.id, r);
  return ex;
};

test("a class's own form is named for it and read from its own lines", () => {
  assert.equal(classFormName("Tape"), "class:Tape");
  assert.equal(classOfForm("class:Tape"), "Tape");
  assert.equal(classOfForm("product"), undefined);
  const f = classForm(dict, "class:Tape", product, ["Item", "VHS"]);
  assert.equal(f?.kind, "form");
  assert.equal(f?.role, "keep");
  assert.equal(f?.origin, "declared");
  assert.deepEqual(f?.needs.map((l) => [l.facet, l.section]), [["speed", "Tape"], ["shell", "Tape"]], "its own lines, in order, with their section; the unit's line left out");
  assert.deepEqual(classForm(dict, "class:VHS", product, ["Item", "VHS"])?.needs.map((l) => l.facet), ["region"], "what a class uses has a form of its own");
  assert.equal(classForm(dict, "class:Nothing", product, ["Item"]), undefined);
});

test("a line placed at a level is answered there alone, observed at the last level", () => {
  assert.deepEqual(classFormLines(dict, "Tape", "unit", ["Item"], ["Item", "VHS"]).map((l) => l.facet), ["tracking"]);
  const f = classForm(dict, "class:Tape", unit, ["Item"], ["Item", "VHS"]);
  assert.equal(f?.origin, "observed");
  assert.deepEqual(f?.needs.map((l) => [l.facet, l.level]), [["tracking", undefined]]);
  assert.deepEqual(classFormLines(dict, "Tape", "product", ["Item"]), [], "a record that reaches nothing of the class answers none of it");
});

test("a save through a class's own form lands what the class asks and tells what it does not", () => {
  const ex = exchange();
  const r = ex.receiveRun("class:Tape", "P-1", JSON.stringify({ speed: "SP", region: "1", tracking: "x" }));
  assert.equal(r.stopped, undefined, JSON.stringify(r));
  const outcomes = r.outcomes as { from: string; outcome: string }[];
  assert.deepEqual(outcomes.map((o) => [o.from, o.outcome]), [["speed", "absorbed"], ["region", "unknown"], ["tracking", "unknown"]]);
  assert.equal(ex.records.get("P-1")?.values.speed, "SP");
  assert.equal(ex.records.get("P-1")?.values.region, undefined);
  assert.equal(ex.records.get("P-1")?.sources?.speed?.origin, "declared");
  const u = ex.receiveRun("class:Tape", "U-1", JSON.stringify({ tracking: "steady" }));
  assert.equal(u.stopped, undefined, JSON.stringify(u));
  assert.equal(ex.records.get("U-1")?.values.tracking, "steady");
  assert.equal(ex.records.get("U-1")?.sources?.tracking?.origin, "observed");
});

test("a record that does not reach the class is refused; a written form is untouched", () => {
  const ex = exchange();
  const r = ex.receiveRun("class:Tape", "P-2", JSON.stringify({ speed: "SP" }));
  assert.equal(r.stopped, "class");
  assert.equal(ex.records.get("P-2")?.values.speed, undefined);
  assert.throws(() => ex.receiveRun("class:Nothing", "P-1", "{}"), /no contract class:Nothing/);
  assert.equal(ex.receiveRun("product", "P-1", JSON.stringify({ title: "Heat (1995)" })).stopped, undefined);
  assert.equal(ex.contractFor("product", "P-1")?.name, "product");
});

// Who may run it: whoever may keep the record through a written keep form of its own; no new menu item.
const STAFFED = text.replace("  for: Item\n  needs:", "  for: Item\n  audience: staff\n  needs:");
const PERMS = `permissions: p
  menu:
    catalog: run product
  presets:
    keeper: catalog   audience: staff
  relations: operator, staff, customer
`;
const guarded = (edges: { who: string; mode: string; grants?: string[] }[]) => {
  const ex = new Exchange(dict, readContracts(STAFFED));
  ex.put({ ...product, sources: { "*": { origin: "declared", via: "L-1" } } });
  ex.access = new Access(dict, readAccess(PERMS).perms, ex.records as never, edges.map((e, i) => ({ edge: `E-${i}`, relation: e.mode === "admin" ? "operator" : e.mode === "control" ? "staff" : "customer", on: "P-1", grants: e.grants ?? [], by: "owner", line: 0, ...e })) as never, "s");
  return ex;
};

test("who may keep the record through its written keep form may run its classes' own; nobody else", () => {
  const staff = guarded([{ who: "S", mode: "control", grants: ["keeper"] }]);
  assert.equal(staff.receiveRun("class:Tape", "P-1", JSON.stringify({ speed: "LP" }), "S").stopped, undefined);
  assert.equal(staff.get("P-1")?.values.speed, "LP");
  const bare = guarded([{ who: "B", mode: "control" }]);
  assert.equal(bare.receiveRun("class:Tape", "P-1", JSON.stringify({ speed: "LP" }), "B").stopped, "permission", "staff without the item");
  const member = guarded([{ who: "M", mode: "consume" }]);
  assert.equal(member.receiveRun("class:Tape", "P-1", JSON.stringify({ speed: "LP" }), "M").stopped, "permission", "a member under a staff form");
  assert.equal(member.get("P-1")?.values.speed, undefined);
});
