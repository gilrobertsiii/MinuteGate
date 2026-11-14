// Example MinuteGate server: answers 402 until a PayPal sandbox capture is
// looked up server side and matches the issued amount, currency and reference.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  PROOF_HEADER,
  RECEIPT_HEADER,
  SPEC_VERSION,
  parseProof,
  totalFor,
  type PaymentRequired,
  type Rate,
  type RejectionCode,
} from "./protocol.js";
import { PayPalError, type Order, type PayPalSandboxClient } from "./paypal.js";

export interface GateOptions {
  paypal: PayPalSandboxClient;
  rate?: Rate;
  currency?: string;
  /** How long an issued reference stays open, in seconds. Default 900. */
  ttlSeconds?: number;
  /**
   * How long an expired or used reference is remembered after it expires, in
   * seconds, so late retries still get `reference_expired` / `reference_used`
   * instead of `unknown_reference`. Default: the same as ttlSeconds.
   */
  retainSeconds?: number;
  /**
   * Upper bound on references held in memory. When reached, expired entries
   * are swept first, then the oldest entries that are not mid-check are
   * dropped (a dropped reference reads as `unknown_reference`). Default 10000.
   */
  maxReferences?: number;
  /** Minimum time between background sweeps of expired entries, in ms. Default 30000. */
  sweepIntervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

/** Sizes of the gate's in-memory stores, for monitoring and tests. */
export interface GateStats {
  references: number;
  usedOrders: number;
  pending: number;
}

interface Issued {
  amount: string;
  currency: string;
  rate: Rate;
  expiresAt: number;
  used: boolean;
}

export type CheckResult =
  | { ok: true; captureId: string; reference: string }
  | { ok: false; code: RejectionCode };

export class MinuteGate {
  private readonly issued = new Map<string, Issued>();
  // order id -> time (ms) after which it may be forgotten. An order id only ever
  // unlocks the reference in its custom_id, so once that reference is gone the
  // order is rejected anyway (unknown_reference / reference_mismatch).
  private readonly usedOrders = new Map<string, number>();
  // References whose check is in flight. Claimed synchronously before the first await so
  // concurrent requests with the same proof cannot both pass. Together with the
  // custom_id === reference check this means one order unlocks at most one reference,
  // so order ids are not claimed: a third party submitting someone else's order id
  // must not be able to block that order's owner while a lookup is in flight.
  private readonly pendingRefs = new Set<string>();
  private readonly rate: Rate;
  private readonly currency: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly retainMs: number;
  private readonly maxReferences: number;
  private readonly sweepIntervalMs: number;
  private lastSweep = -Infinity;

