// Finished (1.6, revision 61): a many-valued key or a part slot is open until a person says it is all there.
// Adding or removing an item unsays it; changing an item's values does not; it rides the log and a rebuild;
// a rule reads it as a value state and a form carries it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readClassLine, readDefinitions } from "../src/defs.ts";
import { isFinished, sayFinished, unsayFinished } from "../src/finished.ts";
import { formOf } from "../src/forms.ts";
import { diffWrites, emptyState, applyEntry } from "../src/log.ts";
import type { Record } from "../src/model.ts";
import { MemoryRecords } from "../src/records.ts";
import { Engine, readRules } from "../src/rules.ts";

const dict = readDefinitions(`
kind: item
  levels: product, unit
  base: Item
title$
languages$*
checked?

class: Piece
  facets:
    title

class: Item
  for: item
  facets:
    title
    languages
  parts:
    piece: Piece *
`);
const product: Record = {
  id: "P-1", kind: "item", level: "product", owner: "t", wears: ["Item"], values: { title: "A", languages: ["en", "fr"] },
  parts: [{ $row: "lid", wears: ["Piece"], values: { title: "Lid" } }],
};
const who = { origin: "declared", via: "L-9" } as const;

test("a list is open until said finished, and only a list can be", () => {
  assert.equal(isFinished(product, "languages", dict), false);
  const said = sayFinished(product, "languages", dict, who);
  assert.equal(isFinished(said, "languages", dict), true);
  assert.deepEqual(said.finished?.languages?.source, who);
  assert.throws(() => sayFinished(product, "title", dict), /not a list/);
  assert.equal(isFinished(unsayFinished(said, "languages"), "languages", dict), false);
  assert.equal(unsayFinished(said, "languages").finished, undefined);
});

test("adding or removing an item unsays it; the same items in another order do not", () => {
  const said = sayFinished(product, "languages", dict);
  assert.equal(isFinished({ ...said, values: { ...said.values, languages: ["en", "fr", "de"] } }, "languages", dict), false);
  assert.equal(isFinished({ ...said, values: { ...said.values, languages: ["en"] } }, "languages", dict), false);
  assert.equal(isFinished({ ...said, values: { ...said.values, languages: ["fr", "en"] } }, "languages", dict), true);
});

test("a part slot is finished by its rows: a new row reopens it, a row's values changing does not", () => {
  const said = sayFinished(product, "parts.piece", dict);
  assert.equal(isFinished(said, "parts.piece", dict), true);
  assert.equal(isFinished({ ...said, parts: [{ $row: "lid", wears: ["Piece"], values: { title: "Top" } }] }, "parts.piece", dict), true);
  assert.equal(isFinished({ ...said, parts: [...(said.parts ?? []), { $row: "base", wears: ["Piece"], values: {} }] }, "parts.piece", dict), false);
});

test("it rides the log: a diff writes it, and applying the entry rebuilds it", () => {
  const said = sayFinished(product, "languages", dict, who);
  const before = emptyState();
  before.records.set("P-1", product);
  const after = emptyState();
  after.records.set("P-1", said);
  const writes = diffWrites(before, { ...after, review: [] } as never);
  assert.deepEqual(writes.map((w) => w.envelope), ["finished"]);
  const state = emptyState();
  state.records.set("P-1", { ...product }); // applying an entry writes the record in place
  applyEntry(state, { log: "L-9", at: "2026-11-20T00:00:00Z", owner: "t", source: who, writes } as never);
  assert.equal(isFinished(state.records.get("P-1") as Record, "languages", dict), true);
});

test("a rule reads it as a state, and a form carries it on a field and on a slot", () => {
  const rules = new Engine(dict, readRules("rule: allSaid\n  when: languages is finished\n  then: checked is yes\n  strength: suggest\n"));
  assert.ok(rules.write(sayFinished(product, "languages", dict)).some((r) => r.address === "checked"));
  assert.ok(!rules.write({ ...product, id: "P-2" }).some((r) => r.address === "checked"));
  const said = sayFinished(sayFinished(product, "languages", dict), "parts.piece", dict);
  const form = formOf({ name: "f", needs: [readClassLine("languages", 1)], parts: {}, origin: "declared" } as never, said, dict, { records: new MemoryRecords([["P-1", said]]) }) as { sections: { fields: { state?: string[] }[] }[]; parts: { finished?: boolean }[] };
  assert.deepEqual(form.sections[0]?.fields[0]?.state, ["finished"]);
  assert.equal(form.parts[0]?.finished, true);
});
