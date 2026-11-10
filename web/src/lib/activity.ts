import type { Address, PublicClient } from "viem";
import { ESCROW_ABI } from "./contracts";
import { deployBlockFor } from "./env";
import { formatUsdc } from "./format";
import { indexKey, readIndex, writeIndex } from "./indexCache";

/**
 * On-chain activity layer — the app's "notification" system, with no backend.
 *
 * Everything here is derived from event logs emitted by EscrowLink. Because
 * `EscrowCreated` indexes `payer` and `payee`, and every lifecycle event
 * indexes `id`, we can answer the two questions the UI used to be unable to
 * ask:
 *
 *   1. "Which escrows involve me?"  -> getEscrowsForAccount()
 *   2. "What happened to this one?" -> getEscrowTimeline()
 *
 * The scan range is bounded by the deployment block (set at build time), so a
 * public RPC never has to walk the whole chain.
 */

/** First block that can contain EscrowLink logs, per chain (web/.env). */
export { deployBlockFor, isDeployBlockConfigured, deployBlockEnvKey } from "./env";

/**
 * Cap a scan window so an old deployment can never hang the UI: a fresh
 * (uncached) visit walks at most this many blocks, and the cache resumes
 * from there on the next load.
 */
const MAX_BLOCK_RANGE = 500_000n;

function capRange(from: bigint, to: bigint): { fromBlock: bigint; toBlock: bigint } {
  const capped = from + MAX_BLOCK_RANGE > to ? to : from + MAX_BLOCK_RANGE;
  return { fromBlock: from, toBlock: capped };
}

/**
 * wagmi's `usePublicClient()` returns a client bound to one chain, while a
 * bare viem client infers another — the shape we use (getLogs, getBlock,
 * readContract) is identical, so the chain generics are widened here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = PublicClient<any, any>;

export type PartyRole = "payer" | "payee" | "arbiter";

export interface EscrowCreatedEntry {
  id: bigint;
  payer: Address;
  payee: Address;
  arbiter: Address;
  amount: bigint;
  deadline: bigint;
  description: string;
  /** How the connected account relates to this escrow. */
  roles: PartyRole[];
}

export type TimelineKind =
  | "EscrowCreated"
  | "EscrowFunded"
  | "EscrowCancelled"
  | "EscrowConfirmed"
  | "EscrowRefunded"
  | "DisputeOpened"
  | "DisputeResolved"
  | "MilestoneAdded"
  | "MilestoneSettled"
  | "EvidenceSubmitted";

export interface TimelineEntry {
  kind: TimelineKind;
  id: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  /** Unix seconds, filled from the block that mined the log. */
  timestamp?: number;
  /** EscrowCreated only. */
  payer?: Address;
  payee?: Address;
  arbiter?: Address;
  amount?: bigint;
  deadline?: bigint;
  /** EscrowConfirmed / DisputeResolved. */
  payeeAmount?: bigint;
  fee?: bigint;
  /** DisputeResolved. */
  payerAmount?: bigint;
  /** EscrowRefunded. */
  byTimeout?: boolean;
  /** DisputeOpened / EvidenceSubmitted. */
  by?: Address;
  /** MilestoneAdded / MilestoneSettled. */
  index?: bigint;
  /** MilestoneAdded only. */
  due?: bigint;
  title?: string;
  /** EvidenceSubmitted only. */
  evidenceHash?: `0x${string}`;
  note?: string;
}

/**
 * RPCs cap `eth_getLogs` by block span, and the cap keeps shrinking relative
 * to us as the chain grows (official Base: 200, publicnode: 50,000 — and the
 * deployment is already past 54k blocks). Rather than hardcoding a span that
 * rots, try the full range and split only when the node complains, parsing
 * the limit out of its error message when it tells us one.
 */
function parseRangeLimit(msg: string): bigint | null {
  const m = msg.match(/(\d[\d,_]*)\s*range\b/i) ?? msg.match(/\brange[:\s]+(\d[\d,_]*)/i);
  if (!m) return null;
  try {
    return BigInt(m[1].replace(/[,_\s]/g, ""));
  } catch {
    return null;
  }
}