  constructor(private readonly opts: GateOptions) {
    this.rate = opts.rate ?? { unit: "session", price: "1.00", quantity: 1 };
    this.currency = opts.currency ?? "USD";
    this.ttlMs = (opts.ttlSeconds ?? 900) * 1000;
    this.retainMs = (opts.retainSeconds ?? opts.ttlSeconds ?? 900) * 1000;
    this.maxReferences = Math.max(1, Math.floor(opts.maxReferences ?? 10_000));
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /** Current sizes of the in-memory stores. */
  stats(): GateStats {
    return { references: this.issued.size, usedOrders: this.usedOrders.size, pending: this.pendingRefs.size };
  }

  /**
   * Drops references (and the order ids that used them) whose retention window
   * has passed. References with a check in flight are never dropped.
   */
  sweep(): void {
    const now = this.now();
    this.lastSweep = now;
    for (const [ref, entry] of this.issued) {
      if (now > entry.expiresAt + this.retainMs && !this.pendingRefs.has(ref)) this.issued.delete(ref);
    }
    for (const [orderId, forgetAt] of this.usedOrders) {
      if (now > forgetAt) this.usedOrders.delete(orderId);
    }
  }

  private maybeSweep(): void {
    if (this.now() - this.lastSweep >= this.sweepIntervalMs) this.sweep();
  }

  /** Makes room for one more reference, keeping the store at most maxReferences. */
  private makeRoom(): void {
    this.maybeSweep();
    if (this.issued.size < this.maxReferences) return;
    this.sweep();
    // Map iteration is insertion order, so this drops the oldest first.
    for (const ref of this.issued.keys()) {
      if (this.issued.size < this.maxReferences) break;
      if (!this.pendingRefs.has(ref)) this.issued.delete(ref);
    }
    while (this.usedOrders.size > this.maxReferences) {
      const oldest = this.usedOrders.keys().next();
      if (oldest.done) break;
      this.usedOrders.delete(oldest.value);
    }
  }

  /** Issues a new single-use reference and returns the 402 body. */
  paymentRequired(error?: RejectionCode): PaymentRequired {
    const reference = `mg_${randomBytes(12).toString("base64url")}`;
    const amount = totalFor(this.rate.price, this.rate.quantity);
    this.makeRoom();
    const expiresAt = this.now() + this.ttlMs;
    this.issued.set(reference, { amount, currency: this.currency, rate: this.rate, expiresAt, used: false });
    return {
      minutegate: SPEC_VERSION,
      amount,
      currency: this.currency,
      rate: this.rate,
      reference,
      expiresAt: new Date(expiresAt).toISOString(),
      methods: ["paypal-sandbox"],
      proofHeader: PROOF_HEADER,
      ...(error ? { error } : {}),
      description: "MinuteGate example resource (PayPal sandbox only)",
    };
  }

  /**
   * Checks a proof header. The order id from the client is only a lookup key:
   * the order is fetched from PayPal with the server's own credentials and its
   * capture must match the reference, amount and currency the server issued.
   */
  async check(headerValue: string | undefined): Promise<CheckResult> {
    this.maybeSweep();
    const proof = parseProof(headerValue);
    if (!proof) return { ok: false, code: "malformed_proof" };

    const issued = this.issued.get(proof.reference);
    if (!issued) return { ok: false, code: "unknown_reference" };
    if (issued.used) return { ok: false, code: "reference_used" };
    if (this.now() > issued.expiresAt) return { ok: false, code: "reference_expired" };
    if (this.usedOrders.has(proof.orderId)) return { ok: false, code: "order_reused" };
    if (this.pendingRefs.has(proof.reference)) return { ok: false, code: "reference_used" };

    this.pendingRefs.add(proof.reference);
    try {
      const result = await this.verifyOrder(proof, issued);
      if (result.ok) {
        issued.used = true;
        this.usedOrders.set(proof.orderId, issued.expiresAt + this.retainMs);
      }
      return result;
    } finally {
      this.pendingRefs.delete(proof.reference);
    }
  }

  private async verifyOrder(
    proof: { reference: string; orderId: string },
    issued: Issued,
  ): Promise<CheckResult> {
    let order: Order;
    try {
      order = await this.opts.paypal.getOrder(proof.orderId);
    } catch (err) {
      if (err instanceof PayPalError && (err.status === 404 || err.status === 400)) {
        return { ok: false, code: "order_not_found" };
      }
      return { ok: false, code: "paypal_unavailable" };
    }

    if (order.id !== proof.orderId) return { ok: false, code: "order_not_found" };
    const unit = order.purchase_units?.[0];
    if (!unit || order.purchase_units.length !== 1) return { ok: false, code: "reference_mismatch" };
    if (unit.custom_id !== proof.reference) return { ok: false, code: "reference_mismatch" };

    const capture = unit.payments?.captures?.find((c) => c.status === "COMPLETED");
    if (order.status !== "COMPLETED" || !capture) return { ok: false, code: "not_captured" };

    if (unit.amount.currency_code !== issued.currency || capture.amount.currency_code !== issued.currency) {
      return { ok: false, code: "currency_mismatch" };
    }
    if (unit.amount.value !== issued.amount || capture.amount.value !== issued.amount) {
      return { ok: false, code: "amount_mismatch" };
    }

    return { ok: true, captureId: capture.id, reference: proof.reference };
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body, null, 2));
}

/** Small HTTP server exposing one gated resource at GET /resource. */
export function createGateServer(gate: MinuteGate): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET" || url.pathname !== "/resource") {
        send(res, 404, { error: "not_found" });
        return;
      }
      const header = req.headers[PROOF_HEADER];
      if (header === undefined) {
        send(res, 402, gate.paymentRequired());
        return;
      }
      const result = await gate.check(Array.isArray(header) ? header[0] : header);
      if (!result.ok) {
        send(res, 402, gate.paymentRequired(result.code));
        return;
      }
      send(
        res,
        200,
        { message: "Access granted to the MinuteGate example resource.", reference: result.reference },
        { [RECEIPT_HEADER]: result.captureId },
      );
    } catch {
      send(res, 500, { error: "internal_error" });
    }
  });
}
