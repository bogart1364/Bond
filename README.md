# Bond — non-custodial USDC escrow on Base

Bond is a link-based escrow protocol: the payer locks USDC in an open-source,
source-verified contract, the payee delivers, and the payer's confirmation
releases the funds. Disputes go to a single arbiter. Silence returns the money
after the deadline plus a 48-hour grace period — and because that payout is
fixed by the contract (everything back to the payer), anyone may execute it,
so an abandoned link can never stay locked.

No account, no backend, no custodian. The frontend is static files; every
number on the page is read from the chain, and "My records" is reconstructed
from event logs.

- **Chain:** Base (8453) and Base Sepolia (84532)
- **Settlement token:** native USDC (6 decimals)
- **Protocol fee:** 0.5% (50 bps), snapshotted into each escrow at creation
- **Contract:** `src/EscrowLink.sol` — Solidity 0.8.31, OpenZeppelin v5.7 (vendored in `lib/`)
- **v2:** optional EIP-712 payee + arbiter consent, permissionless timeout
  sweep, a published 7-day arbiter window, and a blacklist rescue path that
  credits instead of reverting

## Repository layout

| Path | What it is |
| --- | --- |
| `src/EscrowLink.sol` | The escrow contract — the entire protocol |
| `script/Deploy.s.sol` | One script for both networks (USDC picked by chain id) |
| `test/` | 66 forge tests: unit, fuzz, invariant, plus token mocks |
| `web/` | React + Vite + TypeScript + viem/wagmi frontend |
| `scripts/scan-glyphs.mjs` | Glyph policy check (no emoji, no symbol arrows) |
| `scripts/sync-abi.mjs` | Regenerates both frontend ABI copies from the forge artifact |
| `.github/workflows/ci.yml` | forge fmt/build/test, tsc, vite build, glyph scan, secret hygiene |
| `ARCHITECTURE.md` | State machine, custody model, fee math, frontend architecture |

## Contracts

```shell
forge build
forge test            # 66 tests
forge fmt --check     # CI runs this
node scripts/sync-abi.mjs   # after touching the contract, before building web/
```

Heavy fuzzing lives in the CI profile: `FOUNDRY_PROFILE=ci forge test`.

Deploy (testnet first, always):

```shell
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
export ETHERSCAN_API_KEY=...
export PRIVATE_KEY=0x...          # deployer; never commit this
forge script script/Deploy.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast --verify
```

The script defaults to the canonical USDC for the target chain and a 50 bps
fee; override with `USDC_ADDRESS`, `TREASURY_ADDRESS`, `OWNER_ADDRESS`,
`FEE_BPS`. Verification is also available through Sourcify
(`exact_match`), which the frontend queries directly.

## Deployments

| Network | Contract | Address | Deploy block |
| --- | --- | --- | --- |
| Base (8453) | EscrowLink v2 | `0x5F9a3bC9Dbb02066Fe265213952e590A109f6Ec6` | 54481267 |
| Base Sepolia (84532) | EscrowLink v2 | `0xeE6aeefd36BdCbD699AfE5dDdf35D0673C16Ae3b` | 55335004 |

Both deployments are source-verified on Basescan and Sourcify
(`exact_match`). On mainnet the owner and treasury are the same cold wallet;
the deployer key that broadcast the deployment holds no privileges and only
paid gas.

**Secrets:** `.env` files are gitignored and CI fails the build if one is ever
tracked or if a raw private key is committed. Put the deployer key in your
shell environment or a local `.env`, never in the repo.

## Frontend

```shell
cd web
npm ci
cp .env.example .env    # then fill in the deploy block / address
npm run dev             # http://localhost:3000
npm run build           # tsc -b && vite build
npm run lint            # oxlint
```

Required build-time keys (all public by definition — the bundle is):

- `VITE_ESCROW_ADDRESS_BASE_SEPOLIA` — deployed contract address
- `VITE_ESCROW_DEPLOY_BLOCK` — first block that can contain its logs
- `VITE_ESCROW_ADDRESS_BASE` / `VITE_ESCROW_DEPLOY_BLOCK_BASE` — Base mainnet
  (`0x5F9a3bC9Dbb02066Fe265213952e590A109f6Ec6`, block 54481267)
- `VITE_RPC_URL_MAINNET` / `VITE_RPC_URL_SEPOLIA` — optional RPC overrides
- `VITE_WALLETCONNECT_PROJECT_ID` — optional; enables the WalletConnect / QR
  connector next to injected and Coinbase Wallet

## Design

The interface is set as a criminal-press newspaper: aged newsprint, black ink,
Base blue `#0052FF`, typewriter labels, registration marks, zero border radius.
Themed SVG engraving icons only — no emoji, no symbol glyphs; that rule is
enforced by `scripts/scan-glyphs.mjs` in CI.

Every heading is measured to stay on one line at every viewport width, error
states carry a documented code (E01–E12) rendered by an explicit alert-box
system, and the footer's status line states only what the deploy config can
prove.

## Verification, claims and honesty

Bond claims to be **open-source and source-verified**, not audited: the
bytecode is independently recompiled by Sourcify and must read `exact_match`.
Read the source yourself — the in-app contract card links straight to the
verified Solidity.

## License

MIT (contract and scripts); see file headers.
