# MinuteGate HTTP 402 payment flow (spec 0.1, draft)

This document describes the payment-request flow implemented by the code in this
repository. Payments run against the PayPal sandbox only; no real money moves.

## Roles

- **Server**: hosts a resource and charges for access to it.
- **Client**: requests the resource and pays through PayPal (sandbox).
- **PayPal**: the PayPal Orders v2 API at the sandbox endpoint.

## 1. Payment required

A client requests a resource with no proof. The server answers `402 Payment Required`
with a JSON body:

```json
{
  "minutegate": "0.1",
  "amount": "1.00",
  "currency": "USD",
  "rate": { "unit": "session", "price": "1.00", "quantity": 1 },
  "reference": "mg_EXAMPLE123456789",
  "expiresAt": "2026-11-02T12:30:00.000Z",
  "methods": ["paypal-sandbox"],
  "proofHeader": "minutegate-payment",
  "description": "MinuteGate example resource (PayPal sandbox only)"
}
```

| Field | Meaning |
| --- | --- |
| `minutegate` | Protocol version, currently `0.1`. |
| `description` | Optional text; the example server always includes the sandbox resource description. |
| `amount` | Total to pay, decimal string with two places. |
| `currency` | ISO 4217 code. |
| `rate` | How the amount was priced: `unit` is `session` or `minute`, `price` is per unit, `quantity` is the number of units covered. `amount` = `price` x `quantity`. Per-minute figures in examples are illustrative. |
| `reference` | Single-use payment reference issued and stored by the server. |
| `expiresAt` | After this time the server no longer accepts the reference. |
| `methods` | Accepted payment methods. Spec 0.1 defines only `paypal-sandbox`. |
| `proofHeader` | Header name the client retries with. |
| `error` | Present only on a rejected retry (see section 4). |

The server keeps a record of each reference it issues: amount, currency, rate, expiry and
whether it has been used.

## 2. Client pays through PayPal (sandbox)

1. **Create order**: `POST /v2/checkout/orders` with `intent: "CAPTURE"` and one purchase
   unit whose `amount` is the `amount` and `currency` from the 402 body and whose
   `custom_id` (and `reference_id`) is the MinuteGate `reference`.
2. **Approve**: the buyer opens the order's `approve` link and approves the payment as a
   PayPal sandbox buyer.
3. **Capture**: `POST /v2/checkout/orders/{id}/capture`.

In this sandbox demo the client and the example server use the same PayPal sandbox app
credentials, so the order is created on the server's own merchant account. Separating the
payer side from the merchant side is planned for a later version.

## 3. Retry with proof

The client repeats the original request with the proof header:

```
minutegate-payment: reference=mg_EXAMPLE123456789; order=EXAMPLE-ORDER-001
```

## 4. Server-side check

The order id in the header is a lookup key only. The server never grants access because a
client says an order exists or was captured. For each retry the server:

1. Parses the header; rejects malformed values (`malformed_proof`).
2. Looks up the reference in its own records; rejects unknown (`unknown_reference`), already
   used (`reference_used`) or expired (`reference_expired`) references.
3. Rejects an order id that already unlocked a resource (`order_reused`).
4. Fetches the order from PayPal with its own credentials:
   `GET /v2/checkout/orders/{id}`. An order PayPal does not return is rejected
   (`order_not_found`); a PayPal outage gives `paypal_unavailable`.
5. Requires exactly one purchase unit whose `custom_id` equals the reference in the header
   (`reference_mismatch`).
6. Requires order status `COMPLETED` with a capture in status `COMPLETED` (`not_captured`).
7. Requires the purchase unit amount and the capture amount to equal the issued currency
   (`currency_mismatch`) and amount (`amount_mismatch`).
8. On success, marks the reference and the order id as used and answers `200` with the
   resource. The PayPal capture id is returned in the `minutegate-receipt` header.

A rejected retry gets a new `402` body with a fresh reference and an `error` code from the
list above.

## 5. Scope of 0.1

In this repository: the flow above, a TypeScript PayPal sandbox client, an example server, an
in-process PayPal mock for running without credentials, and tests.

Not in 0.1: non-sandbox PayPal endpoints, webhooks, refunds, persistent storage of
references, and any other payment method. In 0.1 the client pays before access, for the
amount in the 402 body. Charging once when the session ends is planned for a later version.
The example server keeps references in memory, so they reset when it restarts.

## Wire examples and parser behavior

