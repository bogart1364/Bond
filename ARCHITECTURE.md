# Bond — Architecture

One contract, one static frontend, no server. This document explains the
state machine, where custody actually sits, how fees are computed, and how the
frontend reconstructs state from logs.

---

## 1. Protocol overview

```
        payer                          contract                        payee / arbiter
          |                              |                                   |
          | createEscrow(payee, amount, deadline, desc, arbiter)             |
          |----------------------------->|  State: Created                   |
          |                              |                                   |
          | fund()  (USDC transferFrom)  |  State: Funded                    |
          |----------------------------->|  principal held by contract       |
          |                              |                                   |
          | confirm()                    |  State: Completed                 |
          |----------------------------->|  payee gets amount - fee          |
          |                              |  fee accrues to accruedFees       |
          |                              |                                   |
          | openDispute()  (either party)|  State: Disputed                  |
          |----------------------------->|                                   |
          |                              |  resolveDispute(payeeBps)         |
          |                              |<---------------------------------|  arbiter splits
          |                              |  Completed (or Refunded at 0 bps) |
          |                              |                                   |
          | cancel()  before funding     |  State: Cancelled                 |
          | claimTimeout() after deadline+48h -> State: Refunded             |
          |   (permissionless; disputed also waits out ARBITER_WINDOW)       |
```

Custody rule: **escrowed principal can only leave the contract along one of
the three paths above.** The owner can never move principal — only withdraw
already-accrued protocol fees (`accruedFees`), which are recorded at the
moment funds settle, never before.

## 2. State machine

`enum State { None, Created, Funded, Disputed, Completed, Cancelled, Refunded }`

Every mutating function pins the state it expects and reverts with
`InvalidState(expected, actual)` otherwise. That makes each entry point
auditable in isolation: the precondition is in the signature, not in the
caller's memory.

| Function | Required state | Who | Effect |
| --- | --- | --- | --- |
| `createEscrow` | — (new id) | anyone | writes `EscrowCreated`, `Created` |
| `createEscrowHandshaked` | — (new id) | anyone | as above, after verifying the payee + arbiter EIP-712 signatures |
| `fund` | `Created` | payer | pulls USDC, exact-amount check, `Funded` |
| `cancel` | `Created` | payer | `Cancelled`, nothing was locked |
| `confirm` | `Funded` | payer | pays payee, accrues fee, `Completed` |
| `openDispute` | `Funded` | payer or payee | `Disputed`, stamps `disputedAt` |
| `resolveDispute` | `Disputed` | arbiter | splits by `payeeBps`, `Completed` |
| `claimTimeout` | `Funded` or `Disputed` | **anyone** | after `deadline + 48h` (and, if disputed, after the arbiter window), refunds payer, `Refunded` |
| `withdrawPending` | credit > 0 | the credited account | pulls a share that could not be pushed, to any clean address |

Terminal states (`Completed`, `Cancelled`, `Refunded`) reject every further
write, so a settled escrow is immutable.

Two details worth stating plainly, because they are the safety-critical ones:

- `claimTimeout` is **permissionless and payout-fixed**. Anyone may call it
  after the window opens; the only outcome the contract permits is "everything
  back to the payer". A caller can neither profit from it nor redirect it, so
  making it public costs nothing and guarantees an abandoned link can never
  stay locked. A dispute that is still inside `ARBITER_WINDOW` reverts with
  `ArbiterWindowOpen(availableAt)` instead of letting the clock overrule the
  arbiter.
- `resolveDispute(payeeBps = 0)` lands in **`Refunded`**, not `Completed`: a
  total loss for the payee is a refund to the payer, and the state says so.

### Guards on creation

- `MIN_DURATION = 10 minutes`, `MAX_DURATION = 365 days`
- `MAX_DESCRIPTION_BYTES = 256`
- payee/arbiter must be non-zero and different from each other (`SelfReference`)
- token is USDC, 6 decimals, checked by the contract's `token` immutable

### The 48-hour grace period, and the arbiter window

`claimTimeout` unlocks only at `deadline + TIMEOUT_GRACE (48h)`. The delay
gives the payee a guaranteed window to open a dispute after a missed
deadline; before that, timeout claims revert with `TimeoutNotReached`.

Once a dispute IS open, `ARBITER_WINDOW (7 days)` starts at `disputedAt` and
the timeout path is blocked for that long too — `ArbiterWindowOpen(availableAt)`
names the exact second it reopens. Two properties fall out of that: the
arbiter gets a fixed, published window rather than an open-ended one, and a
silent arbiter still cannot lock funds forever, because after the window the
plain timeout rule applies again. Waiting never invents a new distribution of
the money.

`canClaimTimeout(id)` mirrors those two checks byte for byte, so the UI button
and the chain can never disagree.

## 2b. v2 consent and rescue

### EIP-712 handshake (optional)

`createEscrowHandshaked` accepts escrows whose terms the payee AND the arbiter
already signed off-chain — no gas for them, no new requirement for v1-style
escrows. The typed data is:

