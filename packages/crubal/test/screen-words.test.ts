// The screen words that left the vocabulary at 0.4.13 (revision 67): a lane, a flow, a group and a print (a
// display left at 0.4.12). Each is a reader's own word now: written bare it is refused as any block the vocabulary
// does not name, written under a prefix it is carried as written (11.9), and a bundle or a chain from before
// still reads, with what it says of them read by nothing. What stays the engine's is tested here too: a
// utility's mark, group word and owner, a kind's faces, the `edit flows` target, a when's `is`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPermissions, readAccess } from "../src/access.ts";
import { bundleOf, emptyParsed, parsePackage, printBundle, readBundle, readBundleOnto } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { emptyDictionary } from "../src/defs.ts";
import { checkPackages, readPackages } from "../src/packages.ts";
import { classify, publish } from "../src/publish.ts";
import { CrubalError } from "../src/tree.ts";

const shop = (tail: string) => `package: shop /2026-11-05
  owner: shop.example
  crubal: 2

kind: order
  levels: order, line
orderState{paid|picking|packed|shipped}
placedAt@
total#
buyer$

shape: deskRow
  slots:
    !orderState -> state
    placedAt -> placed
    total -> total
    buyer -> buyer

filter: orderState
  facet: orderState

view: desk
  label: Desk
  select:
    level: order
  order: placedAt after
  page: 48
  shape: deskRow
  filters: orderState
  show: staff

permissions: shop
  menu:
    pick: run pick
  presets:
    fulfiller: pick    audience: staff
  relations: buyer, follower only

utility: orders /2026-11-05
  label: Orders
  serves: owner, fulfiller(pick)
  acts: pick, pack, confirmAddress
  mark: parcel amber

${tail}
`;


const LANE = `ordersToPick /2026-11-05
  label: Orders to pick
  utility: orders
  view: desk
  pick: orderState = paid
  done: orderState = picking
  serves: owner, fulfiller(pick)
  card:
    name: id, buyer
    primary: Pick -> pick`;
const FLOW = `pickPack /2026-11-05
  label: Pick and pack
  utility: orders
  stops:
    ordersToPick -> pick`;
const GROUP = `Org /2026-11-05
  label: Your place
  order: 3`;
const PRINT = `tag /2026-11-05
  for: order
  inches: 2 1
  fields:
    id -> id
  elements:
    barcode 0 0 1 1 id`;

test("a lane, a flow, a group and a print are no words of the vocabulary: each is refused bare", () => {
  for (const [word, body] of [["lane", LANE], ["flow", FLOW], ["group", GROUP], ["print", PRINT]] as const) {
    assert.throws(() => checkPackages(shop(`${word}: ${body}`)), (e: unknown) => e instanceof CrubalError, word);
    assert.throws(() => parsePackage(shop(`${word}: ${body}`)), (e: unknown) => e instanceof CrubalError, word);
  }
});

test("under a prefix each is carried as written: through the bundle and back, a member with its version", () => {
  const src = shop([`cfu:lane: ${LANE}`, `cfu:flow: ${FLOW}`, `cfu:group: ${GROUP}`, `cfu:print: ${PRINT}`].join("\n\n"));
  const [info] = checkPackages(src);
  assert.deepEqual(info?.blocks.map((b) => `${b.sort}/${b.name}`), ["cfu:lane/ordersToPick", "cfu:flow/pickPack", "cfu:group/Org", "cfu:print/tag"]);
  assert.deepEqual(info?.blocks[0]?.lines.slice(0, 3), ["label: Orders to pick", "utility: orders", "view: desk"]);
  const first = bundleOf(parsePackage(src));
  for (const gone of ["lanes", "flows", "groups", "prints"]) assert.equal(first[gone], undefined, gone);
  const members = first.members as { [k: string]: string };
  assert.equal(members["block:cfu:lane/ordersToPick"], "2026-11-05");
  assert.ok(!Object.keys(members).some((k) => /^(lane|flow|print):/.test(k)));
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  // Nothing inside a carried block is judged: a lane that names a view nobody declares is the reader's to refuse.
  checkPackages(src.replace("view: desk\n  pick", "view: nowhere\n  pick"));
});

