/**
 * Local event-index cache.
 *
 * Bond has no backend, so "My records" and the escrow timeline are rebuilt
 * from `eth_getLogs` on every visit. Against a public RPC that means a
 * full-range scan per page load — slow, and the main cause of 429s.
 *
 * This module persists the last scan in `localStorage` so the next visit
 * only has to ask for blocks the chain has added since (`from = cached.to + 1`).
 * Escrow lifecycle events are append-only, so an incremental merge is exact:
 * nothing ever changes after it is emitted.
 *
 * Design notes:
 *  - Keys carry the chain, the contract and the deploy block, so a redeploy
 *    or a network switch can never read another deployment's cache.
 *  - Writes are best-effort. Private mode, quota exhaustion or a disabled
 *    storage backend simply fall through to a full scan — never an error.
 *  - Values are JSON with bigints wrapped as `{ "__b": "123" }`.
 */

const PREFIX = "bond.idx.v1";

/** Cache version — bump to invalidate every stored index at once. */
const VERSION = 1;

export interface CachedIndex<T> {
  /** Highest block number included in `data`. */
  to: bigint;
  data: T;
}

/** Namespace a cache entry by chain, contract, deploy block and scope. */
export function indexKey(chainId: number, contract: string, deployBlock: bigint, scope: string): string {
  return `${PREFIX}.${VERSION}.${chainId}.${contract.toLowerCase()}.${deployBlock}.${scope}`;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { __b: value.toString() };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && typeof (value as { __b?: unknown }).__b === "string") {
    return BigInt((value as { __b: string }).__b);
  }
  return value;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Access itself can throw (blocked cookies, sandboxed iframe).
    return null;
  }
}

/** Read a cached index, or `null` on any miss / parse / version mismatch. */
export function readIndex<T>(key: string): CachedIndex<T> | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw, reviver) as { to?: unknown; data?: unknown };
    if (typeof parsed.to !== "bigint" || parsed.data === undefined) return null;
    return { to: parsed.to, data: parsed.data as T };
  } catch {
    // Corrupt or foreign entry: drop it rather than fail the page.
    try {
      s.removeItem(key);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * Persist a cached index. Best-effort: if the quota is full, every Bond
 * index is cleared once and the write retried, then the cache is abandoned.
 */
export function writeIndex<T>(key: string, to: bigint, data: T): void {
  const s = storage();
  if (!s) return;
  const payload = JSON.stringify({ to, data }, replacer);
  try {
    s.setItem(key, payload);
    return;
  } catch {
    /* quota — fall through to the wipe */
  }
  try {
    clearIndexes();
    s.setItem(key, payload);
  } catch {
    /* still no room: the next read simply rescans */
  }
}

/** Drop every cached index (used by the wipe above and by tests). */
export function clearIndexes(): void {
  const s = storage();
  if (!s) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k && k.startsWith(`${PREFIX}.`)) doomed.push(k);
    }
    for (const k of doomed) s.removeItem(k);
  } catch {
    /* ignore */
  }
}
