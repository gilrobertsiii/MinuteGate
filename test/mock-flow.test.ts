// End-to-end tests in mock mode: no credentials, no network beyond 127.0.0.1.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { MinuteGate, createGateServer } from "../src/server.js";
import { PayPalError, PayPalSandboxClient, PAYPAL_SANDBOX_BASE, type Order } from "../src/paypal.js";
import { requestResource, startPayment, finishPayment, retryWithProof } from "../src/client.js";
import { startMockPayPal, type MockPayPal } from "../src/mock-paypal.js";
import { parseProof, formatProof, type PaymentRequired } from "../src/protocol.js";

let mock: MockPayPal;
let paypal: PayPalSandboxClient;
let server: Server;
let url: string;
let clock = Date.now();

/**
 * Client whose server-side order lookups the tests can stall or fail, so the
 * gate's in-flight claims can be exercised deterministically.
 */
class ControlledPayPal extends PayPalSandboxClient {
  lookups = 0;
  hold: Promise<void> | null = null;
  failNext: Error | null = null;

  async getOrder(orderId: string): Promise<Order> {
    this.lookups++;
    const fail = this.failNext;
    if (fail) {
      this.failNext = null;
      throw fail;
    }
    if (this.hold) await this.hold;
    return super.getOrder(orderId);
  }
}

let controlled: ControlledPayPal;
let controlledServer: Server;
let controlledUrl: string;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function waitForLookups(n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (controlled.lookups < n) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} lookups (saw ${controlled.lookups})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

