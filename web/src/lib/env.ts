/**
 * Build-time environment for the on-chain read path.
 *
 * Split out from `activity.ts` so the index cache can key entries on the
 * configured deploy block without importing the whole activity layer.
 */

/**
 * First block that can contain EscrowLink logs, per chain (set in web/.env).
 *
 * One key per network: the two deployments land at different heights, and a
 * single shared value would start the wrong chain's scan at genesis (or scan
 * blocks that predate the contract).
 *
 * `0` (or a missing key) means "not configured". That is a real, silent
 * failure mode: the scan then starts at genesis and public RPCs refuse the
 * range, so My records looks empty with no error.
 * `isDeployBlockConfigured()` lets the UI say so.
 */
const DEPLOY_BLOCKS: Record<number, string | undefined> = {
  // Base mainnet — set once the contract is deployed there.
  8453: import.meta.env.VITE_ESCROW_DEPLOY_BLOCK_BASE as string | undefined,
  // Base Sepolia — the live deployment.
  84532: import.meta.env.VITE_ESCROW_DEPLOY_BLOCK as string | undefined,
};

/** Deploy block for a chain; `0n` when the build has no value for it. */
export function deployBlockFor(chainId: number): bigint {
  const raw = DEPLOY_BLOCKS[chainId];
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

export function isDeployBlockConfigured(chainId: number): boolean {
  return deployBlockFor(chainId) > 0n;
}

/** The env key a chain's deploy block lives under — for error copy. */
export function deployBlockEnvKey(chainId: number): string {
  return chainId === 8453 ? "VITE_ESCROW_DEPLOY_BLOCK_BASE" : "VITE_ESCROW_DEPLOY_BLOCK";
}
