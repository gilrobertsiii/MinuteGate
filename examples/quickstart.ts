// MinuteGate quickstart.
//   MINUTEGATE_MOCK=1  -> full flow against an in-process PayPal mock (no credentials).
//   otherwise          -> PayPal sandbox: runs up to the buyer approval step,
//                         prints the approval link, and stops.

import type { AddressInfo } from "node:net";
import { MinuteGate, createGateServer } from "../src/server.js";
import { PayPalSandboxClient, configFromEnv } from "../src/paypal.js";
import { requestResource, startPayment, finishPayment, retryWithProof } from "../src/client.js";
import { startMockPayPal } from "../src/mock-paypal.js";

const mock = process.env.MINUTEGATE_MOCK === "1";

async function main(): Promise<void> {
  const mockPayPal = mock ? await startMockPayPal() : null;
  const paypal = mockPayPal
    ? new PayPalSandboxClient({ ...mockPayPal.credentials, baseUrl: mockPayPal.baseUrl })
    : new PayPalSandboxClient(configFromEnv());

  const gate = new MinuteGate({ paypal });
  const server = createGateServer(gate);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resource`;

  try {
    console.log(`MinuteGate quickstart (${mock ? "MOCK mode, no credentials" : "PayPal SANDBOX mode"})`);
    console.log(`PayPal base URL: ${paypal.baseUrl}`);

    console.log(`\n1. GET ${url}`);
    const first = await requestResource(url);
    if (!first.required) throw new Error(`expected 402, got ${first.status}`);
    const req = first.required;
    console.log(`   -> ${first.status} Payment Required: ${req.amount} ${req.currency} per ${req.rate.unit}, reference ${req.reference}, expires ${req.expiresAt}`);

    console.log("\n2. Create PayPal order");
    const pending = await startPayment(paypal, url, req);
    console.log(`   -> order ${pending.order.id} (${pending.order.status})`);
    console.log(`   -> approval link: ${pending.approveUrl}`);

    if (!mockPayPal) {
      console.log("\nStopping here: the next step needs a PayPal sandbox buyer to open the approval link.");
      console.log("Capture runs only after that approval, with your own sandbox credentials.");
      console.log("For the full two-terminal sandbox flow, see QUICKSTART.md (\"Sandbox: full flow\").");
      return;
    }

    console.log("\n3. Buyer approval (simulated by the mock)");
    await mockPayPal.approve(pending.order.id);

    console.log("\n4. Capture and retry with proof header");
    const done = await finishPayment(paypal, url, req.reference, pending.order.id);
    console.log(`   -> ${done.status}, receipt (capture id) ${done.receipt}`);
    if (done.status !== 200) throw new Error("expected 200 after capture");

    console.log("\n5. Tamper check: pay 0.01 against a fresh reference and retry");
    const second = await requestResource(url);
    const req2 = second.required!;
    const bad = await startPayment(paypal, url, { ...req2, amount: "0.01" });
    await mockPayPal.approve(bad.order.id);
    await paypal.captureOrder(bad.order.id);
    const rejected = await retryWithProof(url, req2.reference, bad.order.id);
    console.log(`   -> ${rejected.status}, error ${(rejected.body as { error?: string }).error}`);
    if (rejected.status !== 402) throw new Error("tampered payment should be rejected");

    console.log("\nMock quickstart finished: 1 accepted payment, 1 rejected tamper attempt.");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mockPayPal?.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nQuickstart failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