before(async () => {
  mock = await startMockPayPal();
  paypal = new PayPalSandboxClient({ ...mock.credentials, baseUrl: mock.baseUrl });
  server = createGateServer(new MinuteGate({ paypal, ttlSeconds: 600, now: () => clock }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resource`;

  controlled = new ControlledPayPal({ ...mock.credentials, baseUrl: mock.baseUrl });
  controlledServer = createGateServer(new MinuteGate({ paypal: controlled, ttlSeconds: 600, now: () => clock }));
  await new Promise<void>((resolve) => controlledServer.listen(0, "127.0.0.1", resolve));
  controlledUrl = `http://127.0.0.1:${(controlledServer.address() as AddressInfo).port}/resource`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => controlledServer.close(() => resolve()));
  await mock.close();
});

async function fresh402(target: string = url): Promise<PaymentRequired> {
  const r = await requestResource(target);
  assert.equal(r.status, 402);
  assert.ok(r.required);
  return r.required;
}

/** Creates, approves (mock) and captures an order with the given fields. */
async function captured(fields: { amount: string; currency: string; reference: string }): Promise<string> {
  const order = await paypal.createOrder(fields);
  await mock.approve(order.id);
  await paypal.captureOrder(order.id);
  return order.id;
}

test("402 body carries amount, currency, rate, reference and expiry", async () => {
  const req = await fresh402();
  assert.equal(req.amount, "1.00");
  assert.equal(req.currency, "USD");
  assert.deepEqual(req.rate, { unit: "session", price: "1.00", quantity: 1 });
  assert.match(req.reference, /^mg_/);
  assert.ok(Date.parse(req.expiresAt) > Date.now());
  assert.deepEqual(req.methods, ["paypal-sandbox"]);
  assert.equal(req.proofHeader, "minutegate-payment");
});

test("happy path: create, approve, capture, retry -> 200 with receipt", async () => {
  const req = await fresh402();
  const pending = await startPayment(paypal, url, req);
  assert.match(pending.approveUrl, /\/mock\/checkoutnow\?token=/);
  await mock.approve(pending.order.id);
  const done = await finishPayment(paypal, url, req.reference, pending.order.id);
  assert.equal(done.status, 200);
  assert.match(done.receipt ?? "", /^CAP-/);

  // Replaying the same proof is rejected.
  const replay = await retryWithProof(url, req.reference, pending.order.id);
  assert.equal(replay.status, 402);
  assert.equal((replay.body as PaymentRequired).error, "reference_used");
});

test("rejects a captured order whose amount does not match", async () => {
  const req = await fresh402();
  const orderId = await captured({ amount: "0.01", currency: req.currency, reference: req.reference });
  const r = await retryWithProof(url, req.reference, orderId);
  assert.equal(r.status, 402);
  assert.equal((r.body as PaymentRequired).error, "amount_mismatch");
});

test("rejects a captured order whose currency does not match", async () => {
  const req = await fresh402();
  const orderId = await captured({ amount: req.amount, currency: "EUR", reference: req.reference });
  const r = await retryWithProof(url, req.reference, orderId);
  assert.equal((r.body as PaymentRequired).error, "currency_mismatch");
});

test("rejects a captured order carrying a different reference", async () => {
  const reqA = await fresh402();
  const reqB = await fresh402();
  // Order is tagged with reference B but presented as proof for reference A.
  const orderId = await captured({ amount: reqA.amount, currency: reqA.currency, reference: reqB.reference });
  const r = await retryWithProof(url, reqA.reference, orderId);
  assert.equal(r.status, 402);
  assert.equal((r.body as PaymentRequired).error, "reference_mismatch");
});

test("an order already used for one reference cannot unlock another", async () => {
  const reqA = await fresh402();
  const pending = await startPayment(paypal, url, reqA);
  await mock.approve(pending.order.id);
  const ok = await finishPayment(paypal, url, reqA.reference, pending.order.id);
  assert.equal(ok.status, 200);
  const reqB = await fresh402();
  const r = await retryWithProof(url, reqB.reference, pending.order.id);
  assert.equal((r.body as PaymentRequired).error, "order_reused");
});

test("rejects an order with buyer approval but no capture", async () => {
  const req = await fresh402();
  const pending = await startPayment(paypal, url, req);
  await mock.approve(pending.order.id);
  // Buyer approval moves the order to APPROVED (as at PayPal), but nothing is captured yet.
  assert.equal((await paypal.getOrder(pending.order.id)).status, "APPROVED");
  const r = await retryWithProof(url, req.reference, pending.order.id);
  assert.equal(r.status, 402);
  assert.equal((r.body as PaymentRequired).error, "not_captured");
  assert.equal(r.receipt, null);
});

test("rejects a made-up order id (client-supplied ids are only lookup keys)", async () => {
  const req = await fresh402();
  const r = await retryWithProof(url, req.reference, "FAKEORDER123");
  assert.equal((r.body as PaymentRequired).error, "order_not_found");
});

test("rejects an unknown reference and a malformed proof", async () => {
  const r1 = await retryWithProof(url, "mg_notissuedbythisserver", "ABC123");
  assert.equal((r1.body as PaymentRequired).error, "unknown_reference");
  const res = await fetch(url, { headers: { "minutegate-payment": "garbage" } });
  assert.equal(res.status, 402);
  assert.equal(((await res.json()) as PaymentRequired).error, "malformed_proof");
});

test("rejects an expired reference", async () => {
  const req = await fresh402();
  const orderId = await captured({ amount: req.amount, currency: req.currency, reference: req.reference });
  clock += 601_000;
  try {
    const r = await retryWithProof(url, req.reference, orderId);
    assert.equal((r.body as PaymentRequired).error, "reference_expired");
  } finally {
    clock -= 601_000;
  }
});

test("capture fails at PayPal (mock) without buyer approval", async () => {
  const req = await fresh402();
  const pending = await startPayment(paypal, url, req);
  await assert.rejects(() => paypal.captureOrder(pending.order.id), /failed \(422\)/);
});

test("PayPal client refuses any base URL other than the sandbox or loopback", () => {
  assert.equal(new PayPalSandboxClient({ clientId: "x", clientSecret: "y" }).baseUrl, PAYPAL_SANDBOX_BASE);
  assert.throws(() => new PayPalSandboxClient({ clientId: "x", clientSecret: "y", baseUrl: "https://api-m.paypal.com" }));
  assert.throws(() => new PayPalSandboxClient({ clientId: "x", clientSecret: "y", baseUrl: "https://example.com" }));
});

test("proof header round-trips and rejects junk", () => {
  const p = { reference: "mg_abcdefgh1234", orderId: "5O190127TN364715T" };
  assert.deepEqual(parseProof(formatProof(p)), p);
  assert.equal(parseProof("reference=mg_x; order=../../etc"), null);
  assert.equal(parseProof(undefined), null);
});

test("concurrent identical proofs unlock the resource exactly once", async () => {
  for (let trial = 0; trial < 5; trial++) {
    const req = await fresh402();
    const orderId = await captured({ amount: req.amount, currency: req.currency, reference: req.reference });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => retryWithProof(url, req.reference, orderId)),
    );
    const unlocked = results.filter((r) => r.status === 200).length;
    assert.equal(unlocked, 1, `trial ${trial}: ${unlocked} unlocks`);
    for (const r of results.filter((x) => x.status !== 200)) assert.equal(r.status, 402);
  }
});