/** Fetch logs over [from, to], transparently splitting on range errors. */
export async function chunkedScan<T>(
  from: bigint,
  to: bigint,
  fetchRange: (f: bigint, t: bigint) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];

  const walk = async (f: bigint, t: bigint): Promise<void> => {
    if (t < f) return;
    try {
      out.push(...(await fetchRange(f, t)));
    } catch (err) {
      // Split only on span-limit failures; rate limits (429) and real errors
      // must propagate instead of being multiplied into more requests.
      const msg = err instanceof Error ? `${err.message} ${err.name}` : String(err);
      if (!/range|413|-32614|-32701/i.test(msg) || t === f) throw err;

      const span = t - f + 1n;
      const limit = parseRangeLimit(msg);
      let cut = limit !== null && limit > 0n && limit < span ? f + limit - 1n : f + (span - 1n) / 2n;
      if (cut < f) cut = f;
      if (cut >= t) cut = t - 1n; // guarantee progress on a single-block retry

      await walk(f, cut);
      await walk(cut + 1n, t);
    }
  };

  await walk(from, to);
  return out;
}

/**
 * Every escrow the account is party to (payer, payee or arbiter).
 *
 * `payer`/`payee` are indexed topics but `arbiter` is not, so we decode all
 * `EscrowCreated` logs in range and filter in JS — one code path for all
 * three roles, and the range is small.
 *
 * Cached: the result is persisted per (chain, contract, account) and the
 * next call only scans blocks the chain has added since the last visit.
 * `EscrowCreated` is append-only, so an incremental merge is exact.
 * Pass `force` to drop the cache and rescan from the deploy block.
 */
export async function getEscrowsForAccount(
  client: AnyClient,
  contract: Address,
  account: Address,
  chainId: number,
  opts: { force?: boolean } = {},
): Promise<EscrowCreatedEntry[]> {
  const latest = await client.getBlockNumber();

  const deployBlock = deployBlockFor(chainId);
  const key = indexKey(chainId, contract, deployBlock, `escrows.${account.toLowerCase()}`);
  const cached = opts.force ? null : readIndex<EscrowCreatedEntry[]>(key);

  // Incremental: resume one block past the last scan. `to` is stored as the
  // block we already included, never the block we asked for.
  const from = cached ? cached.to + 1n : deployBlock;
  if (from > latest) return sortNewestFirst(cached?.data ?? []);
  const { fromBlock, toBlock } = capRange(from, latest);

  const logs = await chunkedScan(fromBlock, toBlock, (f, t) =>
    client.getContractEvents({
      address: contract,
      abi: ESCROW_ABI,
      eventName: "EscrowCreated",
      fromBlock: f,
      toBlock: t,
      strict: true,
    }),
  );

  const me = account.toLowerCase();
  const found: EscrowCreatedEntry[] = [];

  for (const log of logs) {
    const a = (log as { args?: Record<string, unknown> }).args;
    if (!a?.payer) continue;

    const roles: PartyRole[] = [];
    if (String(a.payer).toLowerCase() === me) roles.push("payer");
    if (String(a.payee).toLowerCase() === me) roles.push("payee");
    if (String(a.arbiter).toLowerCase() === me) roles.push("arbiter");
    if (roles.length === 0) continue;

    found.push({
      id: BigInt(a.id as bigint),
      payer: a.payer as Address,
      payee: a.payee as Address,
      arbiter: a.arbiter as Address,
      amount: BigInt(a.amount as bigint),
      deadline: BigInt(a.deadline as bigint),
      description: String(a.description ?? ""),
      roles,
    });
  }

  const merged = mergeById(cached?.data ?? [], found);
  // Store the block we ACTUALLY scanned up to — `latest` would silently skip
  // the tail whenever the range cap kicked in.
  writeIndex(key, toBlock, merged);

  // Newest first — the inbox reads like a bulletin board.
  return sortNewestFirst(merged);
}

/** Union by `id` (newer wins), so a forced rescan cannot duplicate rows. */
function mergeById(prev: EscrowCreatedEntry[], next: EscrowCreatedEntry[]): EscrowCreatedEntry[] {
  const byId = new Map<string, EscrowCreatedEntry>();
  for (const e of prev) byId.set(String(e.id), e);
  for (const e of next) byId.set(String(e.id), e);
  return [...byId.values()];
}

