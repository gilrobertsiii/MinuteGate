// MinuteGate sandbox client: request -> 402 -> PayPal sandbox order ->
// buyer approval -> capture -> retry with proof header.

import { PROOF_HEADER, RECEIPT_HEADER, formatProof, type PaymentRequired } from "./protocol.js";
import { approvalLink, type Order, type PayPalSandboxClient } from "./paypal.js";

export interface PendingPayment {
  url: string;
  required: PaymentRequired;
  order: Order;
  approveUrl: string;
}

export interface FetchResult {
  status: number;
  body: unknown;
  receipt: string | null;
}

/** Default timeout for requests to the gated resource. */
export const DEFAULT_RESOURCE_TIMEOUT_MS = 15_000;

export interface RequestOptions {
  /** Timeout for the request to the gated resource, in ms. Default 15000. */
  timeoutMs?: number;
}

/** Step 1: request the resource. Returns the 402 body, or null if not gated. */
export async function requestResource(
  url: string,
  opts: RequestOptions = {},
): Promise<{ status: number; required: PaymentRequired | null; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS) });
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.status !== 402) return { status: res.status, required: null, body };
  return { status: 402, required: body as PaymentRequired, body };
}

/** Step 2: create a PayPal sandbox order for the 402 body; returns the approval link. */
export async function startPayment(paypal: PayPalSandboxClient, url: string, required: PaymentRequired): Promise<PendingPayment> {
  if (!required.methods?.includes("paypal-sandbox")) throw new Error("server does not accept paypal-sandbox");
  if (Date.parse(required.expiresAt) <= Date.now()) throw new Error("payment reference already expired");
  const order = await paypal.createOrder({
    amount: required.amount,
    currency: required.currency,
    reference: required.reference,
  });
  const approveUrl = approvalLink(order);
  if (!approveUrl) throw new Error(`PayPal order ${order.id} has no approval link`);
  return { url, required, order, approveUrl };
}

/** Step 3 (after the buyer approves): capture the order and retry with proof. */
export async function finishPayment(
  paypal: PayPalSandboxClient,
  url: string,
  reference: string,
  orderId: string,
  opts: RequestOptions = {},
): Promise<FetchResult> {
  await paypal.captureOrder(orderId);
  return retryWithProof(url, reference, orderId, opts);
}

/** Retries the resource with the proof header. */
export async function retryWithProof(
  url: string,
  reference: string,
  orderId: string,
  opts: RequestOptions = {},
): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { [PROOF_HEADER]: formatProof({ reference, orderId }) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_RESOURCE_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, body, receipt: res.headers.get(RECEIPT_HEADER) };
}
