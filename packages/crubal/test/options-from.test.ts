// Options from another key (5.3.1, revision 60): `unit::resaleMode from resaleModes`. The record above seeds
// the list, the lower record narrows: the form offers only what is held there, a run refuses any other
// answer, the record check cites the line, and a list that holds nothing leaves the line unasked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { readClassLine, readDefinitions } from "../src/defs.ts";
import { checkPackage, checkRecord } from "../src/dictionary.ts";
import { formOf } from "../src/forms.ts";
import { effective, emptyStore } from "../src/lifecycle.ts";
import type { Record } from "../src/model.ts";

const pkg = (line: string) => `package: modes /2026-11-20
  owner: lab.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item

title$
resaleModes{sell|rent|trade}*
resaleMode{sell|rent|trade}
color{red|blue}

class: Item
  label: Item
  for: item
  facets:
    title
    resaleModes
    ${line}
`;
const dict = readDefinitions(pkg("unit::resaleMode from resaleModes"));
const product = (modes?: string[]): Record => ({ id: "P-1", kind: "item", level: "product", owner: "t", wears: ["Item"], values: { title: "A", ...(modes ? { resaleModes: modes } : {}) } });
const unit = (values: Record["values"]): Record => ({ id: "U-1", kind: "item", level: "unit", of: "P-1", owner: "t", wears: ["Item"], values });
const stored = (p: Record, u: Record) => {
  const s = emptyStore();
  s.records.set("P-1", p);
  s.records.set("U-1", u);
  return s;
};

test("the narrowing is read and rides the bundle and back", () => {
  assert.equal(readClassLine("unit::resaleMode from resaleModes", 1).optionsFrom, "resaleModes");
  const b = bundleOf(parsePackage(pkg("unit::resaleMode from resaleModes")));
  assert.match(printBundle(b), /unit::resaleMode from resaleModes/);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
});

test("a publish refuses a source that is no choice, or that lacks a value of the line's", () => {
  assert.throws(() => checkPackage(readDefinitions(pkg("unit::resaleMode from title"))), /isn't a choice facet/);
  assert.throws(() => checkPackage(readDefinitions(pkg("unit::color from resaleModes"))), /has no red, blue/);
  checkPackage(dict);
});

test("the form offers only what the record above selected; nothing selected, and the line is unasked", () => {
  const contract = { name: "mode", needs: [readClassLine("resaleMode from resaleModes", 1)], parts: {}, origin: "declared" } as never;
  const fieldOf = (p: Record) => {
    const s = stored(p, unit({}));
    return (formOf(contract, s.records.get("U-1"), dict, { records: s.records }).sections as { fields: { values: { value: string }[]; asked?: boolean }[] }[])[0]?.fields[0];
  };
  assert.deepEqual(fieldOf(product(["sell", "trade"]))?.values.map((v) => v.value), ["sell", "trade"]);
  assert.equal(fieldOf(product())?.asked, false);
});

test("the record check cites the line for an answer outside the list, and leaves it when the list later drops it", () => {
  const s = stored(product(["sell", "trade"]), unit({ resaleMode: "rent" }));
  const u = s.records.get("U-1") as Record;
  const bad = checkRecord(u, dict, effective(s.records, u, dict)).outcomes.find((o) => o.address === "resaleMode");
  assert.deepEqual([bad?.outcome, bad?.cites], ["contradiction", { rule: "Item: unit::resaleMode from resaleModes" }]);
  const ok = stored(product(["sell", "rent"]), unit({ resaleMode: "rent" }));
  const u2 = ok.records.get("U-1") as Record;
  assert.equal(checkRecord(u2, dict, effective(ok.records, u2, dict)).outcomes.find((o) => o.address === "resaleMode")?.outcome, "absorbed");
  // The value is kept either way: the check reports, it never removes.
  assert.equal(u.values.resaleMode, "rent");
});
