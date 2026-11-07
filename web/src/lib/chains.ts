import { base, baseSepolia } from "wagmi/chains";
import type { Chain } from "wagmi/chains";

/** The two networks Bond ships on. */
export const CHAINS = [base, baseSepolia] as const satisfies readonly Chain[];

export type SupportedChainId = (typeof CHAINS)[number]["id"];

/**
 * wagmi types `chainId` as the exact union of configured chains, while
 * `useChainId()` returns a plain number. This narrows safely after the
 * `isSupportedChain` guard.
 */
export function asChainId(chainId: number): SupportedChainId {
  if (chainId === base.id) return base.id;
  return baseSepolia.id;
}

export const CHAIN_IDS = {
  base: base.id,
  baseSepolia: baseSepolia.id,
} as const;

/** Human label for a chain id, with a safe fallback. */
export function chainLabel(chainId: number): string {
  switch (chainId) {
    case base.id:
      return "Base";
    case baseSepolia.id:
      return "Base Sepolia";
    default:
      return `Chain ${chainId}`;
  }
}

export function isSupportedChain(chainId: number | undefined): chainId is SupportedChainId {
  return CHAINS.some((c) => c.id === chainId);
}

/** Basescan (BaseScan) base URL per chain, for transaction links. */
export function explorerTxUrl(chainId: number, hash: string): string {
  const host = chainId === baseSepolia.id ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${host}/tx/${hash}`;
}

export function explorerAddressUrl(chainId: number, address: string): string {
  const host = chainId === baseSepolia.id ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${host}/address/${address}`;
}
