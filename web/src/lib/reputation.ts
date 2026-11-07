import type { Address, PublicClient } from "viem";
import { chunkedScan } from "./activity";
import { ESCROW_ABI } from "./contracts";
import { deployBlockFor } from "./env";
import { indexKey, readIndex, writeIndex } from "./indexCache";

/**
 * Same widened client type as `activity.ts`: wagmi binds a client to one
 * chain while a bare viem client infers another, and the shape used here
 * (getBlockNumber, getContractEvents) is identical for both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any, any>;

/**
 * Reputation, derived from logs — no backend, no scores to trust.
 *
 * The detail view shows a one-line track record next to every party:
 * how many escrows this address has opened, how many actually paid out,
 * how many disputes it has ruled. Every number below is counted from
 * `EscrowLink` events, so it is as verifiable as the escrow itself —
 * a badge here is a summary of receipts, never an opinion.
 *
 * One full-contract ledger scan feeds all three parties at once (the
 * timeline component scans the same events per-escrow); it is cached
 * incrementally like every other index in `indexCache`.
 */

export type LedgerKind =
  | "EscrowCreated"
  | "EscrowCancelled"
  | "EscrowConfirmed"
  | "EscrowRefunded"
  | "DisputeOpened"
  | "DisputeResolved";

/** Only the fields reputation maths needs — a slim subset of the timeline. */
export interface LedgerEntry {
  kind: LedgerKind;
  id: bigint;
  txHash: string;
  blockNumber: bigint;
  /** EscrowCreated only: the parties every later event is attributed to. */
  payer?: Address;
  payee?: Address;
  arbiter?: Address;
  /** EscrowConfirmed / DisputeResolved: what the payee actually got. */
  payeeAmount?: bigint;
  /** DisputeResolved: what the payer got back, and the fee retained. */
  payerAmount?: bigint;
  fee?: bigint;
}

const LEDGER_KINDS: ReadonlySet<string> = new Set<LedgerKind>([
  "EscrowCreated",
  "EscrowCancelled",
  "EscrowConfirmed",
  "EscrowRefunded",
  "DisputeOpened",
  "DisputeResolved",
]);

export interface AddressReputation {
  /** Escrows created with this address as payer. */
  opened: number;
  /** Escrows created with this address as payee. */
  received: number;
  /** Escrows created with this address as arbiter. */
  arbitrated: number;
  /** Payee escrows that ended with a payout to the payee. */
  settled: number;
  /** Payee escrows that ended with nothing for the payee. */
  returned: number;
  /** Total paid out to this address as payee, in USDC base units. */
  settledVolume: bigint;
  /** Disputes this address ruled on as arbiter. */
  rulings: number;
}

/** Zero-valued record, so callers never have to guard on `undefined`. */
function emptyReputation(): AddressReputation {
  return {
    opened: 0,
    received: 0,
    arbitrated: 0,
    settled: 0,
    returned: 0,
    settledVolume: 0n,
    rulings: 0,
  };
}

/**
 * Full contract ledger, oldest first, cached per (chain, contract).
 *
 * Like the timeline: ONE request for every event type in range, then a JS
 * filter — seven separate queries trip the public RPC's rate limit. Events
 * are append-only, so the cache resumes one block past the last scan and
 * merges by (tx, kind, id) without ever double counting.
 */
