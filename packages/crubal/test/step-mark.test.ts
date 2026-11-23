// Revision 34 (spec 12.3, 12.10, 12.11): a step's mark. A filter over a mark has two buckets, open (no real
// value) and done; a lane names its step in place of pick and done, and the marks that end the waiting
// (until); a flow's step stops stand in any order and chain with nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { readDefinitions } from "../src/defs.ts";
import { checkPackages, readPackages } from "../src/packages.ts";
import { CrubalError } from "../src/tree.ts";
import { checkViews, readViews, Views } from "../src/views.ts";
import { actWrites, markFacets } from "../src/acts.ts";

const lane = (name: string, step: string, until: string, act: string) => `cfu:lane: ${name} /2027-01-05
  label: ${name}
  utility: orders
  view: lines
  step: ${step}${until ? `\n  until: ${until}` : ""}
  band: daily
  serves: owner, fulfiller(pick)
  home:
    figure: count
    press: Go -> /orders
  card:
    name: title
    primary: Go -> ${act}
`;

const lanes = `${lane("linesToPull", "pulled", "shipped, cancelled", "pull")}
${lane("linesToPack", "packed", "shipped, cancelled", "pack")}
${lane("linesToShip", "shipped", "cancelled", "ship")}`;

const flow = (stops: string, done = "shipped") => `cfu:flow: pullPackShip /2027-01-05
  label: Pull, pack, ship
  utility: orders
  follow: queue
  serves: owner, fulfiller(pick)
  stops:
${stops.split(",").map((s) => `    ${s.trim()}`).join("\n")}
  done: ${done}`;

const shop = (tail: string) => `package: shop /2027-01-05
  owner: shop.example
  crubal: 2

kind: order
  levels: order, line
title$
orderState{paid|shipped}
pulled@
packed@
shipped@
cancelled@

shape: lineRow
  slots:
    title -> title

filter: pulled
  facet: pulled
  buckets: marked

filter: packed
  facet: packed
  buckets: marked

filter: shipped
  facet: shipped
  buckets: marked

filter: cancelled
  facet: cancelled
  buckets: marked

filter: orderState
  facet: orderState

view: lines
  label: Lines
  select:
    level: line
  shape: lineRow
  filters: pulled, packed, shipped, cancelled, orderState
  show: staff

permissions: shop
  menu:
    pick: run pick
  presets:
    fulfiller: pick    audience: staff
  relations: buyer, follower only

utility: orders /2027-01-05
  label: Orders
  serves: owner, fulfiller(pick)
  acts: pull, pack, ship
  mark: parcel amber

${tail}
`;

const refused = (tail: string, why: RegExp) => assert.throws(() => checkPackages(shop(tail)), (e: unknown) => e instanceof CrubalError && why.test(e.message));

test("a marked filter has two buckets: open holds the records with no value, done those with one", () => {
  const src = shop("");
  const dict = readDefinitions(src);
  const set = readViews(src);
  checkViews(set, dict);
  assert.equal(set.filters.get("pulled")?.marked, true);
  const v = new Views(dict, set);
  const rec = (id: string, values: Record<string, string>) => ({ id, kind: "order", level: "line", owner: "t", values });
  v.put(rec("A", { title: "a" }));
  v.put(rec("B", { title: "b", pulled: "2027-01-05T10:00:00Z" }));
  v.put(rec("C", { title: "c", pulled: "2027-01-05T10:00:00Z", shipped: "2027-01-06T10:00:00Z" }));
  const p = v.project("lines", { audience: "staff" });
  assert.deepEqual(p.counts.pulled, { open: 1, done: 2 });
  assert.deepEqual(p.counts.shipped, { open: 2, done: 1 });
  // A step lane's to-dos: open on its step, and open on each until.
  const ahead = v.project("lines", { audience: "staff", picks: { packed: ["open"], shipped: ["open"], cancelled: ["open"] } });
  assert.deepEqual([...ahead.records].sort(), ["A", "B"], "a line shipped without being packed waits to pack no longer");
  // Revision 38: an after is one pick more, the mark's done bucket: only a line already pulled waits to pack.
  const entered = v.project("lines", { audience: "staff", picks: { packed: ["open"], shipped: ["open"], cancelled: ["open"], pulled: ["done"] } });
  assert.deepEqual([...entered.records].sort(), ["B"], "a line not yet pulled does not wait to pack");
});

test("a mark is taken once: an act that sets a mark the record holds is stopped before any write; cleared, it may be taken again", () => {
  const src = shop(`act: pull /2027-01-05
  label: Pull
  utility: orders
  on: line
  set:
    pulled -> now

act: putBack /2027-01-05
  label: Put back
  utility: orders
  on: line
  set:
    pulled -> none`);
  const marks = markFacets(readViews(src).filters.values());
  assert.deepEqual(marks.sort(), ["cancelled", "packed", "pulled", "shipped"]);
  const acts = readPackages(src)[0]?.acts ?? [];
  const pull = acts.find((a) => a.name === "pull");
  const back = acts.find((a) => a.name === "putBack");
  assert.ok(pull && back);
  const open = { id: "L1", values: { title: "a" } };
  const taken = { id: "L1", values: { title: "a", pulled: "2027-01-05T10:00:00Z" } };
  const first = actWrites(pull, { record: open, context: {}, found: {}, now: "2027-01-05T10:00:00Z", marks });
  assert.deepEqual(first.ok && first.record, { pulled: "2027-01-05T10:00:00Z" });
  assert.deepEqual(actWrites(pull, { record: taken, context: {}, found: {}, now: "x", marks }), { ok: false, why: "pulled is taken: a mark is set once" });
  const cleared = actWrites(back, { record: taken, context: {}, found: {}, now: "x", marks });
  assert.deepEqual(cleared.ok && cleared.clear, ["pulled"]);
});

test("erratum: a link step reads through a link to a level of a kind, in a slot, a filter and the order", () => {
  const src = `
kind: item
  levels: product, unit
kind: order
  levels: order, pick
title$
slot$
pickUnit&unit
shape: row
  slots:
    pickUnit.title -> title
    pickUnit.slot -> slot
filter: slot
  facet: pickUnit.slot
view: walk
  select:
    level: pick
  order: pickUnit.slot
  shape: row
  filters: slot
`;
  const dict = readDefinitions(src);
  const set = readViews(src);
  checkViews(set, dict);
  const v = new Views(dict, set);
  v.put({ id: "P", kind: "item", level: "product", owner: "t", values: { title: "Jaws" } });
  v.put({ id: "U1", kind: "item", level: "unit", owner: "t", of: "P", values: { slot: "B-2" } } as never);
  v.put({ id: "U2", kind: "item", level: "unit", owner: "t", of: "P", values: { slot: "A-1" } } as never);
  v.put({ id: "K1", kind: "order", level: "pick", owner: "t", values: { pickUnit: { $link: "U1" } } });
  v.put({ id: "K2", kind: "order", level: "pick", owner: "t", values: { pickUnit: { $link: "U2" } } });
  const p = v.project("walk");
  assert.deepEqual(p.records, ["K2", "K1"], "sorted by the unit's slot");
  // A link step answers a list (a link may be many): one value each here.
  assert.deepEqual(p.rows.map((r) => [r.title, r.slot]), [[["Jaws"], ["A-1"]], [["Jaws"], ["B-2"]]]);
  assert.deepEqual(p.counts.slot, { "A-1": 1, "B-2": 1 });
});

