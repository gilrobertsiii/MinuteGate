// R-MinuteGate-1/3/4/5 (MG-22): bounded in-memory stores, outbound timeouts and
// token request coalescing. Mock mode only: no credentials, loopback only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MinuteGate } from "../src/server.js";
import { PayPalError, PayPalSandboxClient, type Order } from "../src/paypal.js";
import { requestResource } from "../src/client.js";
import { startMockPayPal } from "../src/mock-paypal.js";
import { formatProof } from "../src/protocol.js";

/** Minimal stand-in for the PayPal client: tests drive getOrder directly. */
function stubPayPal(getOrder: (id: string) => Promise<Order>): PayPalSandboxClient {
  return { getOrder } as unknown as PayPalSandboxClient;
}

function capturedOrder(id: string, reference: string, value = "1.00"): Order {
  return {
    id,
    status: "COMPLETED",
    purchase_units: [
      {
        custom_id: reference,
        amount: { currency_code: "USD", value },
        payments: { captures: [{ id: `CAP-${id}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] },
      },
    ],
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("expired references are swept after the retention window", async () => {
  let clock = 1_000_000;
  const gate = new MinuteGate({
    paypal: stubPayPal(async () => {
      throw new Error("not called");
    }),
    ttlSeconds: 60,
    retainSeconds: 60,
    sweepIntervalMs: 0,
    now: () => clock,
  });
  const refs = Array.from({ length: 25 }, () => gate.paymentRequired().reference);
  assert.equal(gate.stats().references, 25);

  // Expired but inside the retention window: still answers reference_expired.
  clock += 61_000;
  const late = await gate.check(formatProof({ reference: refs[0], orderId: "ORDER1" }));
  assert.deepEqual(late, { ok: false, code: "reference_expired" });

  // Past expiry + retention: forgotten.
  clock += 60_000;
  gate.sweep();
  assert.equal(gate.stats().references, 0);
  const gone = await gate.check(formatProof({ reference: refs[1], orderId: "ORDER1" }));
  assert.deepEqual(gone, { ok: false, code: "unknown_reference" });
});

test("a flood of 402s (including failed retries) stays under maxReferences", async () => {
  const gate = new MinuteGate({
    paypal: stubPayPal(async () => {
      throw new PayPalError("nope", 404, null);
    }),
    maxReferences: 50,
  });
  for (let i = 0; i < 1000; i++) {
    const req = gate.paymentRequired();
    // A failed check mints a fresh reference on the 402 (SPEC section 1); that must stay bounded too.
    const r = await gate.check(formatProof({ reference: req.reference, orderId: `X${i}` }));
    assert.equal(r.ok, false);
    gate.paymentRequired(r.ok ? undefined : r.code);
  }
  assert.ok(gate.stats().references <= 50, `references=${gate.stats().references}`);
  assert.equal(gate.stats().pending, 0);
});

test("the newest references survive the cap and still unlock", async () => {
  const gate = new MinuteGate({
    paypal: stubPayPal(async (id) => capturedOrder(id, last)),
    maxReferences: 10,
  });
  let last = "";
  for (let i = 0; i < 100; i++) last = gate.paymentRequired().reference;
  const ok = await gate.check(formatProof({ reference: last, orderId: "ORDERLAST" }));
  assert.equal(ok.ok, true);
});

test("a reference with a check in flight is never evicted by the cap", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let target = "";
  const gate = new MinuteGate({
    paypal: stubPayPal(async (id) => {
      await hold;
      return capturedOrder(id, target);
    }),
    maxReferences: 5,
  });
  target = gate.paymentRequired().reference;
  const inFlight = gate.check(formatProof({ reference: target, orderId: "ORDERHELD" }));
  for (let i = 0; i < 50; i++) gate.paymentRequired();
  assert.ok(gate.stats().references <= 5);
  release();
  const result = await inFlight;
  assert.equal(result.ok, true);
  // And the used reference still reports reference_used while retained.
  const replay = await gate.check(formatProof({ reference: target, orderId: "ORDERHELD" }));
  assert.deepEqual(replay, { ok: false, code: "reference_used" });
});

test("used order ids are forgotten with their reference, and replays stay rejected", async () => {
  let clock = 5_000_000;
  let current = "";
  const gate = new MinuteGate({
    paypal: stubPayPal(async (id) => capturedOrder(id, current)),
    ttlSeconds: 60,
    retainSeconds: 60,
    sweepIntervalMs: 0,
    now: () => clock,
  });
  current = gate.paymentRequired().reference;
  assert.equal((await gate.check(formatProof({ reference: current, orderId: "ORDERA" }))).ok, true);
  assert.equal(gate.stats().usedOrders, 1);

  const other = gate.paymentRequired().reference;
  assert.deepEqual(await gate.check(formatProof({ reference: other, orderId: "ORDERA" })), {
    ok: false,
    code: "order_reused",
  });

  clock += 121_000;
  gate.sweep();
  assert.deepEqual(gate.stats(), { references: 0, usedOrders: 0, pending: 0 });
  // The original reference is gone, so the old proof cannot unlock anything.
  assert.deepEqual(await gate.check(formatProof({ reference: current, orderId: "ORDERA" })), {
    ok: false,
    code: "unknown_reference",
  });
  // A new reference with the old order is still refused (its custom_id names the old reference).
  const fresh = gate.paymentRequired().reference;
  const r = await gate.check(formatProof({ reference: fresh, orderId: "ORDERA" }));
  assert.equal(r.ok, false);
});

test("PayPal calls time out, map to paypal_unavailable and release the claim", async () => {
  let tokenCalls = 0;
  const hung = createServer((req, res) => {
    if (req.url === "/v1/oauth2/token") {
      tokenCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      return;
    }
    // Never answer order lookups.
  });
  const base = await listen(hung);
  try {
    const paypal = new PayPalSandboxClient({ clientId: "x", clientSecret: "y", baseUrl: base, timeoutMs: 100 });
    await assert.rejects(
      () => paypal.getOrder("ORDER1"),
      (err: unknown) => err instanceof PayPalError && err.status === 0 && /timed out/.test(err.message),
    );
    const gate = new MinuteGate({ paypal });
    const req = gate.paymentRequired();
    const started = Date.now();
    const r = await gate.check(formatProof({ reference: req.reference, orderId: "ORDER1" }));
    assert.deepEqual(r, { ok: false, code: "paypal_unavailable" });
    assert.ok(Date.now() - started < 2000);
    assert.equal(gate.stats().pending, 0);
    assert.equal(tokenCalls, 1);
  } finally {
    await close(hung);
  }
});

test("concurrent calls after token expiry share one token request", async () => {
  let tokenCalls = 0;
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/oauth2/token") {
      tokenCalls++;
      // Slow token endpoint so the callers overlap.
      setTimeout(() => res.end(JSON.stringify({ access_token: `t${tokenCalls}`, expires_in: 3600 })), 50);
      return;
    }
    res.end(JSON.stringify({ id: "O", status: "CREATED", purchase_units: [] }));
  });
  const base = await listen(srv);
  try {
    const paypal = new PayPalSandboxClient({ clientId: "x", clientSecret: "y", baseUrl: base });
    await Promise.all(Array.from({ length: 10 }, (_, i) => paypal.getOrder(`O${i}`)));
    assert.equal(tokenCalls, 1);
  } finally {
    await close(srv);
  }
});

test("a failed token request is not cached and can be retried", async () => {
  let tokenCalls = 0;
  const srv = createServer((req, res) => {
    res.writeHead(req.url === "/v1/oauth2/token" && ++tokenCalls === 1 ? 500 : 200, {
      "content-type": "application/json",
    });
    if (req.url === "/v1/oauth2/token") return res.end(JSON.stringify(tokenCalls === 1 ? {} : { access_token: "t", expires_in: 3600 }));
    res.end(JSON.stringify({ id: "O", status: "CREATED", purchase_units: [] }));
  });
  const base = await listen(srv);
  try {
    const paypal = new PayPalSandboxClient({ clientId: "x", clientSecret: "y", baseUrl: base });
    await assert.rejects(() => paypal.getOrder("O"), PayPalError);
    assert.equal((await paypal.getOrder("O")).id, "O");
    assert.equal(tokenCalls, 2);
  } finally {
    await close(srv);
  }
});

test("client requests to a hung resource time out", async () => {
  const hung = createServer(() => {});
  const base = await listen(hung);
  try {
    await assert.rejects(() => requestResource(`${base}/resource`, { timeoutMs: 100 }), /timeout|aborted/i);
  } finally {
    await close(hung);
  }
});

test("mock PayPal drops old orders and expired tokens", async () => {
  let clock = Date.now();
  const mock = await startMockPayPal({ now: () => clock, orderTtlMs: 60_000 });
  try {
    const paypal = new PayPalSandboxClient({ ...mock.credentials, baseUrl: mock.baseUrl });
    await paypal.createOrder({ amount: "1.00", currency: "USD", reference: "mg_a" });
    await paypal.createOrder({ amount: "1.00", currency: "USD", reference: "mg_b" });
    assert.deepEqual(mock.stats(), { orders: 2, tokens: 1 });
    clock += 61_000;
    assert.equal(mock.stats().orders, 0);
    clock += 3_600_000;
    assert.equal(mock.stats().tokens, 0);
  } finally {
    await mock.close();
  }
});