function sortNewestFirst(rows: EscrowCreatedEntry[]): EscrowCreatedEntry[] {
  return rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

type DecodedLog = {
  args?: Record<string, unknown>;
  eventName?: string;
  transactionHash?: `0x${string}`;
  blockNumber?: bigint | null;
};

/**
 * Full lifecycle of one escrow, oldest first, with block timestamps so the
 * timeline renders real dates instead of bare tx hashes.
 *
 * ONE request for the whole contract (all event types in range), then a JS
 * filter on the indexed `id` — viem decodes the payloads for us. Batching
 * matters: seven separate queries trip the public RPC's rate limit (429).
 *
 * Cached per (chain, contract, id): lifecycle events are append-only, so
 * later visits only scan the blocks added since. `force` rescans everything.
 */
export async function getEscrowTimeline(
  client: AnyClient,
  contract: Address,
  id: bigint,
  chainId: number,
  opts: { force?: boolean } = {},
): Promise<TimelineEntry[]> {
  const latest = await client.getBlockNumber();

  const deployBlock = deployBlockFor(chainId);
  const key = indexKey(chainId, contract, deployBlock, `timeline.${id.toString()}`);
  const cached = opts.force ? null : readIndex<TimelineEntry[]>(key);
  const from = cached ? cached.to + 1n : deployBlock;

  let entries: TimelineEntry[];
  let cacheable = true;
  // Block we actually scanned up to (the range cap can stop short of `latest`).
  let scannedTo: bigint | null = null;

  if (from > latest) {
    entries = cached?.data ?? [];
  } else {
    const { fromBlock, toBlock } = capRange(from, latest);
    scannedTo = toBlock;

    // No `eventName` -> viem derives the event list from `abi` itself and
    // decodes each log's args; chunkedScan keeps it to as few RPC calls as the
    // node allows (batching matters: many small queries trip rate limits).
    const logs = (await chunkedScan(fromBlock, toBlock, (f, t) =>
      client.getContractEvents({
        address: contract,
        abi: ESCROW_ABI,
        fromBlock: f,
        toBlock: t,
        strict: false,
      }),
    )) as unknown as DecodedLog[];

    const fresh: TimelineEntry[] = [];

    for (const raw of logs) {
      const a = raw.args;
      if (!a || a.id === undefined || BigInt(a.id as bigint) !== id) continue;
      if (raw.blockNumber === null || raw.blockNumber === undefined || !raw.transactionHash) continue;

      const kind = raw.eventName as TimelineKind | undefined;
      if (!kind || !(KIND_SET as Set<string>).has(kind)) continue;

      const entry: TimelineEntry = {
        kind,
        id,
        txHash: raw.transactionHash,
        blockNumber: raw.blockNumber,
      };

      if (kind === "EscrowCreated") {
        entry.payer = a.payer as Address;
        entry.payee = a.payee as Address;
        entry.arbiter = a.arbiter as Address;
        entry.amount = BigInt(a.amount as bigint);
        entry.deadline = BigInt(a.deadline as bigint);
      } else if (kind === "EscrowConfirmed") {
        entry.payeeAmount = BigInt(a.payeeAmount as bigint);
        entry.fee = BigInt(a.fee as bigint);
      } else if (kind === "EscrowRefunded") {
        entry.byTimeout = Boolean(a.byTimeout);
      } else if (kind === "DisputeOpened") {
        entry.by = a.by as Address;
      } else if (kind === "DisputeResolved") {
        entry.payeeAmount = BigInt(a.payeeAmount as bigint);
        entry.payerAmount = BigInt(a.payerAmount as bigint);
        entry.fee = BigInt(a.fee as bigint);
      } else if (kind === "MilestoneAdded") {
        entry.index = BigInt(a.index as bigint);
        entry.amount = BigInt(a.amount as bigint);
        entry.due = BigInt(a.due as bigint);
        entry.title = String(a.title ?? "");
      } else if (kind === "MilestoneSettled") {
        entry.index = BigInt(a.index as bigint);
        entry.payeeAmount = BigInt(a.payeeAmount as bigint);
        entry.fee = BigInt(a.fee as bigint);
      } else if (kind === "EvidenceSubmitted") {
        entry.by = a.by as Address;
        entry.evidenceHash = a.evidenceHash as `0x${string}`;
        entry.note = String(a.note ?? "");
      }

      fresh.push(entry);
    }

    const byKey = new Map<string, TimelineEntry>();
    for (const e of cached?.data ?? []) byKey.set(timelineKey(e), e);
    for (const e of fresh) byKey.set(timelineKey(e), e);
    entries = [...byKey.values()];
    cacheable = fresh.length > 0 || cached !== null;
  }

  entries.sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  );

  // One timestamp lookup per UNIQUE BLOCK that is still missing one — the
  // cached entries arrive already stamped, so only fresh blocks are fetched.
  const blockNums = [
    ...new Set(entries.filter((e) => e.timestamp === undefined).map((e) => Number(e.blockNumber))),
  ];
  if (blockNums.length > 0) {
    const blocks = await Promise.all(
      blockNums.map((n) => client.getBlock({ blockNumber: BigInt(n) }).catch(() => null)),
    );
    const stamps = new Map<number, number>();
    blocks.forEach((b, i) => {
      if (b) stamps.set(blockNums[i], Number(b.timestamp));
    });
    for (const e of entries) {
      if (e.timestamp !== undefined) continue;
      const ts = stamps.get(Number(e.blockNumber));
      if (ts !== undefined) e.timestamp = ts;
    }
  }

  // Only persist once every entry carries a timestamp, otherwise the next
  // visit would inherit a timeline with no dates and never repair it.
  if (cacheable && scannedTo !== null && entries.every((e) => e.timestamp !== undefined)) {
    writeIndex(key, scannedTo, entries);
  }

  return entries;
}

