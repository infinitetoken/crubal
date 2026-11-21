// A key held at both (1.7 and 5.3.3, revision 59): `unit::qty both`. The value above and the record's own are
// separate facts: a record at the level reads its own and nothing through, the value above is read at its
// level's address, on a record and on a part it mirrors, and a form carries the value above beside the answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { readClassLine, readDefinitions } from "../src/defs.ts";
import { formOf } from "../src/forms.ts";
import { detach, effective, effectiveParts, emptyStore } from "../src/lifecycle.ts";
import type { Record } from "../src/model.ts";
import { Engine, readRules } from "../src/rules.ts";

const text = `package: held /2026-11-20
  owner: lab.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item

title$
qty#
pieces#
short?

class: Piece
  facets:
    title
    pieces
    unit::pieces both

class: Item
  label: Item
  for: item
  facets:
    title
    qty
    unit::qty both
  parts:
    piece: Piece *
`;
const dict = readDefinitions(text);
const product: Record = {
  id: "P-1", kind: "item", level: "product", owner: "t", wears: ["Item"], values: { title: "A", qty: 2 },
  parts: [{ $row: "lid", wears: ["Piece"], values: { title: "Lid", pieces: 2 } }, { $row: "base", wears: ["Piece"], values: { title: "Base", pieces: 1 } }],
};
const unit = (values: Record["values"], parts?: Record["parts"]): Record => ({ id: "U-1", kind: "item", level: "unit", of: "P-1", owner: "t", values, ...(parts ? { parts } : {}) });
const stored = (u: Record) => {
  const store = emptyStore();
  store.records.set("P-1", product);
  store.records.set("U-1", u);
  return store;
};

test("the word is read, rides the bundle, and a line is never held two ways", () => {
  assert.equal(readClassLine("unit::qty both", 1).held, "both");
  assert.throws(() => readClassLine("unit::qty both over", 1), /never both/);
  const b = bundleOf(parsePackage(text));
  assert.match(printBundle(b), /unit::qty both/);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
});

test("a unit reads its own value and nothing through; the product's is untouched", () => {
  const none = stored(unit({}));
  const u = none.records.get("U-1") as Record;
  assert.equal(effective(none.records, u, dict).qty, undefined);
  assert.equal(effective(none.records, u, dict).title, "A");
  const own = stored(unit({ qty: 1 }));
  assert.equal(effective(own.records, own.records.get("U-1") as Record, dict).qty, 1);
  assert.equal(effective(own.records, product, dict).qty, 2);
});

test("a mirrored part reads its own value under a key held at both, and the rest through", () => {
  const s = stored(unit({}, [{ $row: "lid", values: { pieces: 1 } }]));
  const parts = effectiveParts(s.records, s.records.get("U-1") as Record, dict);
  assert.deepEqual(parts.map((p) => [p.$row, p.values]), [["lid", { title: "Lid", pieces: 1 }], ["base", { title: "Base" }]]);
});

test("a form carries the value above beside the answer, on the record and on each part row", () => {
  const contract = { name: "count", needs: [readClassLine("qty", 1)], parts: {}, origin: "declared" } as never;
  const s = stored(unit({}, [{ $row: "lid", values: { pieces: 1 } }]));
  const form = formOf(contract, s.records.get("U-1"), dict, { records: s.records }) as { sections: { fields: { [k: string]: unknown }[] }[]; parts: { rows: { row: string; fields: { [k: string]: unknown }[] }[] }[] };
  const qty = form.sections[0]?.fields[0];
  assert.deepEqual([qty?.current, qty?.above, qty?.editable], [undefined, 2, true]);
  const rows = Object.fromEntries((form.parts[0]?.rows ?? []).map((r) => [r.row, r.fields.find((f) => f.key === "pieces")]));
  assert.deepEqual([rows.lid?.current, rows.lid?.above, rows.lid?.editable], [1, 2, true]);
  assert.deepEqual([rows.base?.current, rows.base?.above, rows.base?.editable], [undefined, 1, true]);
});

test("a rule reads the value above at its level's address, beside the record's own", () => {
  const rules = new Engine(dict, readRules("rule: full\n  for: unit\n  when: product::qty has\n  then: qty same as product::qty\n  strength: must\n"));
  rules.put(product);
  assert.equal(rules.effective(unit({ qty: 1 }))["product::qty"], 2);
  assert.equal(rules.effective(unit({ qty: 1 })).qty, 1);
  assert.deepEqual(rules.write(unit({ qty: 1 })).map((r) => [r.result, r.address]), [["refused", "qty"]]);
  assert.deepEqual(rules.write(unit({ qty: 2 })).filter((r) => r.result === "refused"), []);
});

test("standing alone, a unit does not take the product's value as its own", () => {
  const s = stored(unit({}));
  detach(s, "U-1", dict);
  assert.deepEqual(s.records.get("U-1")?.values, { title: "A" });
});
