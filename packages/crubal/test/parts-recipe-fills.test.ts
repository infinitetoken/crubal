// The parts verb (10.3) when a step gains a `child -> facet` line: a part an earlier, shorter step made of a
// row is that row's part, filled with what it lacks and never made again; a part the step made twice in an
// older run goes; a part a person made, or one that says something of its own, is left alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, readBundle } from "../src/bundle.ts";
import { restamp } from "../src/migrate.ts";

const text = (lines: string) => `facet: name
  type: text
kindOf$
manifestItem$
manifestItemType$
facet: manifest
  type: compound
  pick: any
  facets:
    manifestItem
    manifestItemType
class: Disc
  facets:
    name
    kindOf
class: Boxed
  for: item
  facets:
    title
    manifest
  parts:
    disc: Disc *
crubal: 2
package: test /2026-11-01
owner: test.example

migration: test /2026-10-14 -> test /2026-11-01
  facet: manifest
    parts: -> disc
      when: manifestItemType is disc
${lines}
`;
const run = (lines: string, parts: object[], manifest: object[]) => {
  const pack = readBundle(bundleOf(parsePackage(text(lines))));
  const rec = { id: "P-1", kind: "item", level: "product", owner: "test.example", wears: ["Boxed"], values: { title: "A", manifest }, parts };
  return (restamp([rec as never], pack.recipes[0] as never, pack.dict).records[0] as { parts?: { $row: string; values: object }[] }).parts?.map((p) => [p.$row, p.values]);
};
const longer = "      manifestItem -> name\n      manifestItemType -> kindOf";
const disc = { manifestItem: "DVD disc", manifestItemType: "disc" };

test("a part the shorter step made is filled, not made again", () => {
  assert.deepEqual(run(longer, [{ $row: "disc1", wears: ["Disc"], values: { name: "DVD disc" } }], [disc]), [["disc1", { name: "DVD disc", kindOf: "disc" }]]);
});

test("a part made twice by an older run goes, and the one kept is filled", () => {
  const twice = [{ $row: "disc1", wears: ["Disc"], values: { name: "DVD disc" } }, { $row: "disc2", wears: ["Disc"], values: { name: "DVD disc" } }];
  assert.deepEqual(run(longer, twice, [disc]), [["disc1", { name: "DVD disc", kindOf: "disc" }]]);
  // Two rows of the same name are two parts: each row takes one, nothing goes.
  assert.deepEqual(run(longer, twice, [disc, disc])?.map((p) => p[0]), ["disc1", "disc2"]);
});

test("a part under a person's own key, or one that says something the row does not, is left alone", () => {
  const own = [{ $row: "disc1", wears: ["Disc"], values: { name: "DVD disc" } }, { $row: "mine", wears: ["Disc"], values: { name: "DVD disc" } }, { $row: "disc3", wears: ["Disc"], values: { name: "Bonus" } }];
  assert.deepEqual(run(longer, own, [disc])?.map((p) => p[0]), ["disc1", "mine", "disc3"]);
});