```
Handshake(address payer, address payee, address arbiter,
          uint256 amount, uint256 deadline, uint256 nonce,
          bytes32 descriptionHash)
domain: EIP712Domain(name = "Bond EscrowLink", version = "1",
                     chainId, verifyingContract)
```

Safety properties, each enforced by construction:

- **Single use.** The digest includes `handshakeNonces[payer]`, which increments
  on success, so one signature files exactly one deal.
- **Bound to this chain and this contract.** The domain carries `chainId` and
  `address(this)`; signing another deployment's digest reverts here.
- **Covers the exact terms.** Amount, deadline and description are inside the
  signed struct, so none of them can be altered after signing.
- **Two wallet types.** EOAs go through OpenZeppelin's audited
  `ECDSA.tryRecoverCalldata`; contract wallets answer a `isValidSignature`
  staticcall with the magic value. Either failure reverts with
  `InvalidHandshakeSignature` before any state is written.

The domain separator and the digest are both exposed as views
(`domainSeparator()`, `handshakeDigest(...)`) so a signer's wallet can rebuild
the same typed data independently — neither side has to trust the other's UI.

The EIP-712 hashing is written out by hand rather than inherited from
OpenZeppelin's `EIP712` module: in v5.7 that module transitively pulls
`Math.sol`, which compiles the `clz` opcode for Osaka. No OP Stack chain
guarantees that opcode, so the target here stays `evm_version = "cancun"`.
Only the hashing is hand-written; signature checking is still audited code.

### Blacklist rescue

Settlement (`confirm`, `resolveDispute`, `claimTimeout`) pushes tokens first.
If the token refuses the recipient — a USDC blacklist, or a contract that
rejects transfers — `_deliver` does not revert: it credits
`pendingWithdrawals[to]` and emits `PaymentCredited`. The credit's owner then
calls `withdrawPending(to)` to move it to any clean address they choose.

This is what stops one frozen counterparty from wedging settlement for
everyone: the principal still leaves the contract along one of the three
documented paths, it just arrives via pull instead of push. Effects precede
interactions (the credit is zeroed before the transfer) and the function is
`nonReentrant`, so a re-entering token finds nothing left to take.

## 3. Fees

- `feeBps` defaults to `50` (0.5%), hard-capped at `MAX_FEE_BPS = 1_000` (10%).
- The owner can raise/lower the global fee (`setFeeBps`), but **each escrow
  snapshots its own `feeBps` at creation** — a later change can never alter an
  existing escrow. That removes the "owner rugs the fee mid-flight" vector.
- Settlement splits through one pure helper, `_split(gross, feeBps_)`, used by
  `confirm` and `resolveDispute` so the arithmetic cannot drift between paths.
- Fees are **pull-accrued**: `accruedFees` increases only when an escrow
  settles; `withdrawFees(to)` moves only that balance. `NothingToWithdraw`
  guards the empty case.
- USDC edge case: `fund` compares the balance delta against the expected
  amount and reverts with `UnexpectedTransfer(received, expected)`, so
  fee-on-transfer or rebasing tokens can never under-collateralise an escrow.

## 4. Admin surface (deliberately small)

| Function | Guard | Notes |
| --- | --- | --- |
| `pause` / `unpause` | `onlyOwner` | pause blocks **new creation and funding**; already-funded escrows keep settling |
| `setFeeBps` | `onlyOwner` | applies to new escrows only |
| `setTreasury` | `onlyOwner` | where future fees accrue |
| `withdrawFees` | `onlyOwner` | accrued fees only, never principal |
| `renounceOwnership` | disabled (`RenounceDisabled`) | renouncing would strand the pause switch and fee withdrawal |

Ownership uses `Ownable2Step`: a transfer needs the new owner to accept, so a
typo'd address cannot permanently orphan admin rights.

## 5. Trust model

**What Bond operators can do:** pause new activity, change the fee for future
escrows, move the treasury, withdraw accrued fees.

**What nobody can do:** withdraw, freeze or redirect funds already locked in
an escrow; change a settled escrow's outcome; change a live escrow's fee.

**What the arbiter can do:** only inside `Disputed`, and only by splitting
between the two parties — never to a third address.

**What you must trust anyway:** the arbiter's judgement (pick one you agreed
with), the payer's confirmation honesty, and Base's liveness.

## 6. Frontend

```
web/src
├── main.tsx            providers: wagmi → react-query → toast → error boundary
├── app/
│   ├── App.tsx         routing (query params), masthead, footer
│   └── ErrorBoundary.tsx
├── features/
│   ├── landing/        homepage, live stats from escrowCount()/feeBps()
│   ├── create/         the escrow form + post-create link card
│   ├── escrow/         detail view, timeline, contract verification card
│   ├── records/        "My records" inbox built from event logs
│   └── docs/           docs, terms, privacy, status, contact, arbitration
├── components/ui/      AlertBox, Toast, TxButton, TxStatusCard, Feedback, Icons
├── components/wallet/  connect modal, account menu, network switch
├── lib/                contracts, chains, activity, errors, tx, env, indexCache
└── design/             tokens.css + global.css (the press theme)
```

