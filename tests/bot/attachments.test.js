import assert from "node:assert/strict";
import test from "node:test";
import { attachmentsEmail } from "../../bot/lib/board.js";
import { renderHtml } from "../../bot/lib/render.js";

const evidence = (id, from, receivedAt, names, webLink = `https://mail.example/${id}`) => ({ id, from, receivedAt, attachmentsNotRead: names, webLink });
const decision = (items) => ({ customer: { name: "Acme Precision", emailDomains: ["acme.example"] }, lines: [{ history: { email: { evidence: items } } }, { history: { email: { evidence: items.slice(0, 1) } } }] });

test("the attachments link opens the customer's own newest email with files the pricing could not read", () => {
  const files = attachmentsEmail(decision([
    evidence("fwd", "desk@shop.example", "2026-09-28T21:17:00Z", ["A.LIS", "B.STEP"]),
    evidence("old", "buyer@acme.example", "2026-09-01T10:00:00Z", ["old.pdf"]),
    evidence("rfq", "buyer@acme.example", "2026-09-28T21:16:00Z", ["A.LIS", "B.STEP"]),
    evidence("reply", "buyer@acme.example", "2026-09-29T10:00:00Z", []),
  ]));
  assert.deepEqual(files, { href: "https://mail.example/rfq", at: "2026-09-28T21:16:00Z", from: "buyer@acme.example", names: ["A.LIS", "B.STEP"] });
  assert.equal(attachmentsEmail(decision([evidence("reply", "buyer@acme.example", "2026-09-29T10:00:00Z", [])])), null, "no files, no link");
  assert.equal(attachmentsEmail(decision([evidence("fwd", "desk@shop.example", "2026-09-28T21:17:00Z", ["A.LIS"])])).href, "https://mail.example/fwd", "a forwarded copy when the customer's own is not saved");
});

test("links prefer the shared mailbox's copy, and a link into one person's mailbox says whose", async () => {
  const { privateOwner, sharedLink } = await import("../../bot/lib/board.js");
  const copies = new Map([["own-id", { "pat@shop.example": "own-id", "desk@shop.example": "desk_id=" }], ["desk_id=", { "pat@shop.example": "own-id", "desk@shop.example": "desk_id=" }]]);
  assert.equal(sharedLink("own-id", copies, "desk@shop.example"), "https://outlook.office.com/mail/desk@shop.example/deeplink?ItemID=desk_id%3D&exvsurl=1&viewmodel=ReadMessageItem");
  assert.equal(sharedLink("unknown", copies, "desk@shop.example"), null, "no saved copy: keep the original link");
  const prefixes = { AAA1: "pat@shop.example", BBB2: "desk@shop.example" };
  assert.equal(privateOwner("https://mail.example/?ItemID=AAA1xyz&x=1", prefixes, "desk@shop.example"), "Pat");
  assert.equal(privateOwner("https://mail.example/?ItemID=BBB2xyz", prefixes, "desk@shop.example"), null, "the shared mailbox is everyone's");
  assert.equal(privateOwner("https://mail.example/?ItemID=CCC3xyz", prefixes, "desk@shop.example"), null, "unknown mailbox: no tag");
});

test("the publish step starts only when private config names a command, and never waits for it", async () => {
  const { startPublish } = await import("../../bot/lib/sync.js");
  const calls = [];
  const fake = (program, args, options) => { calls.push([program, args, options.detached]); return { unref() {} }; };
  assert.equal(startPublish({}, fake), false);
  assert.equal(startPublish({ publishCommand: [] }, fake), false);
  assert.equal(startPublish({ publishCommand: ["node", "publish.mjs"] }, fake), true);
  assert.deepEqual(calls, [["node", ["publish.mjs"], true]]);
});