test("a bundle published before the words left still reads: what it says of them is read by nothing", () => {
  const now = bundleOf(parsePackage(shop("")));
  const older = {
    ...now,
    members: { ...(now.members as object), "lane:ordersToPick": "2026-11-05", "flow:pickPack": "2026-11-05" },
    groups: [{ group: "Org", label: "Your place", order: "3" }],
    lanes: [{ lane: "ordersToPick", version: "2026-11-05", label: "Orders to pick", utility: "orders", view: "desk", pick: { filter: "orderState", value: "paid" }, band: "daily", house: 7, serves: [{ as: "owner" }], home: {} }],
    flows: [{ flow: "pickPack", version: "2026-11-05", label: "Pick and pack", utility: "orders", follow: "queue", stops: [{ name: "ordersToPick", act: "pick" }] }],
    prints: [{ print: "tag", for: "order", inches: { w: 2, h: 1 }, fields: [{ slot: "id", from: "id" }], elements: [{ type: "barcode", box: { x: 0, y: 0, w: 1, h: 1 }, field: "id" }] }],
  };
  const text = printBundle(older);
  assert.doesNotMatch(text, /^(lane|flow|group|print): /m);
  const onto = readBundleOnto(older, emptyParsed());
  assert.ok(onto.dict.kinds.has("order"));
  assert.deepEqual(onto.info.utilities.map((u) => u.name), ["orders"]);
  for (const gone of ["lanes", "flows", "groups"]) assert.ok(!(gone in onto.info), gone);
  assert.ok(!("prints" in onto.views));
  // The next version, written with the words under a prefix, follows the older one with no recipe.
  const next = publish(shop(`cfu:lane: ${LANE}`).replace("shop /2026-11-05", "shop /2026-11-06"), { date: "2026-11-06", previous: older });
  assert.ok(classify(older, next.bundle).every((c) => c.kind !== "breaking" && c.kind !== "retired"));
});

// Revision 13 (11.1): a utility's mark, a glyph and a hue from the eight words.
test("a utility's mark is read, carried through the bundle and back, and refused outside the eight hues", () => {
  const [info] = readPackages(shop(""));
  assert.deepEqual([info?.utilities[0]?.mark?.glyph, info?.utilities[0]?.mark?.hue], ["parcel", "amber"]);
  const first = bundleOf(parsePackage(shop("")));
  assert.deepEqual((first.utilities as { mark?: { glyph: string; hue: string } }[])[0]?.mark, { glyph: "parcel", hue: "amber" });
  assert.match(printBundle(first), /^  mark: parcel amber$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  const bad = (m: string, why: RegExp) => assert.throws(() => readPackages(shop("").replace("mark: parcel amber", m)), (e: unknown) => e instanceof CrubalError && why.test(e.message));
  bad("mark: parcel pink", /pink is not a hue/);
  bad("mark: parcel", /is "<glyph> <hue>"/);
  bad("mark: Parcel amber", /is "<glyph> <hue>"/);
  const [plain] = readPackages(shop("").replace("  mark: parcel amber\n", ""));
  assert.equal(plain?.utilities[0]?.mark, undefined);
});

test("a utility says its group by a word and its owner; a kind says a face per level: read, carried and printed back, judged only as words", () => {
  const src = shop("")
    .replace(/^(utility: \S+ \/\S+\n)/m, "$1  group: Org\n  owner: cashierfu\n")
    .replace(/^( {2}levels: order, line\n)/m, "$1  face:\n    order: ticket\n    line: id-card\n");
  const [info] = readPackages(src);
  assert.deepEqual([info?.utilities[0]?.group, info?.utilities[0]?.owner], ["Org", "cashierfu"]);
  const text = printBundle(bundleOf(parsePackage(src)));
  assert.match(text, /^ {2}group: Org$/m);
  assert.match(text, /^ {2}owner: cashierfu$/m);
  assert.match(text, /^ {2}face:\n {4}order: ticket\n {4}line: id-card$/m);
  assert.throws(() => parsePackage(src.replace("owner: cashierfu", "owner: Cashierfu Inc")), /owner is one lower-case word/);
  assert.throws(() => parsePackage(src.replace("    line: id-card", "    box: id-card")), /isn't a level of order/);
});

test("edit flows is a menu item's target (revision 23): a gate a reader's designer may stand behind", () => {
  const { perms } = readAccess("permissions: shop\n  menu:\n    design: edit flows\n  presets:\n    designer: design    audience: staff\n");
  checkPermissions(perms, emptyDictionary());
  assert.deepEqual(perms.menu.get("design")?.verbs, { edit: ["flows"] });
});

test("revision 54: a when tests a value against a word written there, `<ref> is <word>` and `is not`; a value not set is not the word", async () => {
  const { readWhen, whenHolds, whenJson, whenText } = await import("../src/acts.ts");
  const on = (values: { [k: string]: string }) => ({ record: { id: "U-1", values }, context: {}, found: {}, now: "" });
  const is = readWhen("record.stale is yes and record.qty > 0", 1);
  assert.equal(whenText(whenJson(is)), "record.stale is yes and record.qty > 0");
  assert.equal(whenHolds(is, on({ stale: "yes", qty: "2" })), true);
  assert.equal(whenHolds(is, on({ stale: "no", qty: "2" })), false);
  assert.equal(whenHolds(is, on({ qty: "2" })), false, "not set is not yes");
  const not = readWhen("record.stale is not yes", 1);
  assert.equal(whenText(whenJson(not)), "record.stale is not yes");
  assert.equal(whenHolds(not, on({ stale: "no" })), true);
  assert.equal(whenHolds(not, on({})), true, "not set is not yes");
  assert.equal(whenHolds(not, on({ stale: "yes" })), false);
});
