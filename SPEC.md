# MinuteGate HTTP 402 payment flow (spec 0.1, draft)

This document describes the payment-request flow implemented by the code in this
repository. Payments run against the PayPal sandbox only; no real money moves.

## Roles

- **Server**: hosts a resource and charges for access to it.
- **Client**: requests the resource and pays through PayPal (sandbox).
- **PayPal**: the PayPal Orders v2 API at `https://api-m.sandbox.paypal.com`.

## 1. Payment required

A client requests a resource with no proof. The server answers `402 Payment Required`
with a JSON body:

```json
{
  "minutegate": "0.1",
  "amount": "1.00",
  "currency": "USD",
  "rate": { "unit": "session", "price": "1.00", "quantity": 1 },
  "reference": "mg_3q9X1kQp0bW7cT2s",
  "expiresAt": "2026-11-02T12:30:00.000Z",
  "methods": ["paypal-sandbox"],
  "proofHeader": "minutegate-payment"
}
```

| Field | Meaning |
| --- | --- |
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
minutegate-payment: reference=mg_3q9X1kQp0bW7cT2s; order=5O190127TN364715T
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
