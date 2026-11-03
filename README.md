# Stratus · A C2 Framework That Runs Entirely on Cloudflare's Free Tier

[![ci](https://github.com/only9464/stratus-c2/actions/workflows/ci.yml/badge.svg)](https://github.com/only9464/stratus-c2/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020)

> A command-and-control framework with **no server of your own**: two Workers, one Durable Object per
> session, and D1 / KV / R2 / Cron — all on a single Cloudflare account's free plan.
>
> **For authorized red-team engagements, penetration testing and security research only.**
> Unauthorized use is illegal. The authors take no responsibility for abuse.

**[简体中文](./README.zh-CN.md)** | English

---

## Why this exists

A classical C2 needs a VPS: something to buy, register, and get taken down. Cloudflare Workers can't
listen on TCP/UDP, can't reach private IP addresses, and give you 10 ms of CPU per request — so
"port VShell to Workers" is not a thing that works. Stratus is a redesign around those constraints:

| Constraint | Consequence |
|---|---|
| No inbound TCP/UDP | implants can only **dial out** over HTTPS/WSS |
| `connect()` blocks private IPs | the Worker can never touch a target's intranet — pivoting lives on the implant |
| 10 ms CPU / 100k req/day | no polling heartbeats; **WS + DO hibernation** is the load-bearing channel |
| KV allows 1,000 writes/day | KV is for one-shot tokens and config only, never a queue |
| No long-running process | one **Durable Object per session**, driven by events and alarms |

The result: idle sessions cost ~0, 100 concurrent implants consume a few thousand DO requests a day,
and Cloudflare never sees plaintext.

## What works today

| Area | Status |
|---|---|
| Edge worker: register / WS / HTTP beacon / file chunks / payload drop / decoy | ✅ implemented |
| Console worker: sessions, tasks, results, payloads, keys, audit, stats, quota | ✅ implemented (Hono + Drizzle) |
| `SessionDO`: hibernation, queue, replay window, result persistence, alarm cleanup | ✅ implemented |
| `HubDO`: register-nonce dedupe, presence index, operator fan-out | ✅ implemented |
| End-to-end crypto (P-256 ECDH + HKDF-SHA256 + AES-256-GCM), browser-side encryption | ✅ implemented, 18 unit tests |
| D1 schema + migrations (Drizzle ORM) | ✅ generated in `db/migrations` |
| Console UI (Vue 3 + shadcn-style components + Element Plus) | ✅ usable |
| Reference implant (Go, standard library only, HTTP beacon) | ✅ builds and connects |
| WS transport in the reference implant | 🟡 protocol + DO side done, client pending |
| PTY / screen streaming / input | 🟡 frames reserved, not implemented |
| SOCKS5 pivot | 🟡 designed (implant-side proxy + local operator client) |
| DNS/DoH fallback | 🟡 designed, needs a scoped CF DNS token |

## Architecture

```
implant (any language) ──HTTPS/WSS──▶ stc2-edge ──▶ SessionDO (one per session)
                                                       │  ciphertext relayed verbatim
operator (browser) ──────HTTPS/WSS──▶ stc2-console ───┘
                                          ├── D1   ledger (sessions/tasks/results/audit)
                                          ├── KV   one-shot tokens + config
                                          ├── R2   payloads / file chunks / large results
                                          └── Cron retention + quota report
```

## Quick start

```bash
pnpm i && pnpm build

wrangler d1 create stc2-core
wrangler kv namespace create TOKENS
wrangler kv namespace create CONFIG
wrangler r2 bucket create stc2

wrangler d1 migrations apply stc2-core --remote
wrangler secret put ADMIN_TOKEN -c workers/console/wrangler.jsonc

pnpm deploy:edge && pnpm deploy:console     # edge first: it defines the DO classes
```

Then open `https://ops.example.com`, generate an operator key, create a payload, and build the
reference implant:

```bash
cd clients/go
go build -ldflags "-X main.cfgEndpoint=https://c2.example.com -X main.cfgPskId=... -X main.cfgPsk=... -X main.cfgOpPub=... -X main.cfgOpFp=..." -o beacon .
```

Full walkthrough: [deployment guide](docs/06-operations/01-deployment.md).

## Documentation

Start with [docs/01-research/01-cloudflare-platform-limits.md](docs/01-research/01-cloudflare-platform-limits.md)
(every number sourced), then [docs/02-architecture/01-system-architecture.md](docs/02-architecture/01-system-architecture.md).

The protocol is specified twice: for operators ([docs/03-protocol](docs/03-protocol/01-envelope.md)) and
for implant authors ([docs/04-client/01-implant-spec.md](docs/04-client/01-implant-spec.md), language-agnostic,
with a per-language crypto cheat sheet).

## Security model

1. **Server-side zero knowledge** — tasks and results are encrypted with keys derived from an ECDH
   exchange between the operator's browser and the implant. Cloudflare sees `sid`, sequence numbers,
   sizes and timings.
2. **Keys never reach the server** — the operator's private key is a non-extractable `CryptoKey` in
   IndexedDB; the implant regenerates its ephemeral key on every start.
3. **Accepted trade-off** — lose the private key and historical results are unrecoverable; extract the
   payload's PSK and an attacker can register *new* sessions as that payload, but cannot decrypt past traffic.

## Platform red lines

- Do **not** turn these Workers into a generic proxy/VPN (Cloudflare's self-serve terms forbid it, and
  accounts do get flagged).
- Do **not** expect intranet scanning from the Worker — private addresses are blocked at the platform level.
- Do **not** poll at 30 s intervals on the free plan — 100 implants would need 288k requests/day against a
  100k limit.
- Tear everything down after an engagement ([cleanup](docs/06-operations/01-deployment.md#10-清理演练结束)).

## License

[MIT](./LICENSE). Design discussions were informed by the public write-ups of
[VShell](https://github.com/veo/vshell) (design ideas only — no code, protocol constants or frontend
assets were copied) and by two MIT-licensed projects, [Rshell](https://github.com/Rubby2001/Rshell---A-Cross-Platform-C2)
and [ToShell](https://github.com/iQingshan/Toshell). See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES.md).
