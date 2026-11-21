// A key held over (1.7 and 5.3.3, revision 59): `unit::weight over` on a class line. The value is stored
// above and read through; a record at that level may hold one of its own, which is read in its place, and
// removing it returns the key to the value above. The word rides the bundle and back, says nothing without a
// level, and a form gives the answer in force with the baseline it stands over.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { readClassLine, readDefinitions } from "../src/defs.ts";
import { formOf } from "../src/forms.ts";
import { detach, effective, emptyStore, heldOverKeys, ownedKeys } from "../src/lifecycle.ts";
import type { Record } from "../src/model.ts";

const pkg = (line: string) => `package: held /2026-11-20
  owner: lab.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item

title$
weight#g
grade{Mint|Good}

class: Item
  label: Item
  for: item
  facets:
    title
    ${line}
    unit::grade
`;
const dict = readDefinitions(pkg("unit::weight over"));
const product: Record = { id: "P-1", kind: "item", level: "product", owner: "t", wears: ["Item"], values: { title: "A", weight: "120 g" } };
const unit = (values: Record["values"]): Record => ({ id: "U-1", kind: "item", level: "unit", of: "P-1", owner: "t", values });
const stored = (u: Record) => {
  const store = emptyStore();
  store.records.set("P-1", product);
  store.records.set("U-1", u);
  return store;
};

test("the word is read on a level line, and is a plain setting's refusal without a level", () => {
  assert.equal(readClassLine("unit::weight over", 1).held, "over");
  assert.equal(readClassLine("unit::weight", 1).held, undefined);
  assert.throws(() => readClassLine("weight over", 1));
  const line = dict.classes.get("Item")?.lines.find((l) => l.facet === "weight");
  assert.deepEqual([line?.level, line?.held], ["unit", "over"]);
});

test("the word rides the bundle and back", () => {
  const b = bundleOf(parsePackage(pkg("unit::weight over")));
  assert.match(printBundle(b), /unit::weight over/);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
});

test("a unit reads the value above until it holds its own; removing its own returns it to the baseline", () => {
  const none = stored(unit({}));
  assert.equal(effective(none.records, none.records.get("U-1") as Record).weight, "120 g");
  const own = stored(unit({ weight: "95 g" }));
  assert.equal(effective(own.records, own.records.get("U-1") as Record).weight, "95 g");
  // The product's own value is untouched by the unit's.
  assert.equal(effective(own.records, product).weight, "120 g");
  assert.deepEqual([...heldOverKeys(dict, own.records, own.records.get("U-1") as Record)], ["weight"]);
  // It is a key the unit may hold, beside the ones that vary there.
  assert.deepEqual([...ownedKeys(dict, own.records, own.records.get("U-1") as Record)].sort(), ["grade", "weight"]);
});

test("a form gives the answer in force, the baseline it stands over, and whether the record holds its own", () => {
  const contract = { name: "unit", needs: [readClassLine("unit::weight", 1), readClassLine("unit::grade", 2)], parts: {}, origin: "declared" } as never;
  const fieldOf = (u: Record) => {
    const store = stored(u);
    const form = formOf(contract, store.records.get("U-1"), dict, { records: store.records });
    return (form.sections as { fields: { [k: string]: unknown }[] }[])[0]?.fields ?? [];
  };
  const [reading] = fieldOf(unit({}));
  assert.deepEqual([reading?.current, reading?.baseline, reading?.own, reading?.editable], ["120 g", "120 g", false, true]);
  const [answered, grade] = fieldOf(unit({ weight: "95 g" }));
  assert.deepEqual([answered?.current, answered?.baseline, answered?.own], ["95 g", "120 g", true]);
  // A key that simply varies at the level has no baseline.
  assert.equal(grade?.baseline, undefined);
  assert.equal(grade?.own, undefined);
});

test("standing alone, a unit keeps the value it was reading, and its own where it held one", () => {
  const reading = stored(unit({ grade: "Good" }));
  detach(reading, "U-1", dict);
  assert.deepEqual(reading.records.get("U-1")?.values, { grade: "Good", title: "A", weight: "120 g" });
  const answered = stored(unit({ weight: "95 g" }));
  detach(answered, "U-1", dict);
  assert.deepEqual(answered.records.get("U-1")?.values, { weight: "95 g", title: "A" });
});