test("a third party presenting someone else's order id cannot block the owner", async () => {
  for (const attackerFirst of [true, false]) {
    const victim = await fresh402(controlledUrl);
    const orderId = await captured({ amount: victim.amount, currency: victim.currency, reference: victim.reference });
    const attacker = await fresh402(controlledUrl);

    const gate = deferred();
    controlled.hold = gate.promise;
    controlled.lookups = 0;
    try {
      let attackerAttempt: Promise<Awaited<ReturnType<typeof retryWithProof>>>;
      let victimAttempt: Promise<Awaited<ReturnType<typeof retryWithProof>>>;
      if (attackerFirst) {
        attackerAttempt = retryWithProof(controlledUrl, attacker.reference, orderId);
        await waitForLookups(1);
        victimAttempt = retryWithProof(controlledUrl, victim.reference, orderId);
      } else {
        victimAttempt = retryWithProof(controlledUrl, victim.reference, orderId);
        await waitForLookups(1);
        attackerAttempt = retryWithProof(controlledUrl, attacker.reference, orderId);
      }
      // Both lookups for the victim's order are in flight at once: neither was turned away early.
      await waitForLookups(2);

      // A duplicate of the victim's own proof is still turned away by the reference claim.
      // Wait until it either answers or (if the claim were missing) reaches a third lookup.
      let duplicateSettled = false;
      const duplicateAttempt = retryWithProof(controlledUrl, victim.reference, orderId).finally(() => {
        duplicateSettled = true;
      });
      const deadline = Date.now() + 5000;
      while (!duplicateSettled && controlled.lookups < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }

      gate.resolve();
      const [v, a, duplicate] = await Promise.all([victimAttempt, attackerAttempt, duplicateAttempt]);
      assert.equal(duplicate.status, 402, `attackerFirst=${attackerFirst}: duplicate proof got ${duplicate.status}`);
      assert.equal((duplicate.body as PaymentRequired).error, "reference_used");

      assert.notEqual((v.body as PaymentRequired).error, "order_reused", `attackerFirst=${attackerFirst}`);
      assert.equal(v.status, 200, `attackerFirst=${attackerFirst}: victim got ${JSON.stringify(v.body)}`);
      assert.match(v.receipt ?? "", /^CAP-/);

      assert.equal(a.status, 402);
      assert.equal((a.body as PaymentRequired).error, "reference_mismatch", `attackerFirst=${attackerFirst}`);
    } finally {
      gate.resolve();
      controlled.hold = null;
    }

    // The order has now unlocked the victim's reference and cannot unlock anything else.
    const again = await retryWithProof(controlledUrl, attacker.reference, orderId);
    assert.equal((again.body as PaymentRequired).error, "order_reused");
  }
});

test("claims are released when the PayPal lookup fails, so the same proof can be retried", async () => {
  const req = await fresh402(controlledUrl);
  const orderId = await captured({ amount: req.amount, currency: req.currency, reference: req.reference });

  controlled.failNext = new PayPalError("PayPal GET order failed (503)", 503, { name: "SERVICE_UNAVAILABLE" });
  try {
    const first = await retryWithProof(controlledUrl, req.reference, orderId);
    assert.equal(first.status, 402);
    assert.equal((first.body as PaymentRequired).error, "paypal_unavailable");
  } finally {
    controlled.failNext = null;
  }

  const retry = await retryWithProof(controlledUrl, req.reference, orderId);
  assert.equal(retry.status, 200, `retry got ${JSON.stringify(retry.body)}`);
  assert.match(retry.receipt ?? "", /^CAP-/);
});