export async function getContractLedger(
  client: AnyClient,
  contract: Address,
  chainId: number,
  opts: { force?: boolean } = {},
): Promise<LedgerEntry[]> {
  const latest = await client.getBlockNumber();

  const deployBlock = deployBlockFor(chainId);
  const key = indexKey(chainId, contract, deployBlock, "ledger");
  const cached = opts.force ? null : readIndex<LedgerEntry[]>(key);
  const from = cached ? cached.to + 1n : deployBlock;

  if (from > latest) return sortOldestFirst(cached?.data ?? []);

  const MAX_BLOCK_RANGE = 500_000n;
  const toBlock = from + MAX_BLOCK_RANGE > latest ? latest : from + MAX_BLOCK_RANGE;

  // Split on range errors like every other scan: publicnode caps
  // eth_getLogs at 50,000 blocks (official Base at 200), and one
  // unsplit request here used to reject the whole ledger silently.
  const logs = await chunkedScan(from, toBlock, (f, t) =>
    client.getContractEvents({
      address: contract,
      abi: ESCROW_ABI,
      fromBlock: f,
      toBlock: t,
      strict: false,
    }),
  );
  const rawLogs = logs as unknown as Array<{
    args?: Record<string, unknown>;
    eventName?: string;
    transactionHash?: string;
    blockNumber?: bigint | null;
  }>;

  const fresh: LedgerEntry[] = [];
  for (const raw of rawLogs) {
    const kind = raw.eventName;
    if (!kind || !LEDGER_KINDS.has(kind)) continue;
    if (raw.blockNumber === null || raw.blockNumber === undefined || !raw.transactionHash) continue;
    const a = raw.args;
    if (!a || a.id === undefined) continue;

    const entry: LedgerEntry = {
      kind: kind as LedgerKind,
      id: BigInt(a.id as bigint),
      txHash: raw.transactionHash,
      blockNumber: raw.blockNumber,
    };

    if (entry.kind === "EscrowCreated") {
      entry.payer = a.payer as Address;
      entry.payee = a.payee as Address;
      entry.arbiter = a.arbiter as Address;
    } else if (entry.kind === "EscrowConfirmed") {
      entry.payeeAmount = BigInt(a.payeeAmount as bigint);
    } else if (entry.kind === "DisputeResolved") {
      entry.payeeAmount = BigInt(a.payeeAmount as bigint);
      entry.payerAmount = BigInt(a.payerAmount as bigint);
      entry.fee = BigInt(a.fee as bigint);
    }

    fresh.push(entry);
  }

  const byKey = new Map<string, LedgerEntry>();
  for (const e of cached?.data ?? []) byKey.set(ledgerKey(e), e);
  for (const e of fresh) byKey.set(ledgerKey(e), e);

  const merged = sortOldestFirst([...byKey.values()]);
  // Persist even a no-op scan: it records `toBlock`, so the next visit skips
  // the range instead of re-walking it on every page load.
  writeIndex(key, toBlock, merged);
  return merged;
}

/** Dedupe key: tx + kind + id is unique even for batched same-tx events. */
function ledgerKey(e: LedgerEntry): string {
  return `${e.txHash}:${e.kind}:${e.id.toString()}`;
}

function sortOldestFirst(rows: LedgerEntry[]): LedgerEntry[] {
  return rows.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
}

/**
 * Count one address's record out of the ledger.
 *
 * Terminal events are attributed through the `EscrowCreated` row for the
 * same id, so a payout is credited to the payee of THAT escrow rather than
 * to whoever happened to send the settlement transaction.
 */
export function reputationFor(rows: readonly LedgerEntry[], address: Address): AddressReputation {
  const stats = emptyReputation();
  const me = address.toLowerCase();

  // Pass 1: parties per escrow id (created rows are oldest-first, but a
  // terminal event can only exist once its escrow exists on-chain).
  const parties = new Map<string, { payer: string; payee: string; arbiter: string }>();
  for (const e of rows) {
    if (e.kind !== "EscrowCreated" || !e.payer || !e.payee || !e.arbiter) continue;
    parties.set(e.id.toString(), {
      payer: e.payer.toLowerCase(),
      payee: e.payee.toLowerCase(),
      arbiter: e.arbiter.toLowerCase(),
    });
    if (e.payer.toLowerCase() === me) stats.opened += 1;
    if (e.payee.toLowerCase() === me) stats.received += 1;
    if (e.arbiter.toLowerCase() === me) stats.arbitrated += 1;
  }

  // Pass 2: outcomes.
  for (const e of rows) {
    if (e.kind === "EscrowCreated") continue;
    const p = parties.get(e.id.toString());
    if (!p) continue;

    if (e.kind === "DisputeResolved" && p.arbiter === me) stats.rulings += 1;

    if (p.payee !== me) continue;
    if (e.kind === "EscrowConfirmed") {
      stats.settled += 1;
      stats.settledVolume += e.payeeAmount ?? 0n;
    } else if (e.kind === "DisputeResolved") {
      const paid = e.payeeAmount ?? 0n;
      if (paid > 0n) {
        stats.settled += 1;
        stats.settledVolume += paid;
      } else {
        stats.returned += 1;
      }
    } else if (e.kind === "EscrowRefunded" || e.kind === "EscrowCancelled") {
      stats.returned += 1;
    }
  }

  return stats;
}

/**
 * One-line badge copy for a party row. Returns `null` when the address has
 * no history worth showing — an empty record is not a failure to display.
 */
export function reputationBadge(
  role: "payer" | "payee" | "arbiter",
  stats: AddressReputation,
): { label: string; tone: "neutral" | "brand" | "success" } | null {
  if (role === "payee") {
    if (stats.settled > 0) return { label: `${stats.settled} settled`, tone: "success" };
    if (stats.received > 0) return { label: "new payee", tone: "neutral" };
    return null;
  }
  if (role === "payer") {
    if (stats.opened > 0) return { label: `${stats.opened} opened`, tone: "neutral" };
    return null;
  }
  if (stats.rulings > 0) return { label: `${stats.rulings} rulings`, tone: "brand" };
  if (stats.arbitrated > 0) return { label: "no rulings yet", tone: "neutral" };
  return null;
}
