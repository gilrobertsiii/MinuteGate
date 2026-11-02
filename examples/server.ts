// Long-running example server for the two-terminal PayPal sandbox flow.
// Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your environment.

import { MinuteGate, createGateServer } from "../src/server.js";
import { PayPalSandboxClient, configFromEnv } from "../src/paypal.js";

const port = Number(process.env.PORT ?? 4020);
const paypal = new PayPalSandboxClient(configFromEnv());
const server = createGateServer(new MinuteGate({ paypal }));
server.listen(port, "127.0.0.1", () => {
  console.log(`MinuteGate example server on http://127.0.0.1:${port}/resource (PayPal sandbox: ${paypal.baseUrl})`);
});
