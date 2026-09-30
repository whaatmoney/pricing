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
