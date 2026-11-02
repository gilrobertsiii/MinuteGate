# MinuteGate

MinuteGate is an open protocol we're publishing under Apache-2.0. Payments run in sandbox
only for this demo.

This repository contains:

- [SPEC.md](SPEC.md): the MinuteGate HTTP 402 payment flow (draft 0.1).
- `src/`: a TypeScript PayPal sandbox client, an example 402 server, and an in-process PayPal
  mock.
- `examples/`: the quickstart and a two-terminal sandbox client and server.
- `test/`: end-to-end tests in mock mode.

## Quickstart

Requires Node.js 20 or newer.

```bash
git clone https://github.com/gilrobertsiii/MinuteGate.git
cd MinuteGate
npm install
npm run quickstart:mock     # full flow, no credentials
npm test                    # mock-mode tests
```

To run against the PayPal sandbox with your own sandbox app credentials, see
[QUICKSTART.md](QUICKSTART.md).

Payments shown are PayPal sandbox only; no real money moves. PayPal and Venmo are trademarks
of PayPal, Inc. Not affiliated with or endorsed by PayPal.

## License

Copyright 2026 Gil Roberts.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The code has no runtime third-party dependencies. Development-only dependencies
(`typescript`, `@types/node`) are installed by `npm install` and are not included in this
repository.