### No backend: state from logs

There is no API. The two questions a backend would normally answer are
answered from `eth_getLogs`:

1. **"Which escrows involve me?"** — `EscrowCreated` indexes `payer` and
   `payee`; `getEscrowsForAccount` scans that event from the deploy block and
   filters all three roles in JS (`arbiter` is not an indexed topic, and the
   range is small).
2. **"What happened to this one?"** — `getEscrowTimeline` fetches *all*
   contract events in one request per chunk (seven separate queries trip
   public-RPC rate limits), then filters by the indexed `id` in JS.

Both are **incremental and cached** in `localStorage`
(`lib/indexCache.ts`): the key is `chain + contract + deploy block + scope`,
the stored value is the last block actually scanned, and the next visit starts
at `cached.to + 1`. The cache stores the block we scanned to, never `latest`,
so a capped range can never silently skip the tail. `EscrowCreated` and the
lifecycle events are append-only, so a merge by id/tx+kind is exact.

`lib/env.ts` keeps the deploy block **per chain** (`VITE_ESCROW_DEPLOY_BLOCK`
for Base Sepolia, `VITE_ESCROW_DEPLOY_BLOCK_BASE` for Base mainnet); a missing
value renders an explicit E08 banner instead of a silently empty inbox.

### RPC policy

`lib/wagmi.ts` runs a primary endpoint per chain with automatic failover, and
the failover rule is message-based, not status-code based:

- a contract verdict (`execution reverted`) is final — failing over would hide
  the payload viem decodes;
- a span limit (`exceed maximum block range`, HTTP 413) is final — the scan
  layer splits on it and parses the limit out of the error text;
- everything else (429, timeouts, dead endpoints) fails over.

The activity layer additionally splits any range error itself
(`chunkedScan`), so one flaky endpoint can never hang the UI.

### Error matrix

`lib/errors.ts` defines **E01–E12**. Every user-visible failure maps to a
matrix code rendered by `AlertBox` — never a raw viem error string. Layer 1
(form validation) and layer 2 (wallet disconnected / wrong network) are
detected before any RPC call; layer 3 is RPC read/write failure; layer 4 is
the contract's own custom errors, decoded by name. Declining a signature is
`E03` and is rendered **neutral** on purpose: declining is not an error.

### Transaction feedback

`lib/tx.ts` drives `TxStatusCard` through pre-flight → broadcast (E09) →
confirmed, and returns `{ ok, error, hash }` so callers decide what a failure
means in context instead of string-matching.

### Routing

Query parameters, not paths — the app is a static bundle with no server
rewrites: `/?view=create`, `/?view=records`, `/?escrow=2`,
`/?view=doc&doc=docs`. Landing, create, records and detail views are
`React.lazy`-split so the first chunk stays small.

### Accessibility and layout invariants

- Modal: Escape closes, focus enters on the close button, Tab cycles inside
  the panel, focus returns to the opener on unmount.
- Toasts are dismissible with a real `<button>`, not a clickable div.
- **Every heading stays on one line at every width.** Font sizes are computed
  from measured constants (longest sentence width ÷ font size), so the type
  shrinks to its measure instead of wrapping. Intentional line breaks are
  explicit (`\n` / `<br/>`), and hyphenated words are never split.
- No emoji and no symbol glyphs anywhere: `scripts/scan-glyphs.mjs` allowlists
  only typographic characters and runs in CI.

## 7. Testing

| Layer | Tool | What it covers |
| --- | --- | --- |
| Contract unit/fuzz | `forge test` (56 tests) | state transitions, auth, fee math, deadline bounds, pause, two-step ownership |
| Invariants | `EscrowLink.invariant.t.sol` | principal conservation under random call sequences |
| Token edges | `test/mocks/` | fee-on-transfer USDC, standard mock |
| Types | `tsc --noEmit` | whole frontend |
| Build | `vite build` | bundle + chunk budget |
| Glyph policy | `scan-glyphs.mjs` | no emoji/symbol drift |
| Secrets | CI job | fails if `.env` is tracked or a raw key is committed |
| Layout | measured scans | headings one line, zero horizontal overflow at 9 widths × 5 routes |

CI profile (`FOUNDRY_PROFILE=ci`) raises fuzz runs to 2048 and invariant runs
to 256.

## 8. Verification

The contract is published to Sourcify as `exact_match`: an independent
recompilation of the published source must reproduce the deployed bytecode
byte for byte. The in-app verification card queries the Sourcify API live and
links to the verified source — the explorer is a secondary, not the source of
truth. The project is **open-source and source-verified, not audited**, and
every surface says exactly that.

## 9. Frontend roadmap (in progress)

- Contract v2: EIP-712 three-party handshake, arbiter-timeout escape from
  `Disputed`, permissionless sweep, blacklist rescue, `feeBps` in
  `EscrowCreated`.
- Evidence dossier, reputation badges, transparency ticker, QR/share links,
  `.ics` deadline reminders, presets, watch-only links.
