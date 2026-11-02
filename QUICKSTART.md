# MinuteGate quickstart

Two ways to run MinuteGate:

- **Mock mode** (start here, and the QA path): the full 402 flow end to end against an
  in-process PayPal mock. No PayPal account, no credentials, no network calls to PayPal.
- **PayPal sandbox mode**: the same code against `https://api-m.sandbox.paypal.com`, using
  your own PayPal sandbox app credentials.

Payments shown are PayPal sandbox only; no real money moves.

## Requirements

- Node.js 20 or newer (`node --version`)
- git

## 1. Install

```bash
git clone https://github.com/gilrobertsiii/MinuteGate.git
cd MinuteGate
npm install
```

`npm install` adds two development-only packages (`typescript`, `@types/node`). The code has
no runtime dependencies.

## 2. Mock mode (no credentials)

```bash
npm run quickstart:mock
```

Expected output (ids and times will differ):

```
MinuteGate quickstart (MOCK mode, no credentials)
1. GET http://127.0.0.1:<port>/resource
   -> 402 Payment Required: 1.00 USD per session, reference mg_..., expires ...
2. Create PayPal order
   -> order <id> (CREATED)
3. Buyer approval (simulated by the mock)
4. Capture and retry with proof header
   -> 200, receipt (capture id) CAP-...
5. Tamper check: pay 0.01 against a fresh reference and retry
   -> 402, error amount_mismatch
Mock quickstart finished: 1 accepted payment, 1 rejected tamper attempt.
```

Run the tests (also mock mode):

```bash
npm test
```

The tests cover the accepted path and the rejections: wrong amount, wrong currency, wrong
reference, order reuse, approval with no capture, a made-up order id, an unknown or expired
reference, and a malformed proof header.

## 3. PayPal sandbox mode

You need your own PayPal sandbox app (developer.paypal.com, Apps & Credentials, Sandbox) and,
for the capture step, a PayPal sandbox buyer account. Credentials are read from your
environment only; never commit them.

```bash
cp .env.example .env        # fill in PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET
set -a; . ./.env; set +a    # load them into this shell
```

`.env` and every other `.env*` file except `.env.example` are gitignored.

### Sandbox: up to the approval step

```bash
npm run quickstart:sandbox
```

This requests the resource, gets the 402, creates a PayPal sandbox order, prints the approval
link, and stops. It does not capture: the capture needs a sandbox buyer to approve the order
first, using your own sandbox credentials.

### Sandbox: full flow (two terminals)

Terminal 1, the example server (keeps its references in memory while it runs):

```bash
npm run sandbox:server
```

Terminal 2, the client:

```bash
npm run sandbox:client
```

It prints the approval link and a follow-up command. Open the link, log in as your PayPal
sandbox buyer and approve. Then run the printed command:

```bash
npm run sandbox:client -- --reference mg_... --order <order id>
```

The client captures the order and retries with the proof header. The server looks the order
up with PayPal and answers `200` with the capture id in `minutegate-receipt`, or `402` with
an error code (see [SPEC.md](SPEC.md)).

## Troubleshooting

- `PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set`: load your `.env` (step 3) or use
  mock mode.
- `PayPal token request failed (401)`: the credentials are not sandbox app credentials, or
  have a typo.
- `PayPal POST .../capture failed (422)`: no sandbox buyer has given approval for the order
  yet.
- `reference_expired`: references last 15 minutes; start again from `npm run sandbox:client`.

PayPal and Venmo are trademarks of PayPal, Inc. Not affiliated with or endorsed by PayPal.
