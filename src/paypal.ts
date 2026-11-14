// Minimal PayPal Orders v2 client for the PayPal SANDBOX only.
// Uses the global fetch in Node 20+. No third-party dependencies.

export const PAYPAL_SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Defaults to the PayPal sandbox. The only other accepted value is a
   * loopback URL (127.0.0.1 / localhost), used by the in-repo mock.
   */
  baseUrl?: string;
  /** Per-request timeout for calls to PayPal, in ms. Default 10000. */
  timeoutMs?: number;
}

/** Default timeout for outbound PayPal requests. */
export const DEFAULT_PAYPAL_TIMEOUT_MS = 10_000;

export interface Money {
  currency_code: string;
  value: string;
}

export interface Capture {
  id: string;
  status: string;
  amount: Money;
  custom_id?: string;
}

export interface PurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  description?: string;
  amount: Money;
  payments?: { captures?: Capture[] };
}

export interface Order {
  id: string;
  status: string;
  intent?: string;
  purchase_units: PurchaseUnit[];
  links?: { href: string; rel: string; method?: string }[];
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

function checkBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (baseUrl.replace(/\/$/, "") === PAYPAL_SANDBOX_BASE) return PAYPAL_SANDBOX_BASE;
  if (loopback && url.protocol === "http:") return url.origin;
  throw new Error(
    `MinuteGate only talks to the PayPal sandbox (${PAYPAL_SANDBOX_BASE}) or a local mock; refusing ${baseUrl}`,
  );
}

/** Reads PayPal sandbox credentials from the process environment. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    throw new Error(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in your environment for sandbox mode " +
        "(or set MINUTEGATE_MOCK=1 to run with no credentials).",
    );
  }
  return { clientId, clientSecret };
}

export class PayPalSandboxClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  // One token request at a time: concurrent callers after expiry share it.
  private tokenInFlight: Promise<string> | null = null;

  constructor(private readonly config: PayPalConfig) {
    this.baseUrl = checkBaseUrl(config.baseUrl ?? PAYPAL_SANDBOX_BASE);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_PAYPAL_TIMEOUT_MS;
  }

  /** fetch with a timeout; a timeout surfaces as PayPalError with status 0. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new PayPalError(`PayPal request timed out after ${this.timeoutMs} ms`, 0, null);
      }
      throw err;
    }
  }

  private accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return Promise.resolve(this.token.value);
    if (!this.tokenInFlight) {
      this.tokenInFlight = this.fetchToken().finally(() => {
        this.tokenInFlight = null;
      });
    }
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await this.send(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      throw new PayPalError(`PayPal token request failed (${res.status})`, res.status, body);
    }
    const ttl = Math.max(0, (body.expires_in ?? 300) - 60) * 1000;
    this.token = { value: body.access_token, expiresAt: Date.now() + ttl };
    return body.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await this.send(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) throw new PayPalError(`PayPal ${method} ${path} failed (${res.status})`, res.status, data);
    return data as T;
  }

  /** Creates a CAPTURE-intent order tagged with the MinuteGate reference. */
  createOrder(input: { amount: string; currency: string; reference: string; description?: string }): Promise<Order> {
    return this.call<Order>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.reference,
            custom_id: input.reference,
            description: input.description ?? "MinuteGate sandbox payment",
            amount: { currency_code: input.currency, value: input.amount },
          },
        ],
      },
      { "paypal-request-id": `create-${input.reference}` },
    );
  }

  /** Captures an order once the buyer has given approval. */
  captureOrder(orderId: string): Promise<Order> {
    return this.call<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, {
      "paypal-request-id": `capture-${orderId}`,
    });
  }

  /** Looks up an order by id (server side). */
  getOrder(orderId: string): Promise<Order> {
    return this.call<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }
}

/** Returns the buyer approval link from a created order. */
export function approvalLink(order: Order): string | undefined {
  return order.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href;
}
