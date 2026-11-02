// MinuteGate protocol types and constants (spec version 0.1). See SPEC.md.

export const SPEC_VERSION = "0.1";

/** Header the client sends on the retry, carrying its payment proof. */
export const PROOF_HEADER = "minutegate-payment";

/** Header the server returns on success, carrying the PayPal capture id. */
export const RECEIPT_HEADER = "minutegate-receipt";

export type RateUnit = "session" | "minute";

export interface Rate {
  unit: RateUnit;
  /** Price per unit, decimal string, e.g. "1.00". */
  price: string;
  /** Number of units this payment covers (1 for a session). */
  quantity: number;
}

/** Body of an HTTP 402 response. */
export interface PaymentRequired {
  minutegate: string;
  /** Total to pay, decimal string with two places, e.g. "1.00". */
  amount: string;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  rate: Rate;
  /** Opaque, single-use payment reference issued by the server. */
  reference: string;
  /** ISO 8601 time after which the reference is no longer accepted. */
  expiresAt: string;
  /** Payment methods the server accepts. Only "paypal-sandbox" in 0.1. */
  methods: string[];
  /** Name of the header the client retries with. */
  proofHeader: string;
  /** Set when a retry was rejected; see SPEC.md for the codes. */
  error?: RejectionCode;
  description?: string;
}

export type RejectionCode =
  | "malformed_proof"
  | "unknown_reference"
  | "reference_expired"
  | "reference_used"
  | "order_not_found"
  | "order_reused"
  | "reference_mismatch"
  | "amount_mismatch"
  | "currency_mismatch"
  | "not_captured"
  | "paypal_unavailable";

export interface PaymentProof {
  reference: string;
  orderId: string;
}

const REF_RE = /^mg_[A-Za-z0-9_-]{8,64}$/;
const ORDER_RE = /^[A-Z0-9-]{1,64}$/;

/** Formats a proof header value: `reference=<ref>; order=<PayPal order id>`. */
export function formatProof(proof: PaymentProof): string {
  return `reference=${proof.reference}; order=${proof.orderId}`;
}

/** Parses a proof header value. Returns null when it is malformed. */
export function parseProof(value: string | undefined): PaymentProof | null {
  if (!value || value.length > 256) return null;
  const parts = new Map<string, string>();
  for (const piece of value.split(";")) {
    const idx = piece.indexOf("=");
    if (idx < 0) return null;
    parts.set(piece.slice(0, idx).trim(), piece.slice(idx + 1).trim());
  }
  const reference = parts.get("reference");
  const orderId = parts.get("order");
  if (!reference || !orderId) return null;
  if (!REF_RE.test(reference) || !ORDER_RE.test(orderId)) return null;
  return { reference, orderId };
}

/** Multiplies a decimal price string by a whole quantity, returning "N.NN". */
export function totalFor(price: string, quantity: number): string {
  const cents = toCents(price) * quantity;
  return fromCents(cents);
}

export function toCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error(`bad amount: ${value}`);
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function fromCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
