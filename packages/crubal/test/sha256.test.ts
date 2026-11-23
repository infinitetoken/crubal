// The pure SHA-256 (src/sha256.ts) gives what Node's gives: a finished list's mark (1.6) is the same word in a
// page as on a server, and a mark already held by a record still reads as finished.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex } from "../src/sha256.ts";

const node = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("the known answers", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("the same as Node's at every length around a block's edge, and over text that is not ASCII", () => {
  for (let n = 0; n <= 200; n++) {
    const text = "r".repeat(n);
    assert.equal(sha256Hex(text), node(text), `length ${n}`);
  }
  for (const text of ["r1\nr2\nr3", "Amélie · 東京 · 🎬", "a".repeat(70000), "\u0000", "línea\n".repeat(999)])
    assert.equal(sha256Hex(text), node(text), text.slice(0, 20));
  let seed = 7;
  for (let i = 0; i < 300; i++) {
    let text = "";
    const len = (seed = (seed * 1103515245 + 12345) >>> 0) % 300;
    for (let j = 0; j < len; j++) text += String.fromCharCode(32 + ((seed = (seed * 1103515245 + 12345) >>> 0) % 2000));
    assert.equal(sha256Hex(text), node(text));
  }
});
