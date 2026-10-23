---
name: Payments — ShamCash and USDT (BEP-20)
description: How a student pays for a plan, how each payment is verified, and what has to be configured before either method works.
---

# Payments

Two methods, verified in two different ways.

| | ShamCash | USDT (BEP-20) |
|---|---|---|
| Student does | Scans a QR, pays, uploads a receipt | Sends USDT, pastes the transaction hash |
| Verified by | **An admin reading the receipt** | **The blockchain, automatically** |
| Needs configuring | A QR uploaded in the admin UI | Env variables (below) |
| Typical wait | However long until an admin looks | Under a minute |

Both end in the same place: one `payment_submissions` row, and one activation
transaction. Crypto falls back to the admin queue whenever its automatic check
cannot decide.

---

## Before either method works

### ShamCash — upload the QR

Nothing to deploy. An admin opens the payment settings and uploads the ShamCash
receive QR, plus the account name, account number and any Arabic instructions.
Until a QR exists the payment page tells students the method is unavailable
rather than showing them an empty box.

### USDT — set the environment variables

All of these are already in [`.env.example`](../../.env.example) with the
reasoning beside each one. Two matter:

```
CRYPTO_PAYMENTS_ENABLED=true
BSC_USDT_WALLET_ADDRESS=0x…        ← the BEP-20 deposit address
```

The rest have working defaults: BNB Chain's public RPC (no API key), 15
confirmations, 2% amount tolerance, 7-day maximum transaction age.

**The address must be a BNB Smart Chain (BEP-20) deposit address** — `0x` plus
40 hex characters. The server checks the format at boot and **refuses to
start** if it is missing or malformed while crypto is enabled. That is
deliberate: a wrong address would otherwise fail every comparison silently and
reject legitimate payments one student at a time.

Leaving `CRYPTO_PAYMENTS_ENABLED=false` (the default) is a valid way to ship —
nothing below it is read and the payment page offers ShamCash only.

### Migrations

`021`, `022` and `023` must be run. **They have never been executed against a
database** — they were written and reviewed without a `DATABASE_URL` available.
Run them somewhere disposable first.

---

## Why the wallet address is env and the QR is not

These look like the same kind of setting and are not, and the difference is the
only reason the crypto path can be trusted.

**The QR is admin-editable** because a person reads every ShamCash receipt
before anything activates. If someone swapped the QR, receipts would start
arriving that name an unfamiliar account, and the admin reviewing them would
notice. The review is the control. QR images also get reissued far more often
than deploys happen.

**The wallet address is deploy-only** because nothing reviews a crypto payment.
An attacker who could change it from the admin UI would have every subsequent
payment verified into their own wallet — and the system would report success
every time, because those transfers really did arrive at the configured
address. Nothing would look broken until reconciliation, days later, with the
money gone.

The admin UI may *display* the address so staff can confirm what students see.
Nothing writes it.

---

## What the crypto check actually verifies

Four conditions, each guarding a specific way this goes wrong:

1. **The token contract**, checked on every transfer. Anyone can deploy a token
   on BSC named "USDT" with Tether's logo. Checking only that "2.00 USDT
   arrived" would sell a subscription for a worthless lookalike. The contract
   address is the only reliable identity:
   `0x55d398326f99059ff775485246999027b3197955`.
2. **The recipient**, read from the Transfer event's log topics — *not* from
   `tx.to`, which for a token transfer is the token contract rather than our
   wallet. Checking `tx.to` would reject every legitimate payment.
3. **Confirmations** (15 by default). A successful transaction is not a final
   one: BSC reorganises, and a transfer undone after activation is a
   subscription nobody paid for.
4. **The amount**, in base units at **18 decimals**. TRC-20 and ERC-20 USDT use
   six. Reading a BEP-20 amount with six misreads $2.00 by a factor of a
   trillion.

Amounts are `BigInt` throughout — 10^18 alone exceeds
`Number.MAX_SAFE_INTEGER`, so anything routed through a float loses the low
digits of every transfer.

**One transaction hash buys exactly one subscription**, enforced by a unique
index in the database rather than by a check in application code. Without it a
student pays once and shares the hash, and the on-chain check would confirm it
every time — because the transaction really is real.

### Nothing is auto-rejected

A student who mistyped a hash and one whose transaction is three blocks short
look the same to the verifier. Only one deserves a refusal, so anything
inconclusive goes to the admin queue with a log of what was found. An RPC
outage is recorded as an outage, never as a bad payment.

---

## Open item: sanctions screening

**Not implemented. Needs a decision, not code.**

Crypto is public and pseudonymous, so anyone can send you money without any
prior relationship. Some wallet addresses are sanctioned — the US Treasury
publishes a list (the "SDN list") that now includes specific crypto wallets,
and receiving from one is a legal problem for the recipient whether or not they
knew. ShamCash does not have this exposure in the same way: transfers there run
through a wallet operator who checks its own customers.

This is live enforcement, not theory. OFAC lifted the blanket Syria sanctions
in August 2025, but 139 entities remain designated, and in June 2026 OFAC
sanctioned 131 TRON wallets with Tether freezing them the same day.

**What exists:** every verified crypto payment records its `sender_address`, so
the record is there and screening can be added without a migration.

**What does not:** nothing checks that address against anything.

**Why it was left:** screening means choosing which list, how often it is
checked, what happens on a match (block? activate and flag? freeze?), and what
is retained and for how long. Those are legal and policy decisions.

The legal position on accepting USDT was cleared on 2026-10-23. Worth
confirming with whoever gave that clearance whether it covered screening
obligations specifically, or only the general question of accepting USDT. If
screening is wanted, it is a list lookup against `sender_address` before
activation — roughly a day.

---

## Also deferred

**Refunds.** No path, by decision. Later cost is about 2–3 days, and the things
that keep it cheap are already in place: payment submissions are never
hard-deleted, the plan price is snapshotted at submission, and activation lives
in one atomic function that a refund can invert. Note the money movement is
manual under both methods anyway — a ShamCash refund is an admin transferring
back by hand, a crypto refund is sending USDT from the wallet — so refunds are
bookkeeping plus an admin action, not an integration.

**A test transaction.** Send a small amount of USDT (BEP-20) to the configured
wallet and keep the hash. It is the first real fixture for the verifier, and
beats a mock for confirming the whole path end to end.

---

## Where things live

| | |
|---|---|
| Access rules (track, free lesson) | `services/entitlement-policy.ts` |
| Plan lookup | `services/entitlements.ts` |
| Activation, rejection, expiry | `services/subscription-activation.ts` |
| Crypto config and boot validation | `services/crypto-config.ts` |
| On-chain rules | `services/crypto-verify-policy.ts` |
| RPC and the verification job | `services/crypto-verify.ts` |
| ShamCash settings | `services/payment-settings.ts` |
| Admin review queue | `routes/admin-payments.ts` |
| Student endpoints | `routes/subscriptions.ts` |

The `*-policy.ts` modules hold the rules with no database import, so the
decisions that let a payment buy a subscription are covered by tests that run
anywhere rather than needing a live database and a real transaction.
