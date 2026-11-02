import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProof, formatProof, type PaymentRequired } from "../src/protocol.js";
import { MinuteGate } from "../src/server.js";
import { PayPalSandboxClient } from "../src/paypal.js";

test("proof round trips at identifier boundaries", () => {
  for (const n of [8, 64]) for (const m of [1, 64]) {
    const proof = { reference: `mg_${"a".repeat(n)}`, orderId: "A".repeat(m) };
    assert.deepEqual(parseProof(formatProof(proof)), proof);
  }
  const proof = { reference: "mg_aB09_-xy", orderId: "EXAMPLE-001" };
  assert.equal(formatProof(proof), "reference=mg_aB09_-xy; order=EXAMPLE-001");
  assert.deepEqual(parseProof(formatProof(proof)), proof);
});

test("rejects malformed proofs", () => {
  const invalid = [undefined, "", "junk", "reference=mg_abcdefgh", "order=A",
    "reference=mg_abcdefg; order=A", `reference=mg_${"a".repeat(65)}; order=A`,
    "reference=MG_abcdefgh; order=A", "reference=mg_abc.defg; order=A",
    "reference=mg_abcdefgh; order=", "reference=mg_abcdefgh; order=lowercase",
    "reference=mg_abcdefgh; order=../A", `reference=mg_abcdefgh; order=${"A".repeat(65)}`,
    "reference=mg_abcdefgh; order=A;", "Reference=mg_abcdefgh; order=A",
    'reference="mg_abcdefgh"; order=A'];
  for (const value of invalid) assert.equal(parseProof(value), null, String(value));
  const prefix = "reference=mg_abcdefgh; order=A; extra=";
  assert.deepEqual(parseProof(prefix.padEnd(256, "x")), { reference: "mg_abcdefgh", orderId: "A" });
  assert.equal(parseProof(prefix.padEnd(257, "x")), null);
});

test("current parser trims, accepts extra fields and uses the last duplicate", () => {
  assert.deepEqual(parseProof(" order = A ; extra=x; reference = mg_abcdefgh "),
    { reference: "mg_abcdefgh", orderId: "A" });
  assert.deepEqual(parseProof("reference=bad; reference=mg_abcdefgh; order=A; order=B"),
    { reference: "mg_abcdefgh", orderId: "B" });
  assert.equal(parseProof("reference=mg_abcdefgh; reference=bad; order=A"), null);
});

test("PaymentRequired reflects actual server output without HTTP or credentials", () => {
  // A prototype-only stub: paymentRequired must never invoke the provider.
  const paypal = Object.create(PayPalSandboxClient.prototype) as PayPalSandboxClient;
  paypal.getOrder = async () => { throw new Error("unexpected provider lookup"); };
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const gate = new MinuteGate({ paypal, now: () => now });
  const body: PaymentRequired = gate.paymentRequired();
  assert.match(body.reference, /^mg_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(body, {
    minutegate: "0.1", amount: "1.00", currency: "USD",
    rate: { unit: "session", price: "1.00", quantity: 1 },
    reference: body.reference, expiresAt: "2026-11-05T12:15:00.000Z",
    methods: ["paypal-sandbox"], proofHeader: "minutegate-payment",
    description: "MinuteGate example resource (PayPal sandbox only)",
  });
  const retry = gate.paymentRequired("malformed_proof");
  assert.equal(retry.error, "malformed_proof");
  assert.notEqual(retry.reference, body.reference);
  const minute = new MinuteGate({ paypal, now: () => now, ttlSeconds: 60,
    currency: "EUR", rate: { unit: "minute", price: "0.25", quantity: 3 } }).paymentRequired();
  assert.equal(minute.amount, "0.75");
  assert.equal(minute.currency, "EUR");
  assert.deepEqual(minute.rate, { unit: "minute", price: "0.25", quantity: 3 });
  assert.equal(minute.expiresAt, "2026-11-05T12:01:00.000Z");
});
