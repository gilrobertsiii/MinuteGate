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

// Close the listener on Ctrl+C or a process manager's SIGTERM so the port is freed.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
