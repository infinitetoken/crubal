// The read API over the store (docs/design/read-api.md, 0.4.15): a selection of records by several values, by
// links, by ids, with a projection and keyset pages both ways; a count; the log and its head; runs and
// intakes. Skipped without CRUBAL_PG_URL.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { archive, publish, type Record, type Store } from "@crubal/engine";
import { connect, testSchema, type Pool } from "../src/db.ts";
import { PgStore } from "../src/store.ts";

const url = process.env.CRUBAL_PG_URL;
const owner = "reads.example";
const PKG = `package: reads /2026-11-24
  owner: ${owner}
  crubal: 2

kind: item
  levels: product, unit
  base: Item
kind: box
  levels: box
  base: Box
title$
format{DVD|Blu-ray|4K}
grade{mint|used}
filedIn&box
note$
label$
class: Item
  for: item
  facets:
    title
    format
    grade
    filedIn
    note
class: Box
  for: box
  facets:
    label
`;

let pool: Pool;
let drop: () => Promise<void>;
let store: PgStore;
const ids = (rs: Record[]) => rs.map((r) => r.id);

before(async () => {
  if (!url) return;
  pool = connect(url);
  drop = await testSchema(pool);
  store = new PgStore(pool, owner, { allowUnsigned: true, wholeState: "refuse" });
  await store.install(publish(PKG, { date: "2026-11-24" }).bundle, undefined, "2026-11-24T09:00:00Z");
  const src = { "*": { origin: "declared", via: "L-1" } };
  const put = (r: Record, at: string) => store.commit({ person: owner }, (d) => { d.records.set(r.id, { ...r, sources: src }); }, at);
  await put({ id: "B-1", kind: "box", level: "box", owner, values: { label: "One" } }, "2026-11-24T09:01:00Z");
  await put({ id: "B-2", kind: "box", level: "box", owner, values: { label: "Two" } }, "2026-11-24T09:01:10Z");
  await put({ id: "P-1", kind: "item", level: "product", owner, values: { title: "Alpha", format: "DVD" } }, "2026-11-24T09:02:00Z");
  await put({ id: "P-2", kind: "item", level: "product", owner, values: { title: "Beta", format: "4K" } }, "2026-11-24T09:02:10Z");
  const units: [string, string, string, string, string?][] = [
    ["U-1", "P-1", "mint", "B-1", "boxed"],
    ["U-2", "P-1", "used", "B-1"],
    ["U-3", "P-1", "mint", "B-2"],
    ["U-4", "P-2", "mint", "B-2", "scratched"],
    ["U-5", "P-2", "used", "B-2"],
  ];
  let t = 3;
  for (const [id, of, grade, box, note] of units)
    await put({ id, kind: "item", level: "unit", of, owner, values: { grade, filedIn: { $link: box }, ...(note ? { note } : {}) } }, `2026-11-24T09:0${t++}:00Z`);
  const dict = (await store.definitions()).dict;
  await store.commit({ person: owner }, (d) => { archive(d as unknown as Store, "U-5", "sold", dict); }, "2026-11-24T09:09:00Z");
});
after(async () => {
  if (!url) return;
  await drop();
  await pool.end();
});

test("records: the selection before the read API returns what it did", { skip: !url }, async () => {
  assert.deepEqual(ids(await store.records({ level: "unit" })), ["U-1", "U-2", "U-3", "U-4", "U-5"]);
  assert.deepEqual(ids(await store.records({ level: "unit" }, { archived: false })), ["U-1", "U-2", "U-3", "U-4"]);
  assert.deepEqual(ids(await store.records({ of: "P-1" })), ["U-1", "U-2", "U-3"]);
  assert.deepEqual(ids(await store.records({ key: ["grade", "mint"] })), ["U-1", "U-3", "U-4"]);
  assert.deepEqual(ids(await store.records({ level: "unit" }, { limit: 2, after: 0 })), ["U-1", "U-2"]);
});

test("records: several values at once, a key held, ids, parents in a list", { skip: !url }, async () => {
  assert.deepEqual(ids(await store.records({ level: "unit", keys: [["grade", "mint"], ["filedIn", { $link: "B-2" }]] })), ["U-3", "U-4"]);
  assert.deepEqual(ids(await store.records({ key: ["grade", "mint"], keys: [["filedIn", { $link: "B-1" }]] })), ["U-1"], "key and keys narrow together");
  assert.deepEqual(ids(await store.records({ level: "unit", has: ["note"] })), ["U-1", "U-4"]);
  assert.deepEqual(ids(await store.records({ ids: ["U-4", "P-1", "nope"] })), ["P-1", "U-4"], "in log order; an unknown id is left out");
  assert.deepEqual(ids(await store.records({ of: ["P-2", "P-1"] }, { archived: false })), ["U-1", "U-2", "U-3", "U-4"]);
});

test("records: the records that link to one, by the facets named", { skip: !url }, async () => {
  assert.deepEqual(ids(await store.records({ links: { to: "B-1", via: ["filedIn"] } })), ["U-1", "U-2"]);
  assert.deepEqual(ids(await store.records({ links: { to: ["B-1", "B-2"], via: ["filedIn"] }, keys: [["grade", "used"]] }, { archived: false })), ["U-2"]);
  assert.deepEqual(ids(await store.records({ links: { to: "B-1", via: ["note"] } })), [], "through a facet that is no link, nothing");
});