/**
 * Dedupe key: a reorg-free chain still needs one, and tx+kind is unique —
 * EXCEPT for milestone events, which repeat inside a single transaction
 * (all `MilestoneAdded` share the creation tx, a batch `confirm` emits one
 * `MilestoneSettled` per slice), so their `index` joins the key.
 */
function timelineKey(e: TimelineEntry): string {
  return e.index === undefined ? `${e.txHash}:${e.kind}` : `${e.txHash}:${e.kind}:${e.index}`;
}

const KIND_SET: ReadonlySet<TimelineKind> = new Set<TimelineKind>([
  "EscrowCreated",
  "EscrowFunded",
  "EscrowCancelled",
  "EscrowConfirmed",
  "EscrowRefunded",
  "DisputeOpened",
  "DisputeResolved",
  "MilestoneAdded",
  "MilestoneSettled",
  "EvidenceSubmitted",
]);

/**
 * One human line per lifecycle event — shared by the timeline card, the
 * dossier's plain-text copy and the PDF packet so every surface reads the
 * same record the same way.
 */
export function eventLabel(e: TimelineEntry): string {
  switch (e.kind) {
    case "EscrowCreated":
      return `Escrow created - ${formatUsdc(e.amount ?? 0n)} USDC to ${e.payee ?? "unknown"}`;
    case "EscrowFunded":
      return "Payer locked the funds into the contract";
    case "EscrowCancelled":
      return "Payer cancelled before funding - nothing was locked";
    case "EscrowConfirmed":
      return `Payer confirmed delivery - ${formatUsdc(e.payeeAmount ?? 0n)} USDC to payee, ${formatUsdc(e.fee ?? 0n)} USDC fee`;
    case "EscrowRefunded":
      return e.byTimeout
        ? "Deadline plus 48h grace passed - payer reclaimed the funds (timeout)"
        : "Funds returned to the payer";
    case "DisputeOpened":
      return `Dispute opened by ${e.by ?? "unknown"}`;
    case "DisputeResolved":
      return `Arbiter resolved - payee ${formatUsdc(e.payeeAmount ?? 0n)}, payer ${formatUsdc(e.payerAmount ?? 0n)}, fee ${formatUsdc(e.fee ?? 0n)}`;
    case "MilestoneAdded":
      return `Milestone ${e.index !== undefined ? Number(e.index) + 1 : "?"} added - ${e.title ? `${e.title}, ` : ""}${formatUsdc(e.amount ?? 0n)} USDC`;
    case "MilestoneSettled":
      return `Milestone ${e.index !== undefined ? Number(e.index) + 1 : "?"} released - ${formatUsdc(e.payeeAmount ?? 0n)} USDC to payee, ${formatUsdc(e.fee ?? 0n)} USDC fee`;
    case "EvidenceSubmitted":
      return `Evidence anchored by ${e.by ?? "unknown"}${e.note ? ` - ${e.note}` : ""}`;
  }
}
