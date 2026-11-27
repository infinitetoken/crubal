// The rows verb (10.3, revision 63): each item of a many-valued facet becomes a row of a compound, the item
// under the child named and a word said on every row made. The facet's own value goes; rows already there
// stay; run again it makes nothing twice. And a recipe that only tidies words no definition lists rides a
// version where nothing broke.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { restamp } from "../src/migrate.ts";
import { publish } from "../src/publish.ts";

const head = `package: pics /2026-11-21
  owner: lab.example
  crubal: 2

kind: item
  levels: product
  base: Item

title$
images^*
kindWord$
facet: shots
  type: compound
  pick: any
  facets:
    shot^
    shows$80
facet: rows
  type: compound
  pick: any
  facets:
    kindWord

class: Item
  for: item
  facets:
    title
    images
    shots
    rows
`;
const recipe = `
migration: pics /2026-11-20 -> pics /2026-11-21
  facet: images
    rows: -> shots
      as: shot
      shows: cover
`;
const img = (u: string) => ({ $image: u });

test("each item becomes a row, after the rows held; the facet's value goes; again makes nothing twice", () => {
  const pack = readBundle(bundleOf(parsePackage(head + recipe)));
  assert.match(printBundle(bundleOf(parsePackage(head + recipe))), /rows: -> shots\n\s+as: shot\n\s+shows: cover/);
  const rec = { id: "P-1", kind: "item", level: "product", owner: "t", wears: ["Item"], values: { title: "A", images: [img("a.jpg"), img("b.jpg")], shots: [{ shot: img("z.jpg"), shows: "part:disc1" }] }, sources: { images: { origin: "declared", via: "L-1" } } };
  const once = restamp([rec as never], pack.recipes[0] as never, pack.dict).records[0] as typeof rec;
  assert.equal(once.values.images, undefined);
  assert.deepEqual(once.values.shots, [{ shot: img("z.jpg"), shows: "part:disc1" }, { shot: img("a.jpg"), shows: "cover" }, { shot: img("b.jpg"), shows: "cover" }]);
  const again = restamp([{ ...once, values: { ...once.values, images: [img("a.jpg")] } } as never], pack.recipes[0] as never, pack.dict).records[0] as typeof rec;
  assert.equal(serialize(again.values.shots as never), serialize(once.values.shots as never));
});

test("a rows step rides a version where nothing broke: the facet stays beside the compound its items move into", () => {
  // Revision 69. The version before holds the same definitions and no recipe; this one adds the move alone.
  const prev = { ...publish(head, { date: "2026-11-20" }).bundle, version: "2026-11-20" };
  const out = publish(head + recipe, { date: "2026-11-21", previous: prev });
  assert.equal(out.changes.some((c) => c.kind === "breaking"), false);
  assert.equal(readBundle(out.bundle).recipes.length, 1);
});

test("a step must name a compound and its children", () => {
  assert.throws(() => publish(head + recipe.replace("-> shots", "-> title"), { date: "2026-11-21" }), /title is not a compound/);
  assert.throws(() => publish(head + recipe.replace("shows: cover", "colour: red"), { date: "2026-11-21" }), /colour is not a child of shots/);
  // A compound of an extended package is not in this package's own definitions: left to the install.
  publish(head + recipe.replace("-> shots", "-> theirShots"), { date: "2026-11-21" });
});

test("a tidy-up of words no definition lists rides a version where nothing broke; of a choice's values it does not", () => {
  const prev = { ...publish(head, { date: "2026-11-20" }).bundle, version: "2026-11-20" };
  const tidy = `\nmigration: pics /2026-11-20 -> pics /2026-11-21\n  facet: rows[*].kindWord\n    merge: dvd, DVD -> disc\n`;
  publish(`${head}${tidy}`, { date: "2026-11-21", previous: prev });
  const fixed = head.replace("kindWord$", "kindWord{dvd|disc}");
  const prevFixed = { ...publish(fixed, { date: "2026-11-20" }).bundle, version: "2026-11-20" };
  assert.throws(() => publish(`${fixed}\nmigration: pics /2026-11-20 -> pics /2026-11-21\n  facet: rows[*].kindWord\n    merge: dvd -> disc\n`, { date: "2026-11-21", previous: prevFixed }), /nothing broke/);
});
