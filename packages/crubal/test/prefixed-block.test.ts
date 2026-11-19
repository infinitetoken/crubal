// Revision 58 (spec 11.9, 13.5): a block under a prefix is carried, not understood. It is read by its first
// line alone, kept as written, carried into the bundle and back, versioned in `members`, and retired like any
// member that holds no value. A block with no prefix that the language does not name is still refused.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { checkPackages, readPackages } from "../src/packages.ts";
import { classify, publish } from "../src/publish.ts";
import { serialize } from "../src/canonical.ts";
import { CrubalError } from "../src/tree.ts";

const shop = (rest: string) => `package: shop /2026-11-19
  owner: shop.example
  crubal: 2
  prefixes:
    ui: screens.example/ui

kind: order
state{placed|shipped}
title$120

${rest}
`;

const row = `ui:row: ordersPlaced /2026-11-19
  label: Placed orders   // a comment goes
  shows: order
  card:
    name: title
    - state
  a line that is no pair`;

test("a prefixed block is read by its first line and its inside is kept as written", () => {
  const [info] = checkPackages(shop(row));
  assert.equal(info?.blocks.length, 1);
  const b = info?.blocks[0];
  assert.equal(b?.sort, "ui:row");
  assert.equal(b?.name, "ordersPlaced");
  assert.equal(b?.version, "2026-11-19");
  assert.deepEqual(b?.lines, ["label: Placed orders", "shows: order", "card:", "  name: title", "  - state", "a line that is no pair"]);
  // Nothing inside it became a facet, and the facets beside it stand.
  assert.deepEqual([...(info?.dict.facets.keys() ?? [])].filter((k) => !k.startsWith("crubal:")), ["state", "title"]);
});

test("a prefixed block round-trips through its bundle and is versioned in members", () => {
  const first = bundleOf(parsePackage(shop(row)));
  assert.deepEqual(first.blocks, [{ block: "ui:row/ordersPlaced", version: "2026-11-19", lines: ["label: Placed orders", "shows: order", "card:", "  name: title", "  - state", "a line that is no pair"] }]);
  assert.match(printBundle(first), /^ui:row: ordersPlaced \/2026-11-19\n {2}label: Placed orders$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  const { bundle } = publish(shop(row), { date: "2026-11-20" });
  const members = (b: typeof bundle) => b.members as { [k: string]: string };
  assert.equal(members(bundle)["block:ui:row/ordersPlaced"], "2026-11-20");
  const again = publish(shop(row), { date: "2026-11-21", previous: bundle });
  assert.equal(members(again.bundle)["block:ui:row/ordersPlaced"], "2026-11-20", "an unchanged block keeps its version");
  const changed = publish(shop(row.replace("shows: order", "shows: order, line")), { date: "2026-11-22", previous: bundle });
  assert.equal(members(changed.bundle)["block:ui:row/ordersPlaced"], "2026-11-22", "a changed block takes the date");
  assert.equal(changed.changes.find((c) => c.member === "block:ui:row/ordersPlaced")?.kind, "safe");
});

test("a prefixed block retires with no recipe: it holds no value", () => {
  const { bundle } = publish(shop(row), { date: "2026-11-20" });
  const gone = bundleOf(parsePackage(shop("")));
  assert.deepEqual(classify(bundle, gone).find((c) => c.member === "block:ui:row/ordersPlaced"), { member: "block:ui:row/ordersPlaced", kind: "safe", why: ["removed"] });
  publish(shop(""), { date: "2026-11-21", previous: bundle });
});

test("two sorts under one prefix, and one name under two sorts, stand side by side; the same block twice is refused", () => {
  const two = `ui:row: orders /1\n  shows: order\nui:page: orders /1\n  shows: order`;
  assert.deepEqual(readPackages(shop(two))[0]?.blocks.map((b) => `${b.sort}/${b.name}`), ["ui:row/orders", "ui:page/orders"]);
  assert.throws(() => readPackages(shop(`${two}\nui:row: orders /2`)), (e: unknown) => e instanceof CrubalError && /the ui:row orders twice in one package/.test(e.message));
});

test("what is not a prefixed block is still refused", () => {
  // No prefix: a word the language does not name is no block.
  assert.throws(() => checkPackages(shop("row: orders /1\n  shows: order")), CrubalError);
  // The core's prefix names no such block.
  assert.throws(() => checkPackages(shop("crubal:row: orders /1\n  shows: order")), CrubalError);
  // A prefixed block names itself in one word.
  assert.throws(() => checkPackages(shop("ui:row: two words /1")), (e: unknown) => e instanceof CrubalError && /the name one word/.test(e.message));
});
