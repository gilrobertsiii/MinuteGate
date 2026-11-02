// Example client for the two-terminal PayPal sandbox flow.
//   npm run sandbox:client                                   -> 402, create order, print approval link, stop
//   npm run sandbox:client -- --reference <ref> --order <id> -> capture (after approval) and retry

import { parseArgs } from "node:util";
import { PayPalSandboxClient, configFromEnv } from "../src/paypal.js";
import { requestResource, startPayment, finishPayment } from "../src/client.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: process.env.MINUTEGATE_URL ?? "http://127.0.0.1:4020/resource" },
    reference: { type: "string" },
    order: { type: "string" },
  },
});

async function main(): Promise<void> {
  const paypal = new PayPalSandboxClient(configFromEnv());
  const url = values.url!;

  if (values.reference && values.order) {
    const done = await finishPayment(paypal, url, values.reference, values.order);
    console.log(`Retry -> ${done.status}${done.receipt ? `, receipt (capture id) ${done.receipt}` : ""}`);
    console.log(JSON.stringify(done.body, null, 2));
    if (done.status !== 200) process.exitCode = 1;
    return;
  }

  const first = await requestResource(url);
  if (!first.required) {
    console.log(`Not gated: ${first.status}`);
    return;
  }
  const req = first.required;
  console.log(`402: ${req.amount} ${req.currency}, reference ${req.reference}, expires ${req.expiresAt}`);
  const pending = await startPayment(paypal, url, req);
  console.log(`Order ${pending.order.id} created. Open this link as a PayPal sandbox buyer and approve:`);
  console.log(`  ${pending.approveUrl}`);
  console.log("Then run:");
  console.log(`  npm run sandbox:client -- --reference ${req.reference} --order ${pending.order.id}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