All identifiers below are placeholders. Requests to the resource are GET requests;
other methods or paths receive JSON `404` with `{"error":"not_found"}`.
Every response from the example server has `content-type: application/json`.
Unexpected server exceptions receive `500` with `{"error":"internal_error"}`.

### Request the resource

```http
GET /resource HTTP/1.1
Host: localhost:3000
```

The response is `HTTP/1.1 402 Payment Required`, with the JSON body in section 1.
The reference lifetime defaults to 900 seconds. Each response issues a new reference.
`requestResource` casts the JSON to `PaymentRequired`; it does not validate the shape
at runtime. A non-402 response returns `required: null`.

### Create the sandbox order

Against the sandbox provider, the request body is:

```http
POST /v2/checkout/orders HTTP/1.1
Content-Type: application/json
PayPal-Request-Id: create-mg_EXAMPLE123456789

{"intent":"CAPTURE","purchase_units":[{"reference_id":"mg_EXAMPLE123456789","custom_id":"mg_EXAMPLE123456789","description":"MinuteGate sandbox payment","amount":{"currency_code":"USD","value":"1.00"}}]}
```

An illustrative provider response (unrelated fields omitted) is:

```http
HTTP/1.1 201 Created
Content-Type: application/json

{"id":"EXAMPLE-ORDER-001","status":"CREATED","links":[{"rel":"approve","href":"https://example.com/sandbox-checkout","method":"GET"}]}
```

The example.com address illustrates the returned link only. It is not a sandbox
endpoint. Provider authentication headers are omitted. `startPayment` checks that
`methods` includes `paypal-sandbox`, rejects expiry at or before the client clock,
creates the order, and returns its first `approve` or `payer-action` link.
The buyer opens that link and confirms in the provider's sandbox UI. This interactive
step has no MinuteGate HTTP response contract.

### Capture, then retry

After buyer confirmation, `finishPayment` makes this provider request before retrying:

```http
POST /v2/checkout/orders/EXAMPLE-ORDER-001/capture HTTP/1.1
Content-Type: application/json
PayPal-Request-Id: capture-EXAMPLE-ORDER-001

{}
```

Illustrative provider response, with unrelated fields omitted:

```http
HTTP/1.1 201 Created
Content-Type: application/json

{"id":"EXAMPLE-ORDER-001","status":"COMPLETED","purchase_units":[{"custom_id":"mg_EXAMPLE123456789","amount":{"currency_code":"USD","value":"1.00"},"payments":{"captures":[{"id":"EXAMPLE-CAPTURE-001","status":"COMPLETED","amount":{"currency_code":"USD","value":"1.00"}}]}}]}
```

```http
GET /resource HTTP/1.1
Host: localhost:3000
minutegate-payment: reference=mg_EXAMPLE123456789; order=EXAMPLE-ORDER-001
```

After an independent provider lookup and successful checks:

```http
HTTP/1.1 200 OK
Content-Type: application/json
minutegate-receipt: EXAMPLE-CAPTURE-001

{"message":"Access granted to the MinuteGate example resource.","reference":"mg_EXAMPLE123456789"}
```

`retryWithProof` returns the status, decoded body (null on JSON parse failure), and
receipt header (null when absent). It does not automatically pay for a new reference.
A rejected retry gets the full section 1 body with a fresh reference and the applicable
`error`, without a receipt header. The server rejects expiry strictly after the
stored timestamp; the client rejects at the timestamp too.

### Proof grammar as implemented

`formatProof` emits `reference=<reference>; order=<orderId>` without validation.
`parseProof` rejects absent/empty values, values longer than 256 characters, any
semicolon-separated piece without `=`, missing required fields, and invalid identifiers.
Reference syntax is `mg_` plus 8–64 ASCII letters, digits, underscores or hyphens.
Order syntax is 1–64 uppercase ASCII letters, digits or hyphens. Values are unquoted.
Keys are case-sensitive; keys and values are trimmed. Field order is flexible.
Extra fields containing `=` are ignored, and the last duplicate key wins. A trailing
semicolon is rejected. These are current parser behaviors, not stronger validation
promises. Strict duplicate/unknown-field rejection is not implemented.

An in-flight check also reserves its reference: a concurrent retry receives
`reference_used`. The reservation is cleared after the check, including a failed lookup.
Reference/order tracking is process-local, not shared across replicas. The server
compares decimal amount strings exactly, so `1.0` does not match `1.00`.
