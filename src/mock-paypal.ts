// In-process mock of the small slice of the PayPal Orders v2 API MinuteGate
// uses. Lets the whole flow run end to end with no credentials and no network.
// Mock mode only: nothing here talks to PayPal.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Order } from "./paypal.js";

interface MockOrder {
  order: Order;
  buyerApproval: boolean;
}

export interface MockPayPal {
  baseUrl: string;
  credentials: { clientId: string; clientSecret: string };
  /** Simulates the buyer clicking through the approval link. */
  approve(orderId: string): Promise<void>;
  close(): Promise<void>;
}

/** Placeholder credentials the mock accepts. They are not PayPal credentials. */
export const MOCK_CREDENTIALS = { clientId: "mock-client-id", clientSecret: "mock-client-secret" };

export async function startMockPayPal(): Promise<MockPayPal> {
  const orders = new Map<string, MockOrder>();
  const tokens = new Set<string>();
  let baseUrl = "";

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const raw = Buffer.concat(chunks).toString("utf8");

      // Buyer approval page (simulated).
      if (req.method === "GET" && url.pathname === "/mock/checkoutnow") {
        const entry = orders.get(url.searchParams.get("token") ?? "");
        if (!entry) return send(404, { name: "RESOURCE_NOT_FOUND" });
        entry.buyerApproval = true;
        // Real PayPal moves the order to APPROVED once the buyer approves it.
        if (entry.order.status === "CREATED") entry.order.status = "APPROVED";
        return send(200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/v1/oauth2/token") {
        const expected = Buffer.from(`${MOCK_CREDENTIALS.clientId}:${MOCK_CREDENTIALS.clientSecret}`).toString("base64");
        if (req.headers.authorization !== `Basic ${expected}`) return send(401, { error: "invalid_client" });
        const token = `mock_${randomBytes(8).toString("hex")}`;
        tokens.add(token);
        return send(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
      }

      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!tokens.has(bearer)) return send(401, { name: "AUTHENTICATION_FAILURE" });

      if (req.method === "POST" && url.pathname === "/v2/checkout/orders") {
        const input = JSON.parse(raw || "{}") as { intent?: string; purchase_units?: Order["purchase_units"] };
        if (input.intent !== "CAPTURE" || !input.purchase_units?.length) {
          return send(422, { name: "UNPROCESSABLE_ENTITY" });
        }
        const id = randomBytes(8).toString("hex").toUpperCase();
        const order: Order = {
          id,
          status: "CREATED",
          intent: "CAPTURE",
          purchase_units: input.purchase_units.map((u) => ({ ...u, amount: { ...u.amount } })),
          links: [
            { href: `${baseUrl}/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
            { href: `${baseUrl}/mock/checkoutnow?token=${id}`, rel: "approve", method: "GET" },
            { href: `${baseUrl}/v2/checkout/orders/${id}/capture`, rel: "capture", method: "POST" },
          ],
        };
        orders.set(id, { order, buyerApproval: false });
        return send(201, order);
      }

      const m = url.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9-]+)(\/capture)?$/);
      if (m) {
        const entry = orders.get(m[1]);
        if (!entry) return send(404, { name: "RESOURCE_NOT_FOUND" });
        if (req.method === "GET" && !m[2]) return send(200, entry.order);
        if (req.method === "POST" && m[2]) {
          if (entry.order.status === "COMPLETED") return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
          if (!entry.buyerApproval) return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYER_ACTION_REQUIRED" }] });
          entry.order.status = "COMPLETED";
          for (const unit of entry.order.purchase_units) {
            unit.payments = {
              captures: [
                {
                  id: `CAP-${randomBytes(6).toString("hex").toUpperCase()}`,
                  status: "COMPLETED",
                  amount: { ...unit.amount },
                  custom_id: unit.custom_id,
                },
              ],
            };
          }
          return send(201, entry.order);
        }
      }
      return send(404, { name: "RESOURCE_NOT_FOUND" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    credentials: MOCK_CREDENTIALS,
    async approve(orderId: string) {
      const res = await fetch(`${baseUrl}/mock/checkoutnow?token=${encodeURIComponent(orderId)}`);
      if (!res.ok) throw new Error(`mock approval failed for ${orderId}`);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