test("page: newest first and oldest first, a cursor each way, the last page says no next", { skip: !url }, async () => {
  const a = await store.page({ level: "unit" }, { newest: true, limit: 2 });
  assert.deepEqual(ids(a.records), ["U-5", "U-4"]);
  assert.ok(a.next !== undefined);
  const b = await store.page({ level: "unit" }, { newest: true, limit: 2, before: a.next });
  assert.deepEqual(ids(b.records), ["U-3", "U-2"]);
  const c = await store.page({ level: "unit" }, { newest: true, limit: 2, before: b.next });
  assert.deepEqual(ids(c.records), ["U-1"]);
  assert.equal(c.next, undefined, "a short page is the last");
  const up = await store.page({ level: "unit" }, { limit: 3 });
  assert.deepEqual(ids(up.records), ["U-1", "U-2", "U-3"]);
  assert.deepEqual(ids((await store.page({ level: "unit" }, { limit: 3, after: up.next })).records), ["U-4", "U-5"]);
});

test("records: only the facets asked come back, with their sources and the record's own", { skip: !url }, async () => {
  const [u] = await store.records({ ids: ["U-1"] }, { values: ["grade"] });
  assert.deepEqual(u?.values, { grade: "mint" });
  assert.equal(u?.of, "P-1", "the envelope is whole");
  const full = await store.get("U-1");
  assert.ok(full && Object.keys(full.values).length > 1);
  const srcKeys = Object.keys(u?.sources ?? {});
  assert.ok(srcKeys.every((k) => k === "grade" || k === "*"), `sources kept: ${srcKeys.join(", ")}`);
  const [none] = await store.records({ ids: ["U-2"] }, { values: ["note"] });
  assert.deepEqual(none?.values, {}, "a facet the record lacks comes back as nothing");
});

test("count: what records would return, with no limit", { skip: !url }, async () => {
  assert.equal(await store.count({ level: "unit" }), 5);
  assert.equal(await store.count({ level: "unit" }, { archived: false }), 4);
  assert.equal(await store.count({ links: { to: "B-2", via: ["filedIn"] } }, { archived: false }), 2);
  assert.equal(await store.count({ level: "nothing" }), 0);
});

test("the log: its head, a stretch after a number, newest first, and the drain's entries left out", { skip: !url }, async () => {
  const head = await store.head();
  const all = await store.entries();
  assert.equal(head.seq, all.length);
  assert.equal(typeof head.hash, "string");
  const tail = await store.log({ after: head.seq - 3 });
  assert.deepEqual(tail.map((e) => e.seq), [head.seq - 2, head.seq - 1, head.seq]);
  const [last] = await store.log({ newest: true, limit: 1 });
  assert.equal(last?.seq, head.seq);
  assert.deepEqual(last?.entry, all.at(-1));
  assert.deepEqual((await store.log({ before: 3 })).map((e) => e.seq), [1, 2]);
  // A drain's own entry is left out when asked; this store has none, so the count holds.
  assert.equal((await store.log({ drains: false })).length, all.length);
  const b1 = (await store.get("B-1")) as Record;
  await store.commit({ migration: "drain" }, (d) => { d.records.set("B-1", { ...b1, values: { ...b1.values, label: "One, drained" } }); }, "2026-11-24T09:10:00Z");
  assert.equal((await store.head()).seq, head.seq + 1);
  const [lastPerson] = await store.log({ newest: true, limit: 1, drains: false });
  assert.equal(lastPerson?.seq, head.seq, "the drain's entry is skipped");
  assert.equal(await store.lastSeq({ after: head.seq - 1, drains: false }), head.seq, "the last number a person wrote, and no entry read");
  assert.equal(await store.lastSeq({ after: head.seq, drains: false }), undefined, "none but the drain's since");
  assert.equal(await store.lastSeq({ after: head.seq }), head.seq + 1);
  const fresh = new PgStore(pool, "nobody.example", { allowUnsigned: true });
  assert.deepEqual(await fresh.head(), { seq: 0, hash: null }, "a chain with no entry");
});

test("runs and intakes: filtered, newest run first; an intake without its raw bytes", { skip: !url }, async () => {
  await pool.query("insert into runs (owner, run, json) values ($1, 'R-1', $2), ($1, 'R-2', $3), ($1, 'R-3', $4)", [
    owner,
    { contract: "label", record: "U-1", state: "failed" },
    { contract: "label", record: "U-1", state: "done" },
    { contract: "label", record: "U-1", state: "failed" },
  ]);
  const failed = await store.runs({ contract: "label", record: "U-1", state: "failed" }, { limit: 1 });
  assert.deepEqual(failed.map((r) => r.run), ["R-3"], "the last failed run");
  assert.equal((await store.runs({ record: "U-1" })).length, 3);
  await pool.query("insert into intake (owner, intake, contract, received, \"for\", raw, json) values ($1, 'I-2', 'feed', '2026-11-24T10:00:01Z', 'U-1', 'abc', '{\"outcomes\": []}'), ($1, 'I-1', 'feed', '2026-11-24T10:00:00Z', null, 'abc', '{}')", [owner]);
  const all = await store.intakes();
  assert.deepEqual(all.map((i) => i.intake), ["I-1", "I-2"], "in the order received");
  assert.equal("raw" in (all[0] as object), false);
  assert.deepEqual((await store.intakes({ for: "U-1" })).map((i) => i.intake), ["I-2"]);
});

test("the bundles in force: the package installed, with its signed bundle", { skip: !url }, async () => {
  const inForce = await store.bundlesInForce();
  assert.deepEqual(inForce.map((b) => `${b.package} /${b.version}`), ["reads.example/reads /2026-11-24"]);
  assert.equal(inForce[0]?.bundle.id, "reads.example/reads");
});
