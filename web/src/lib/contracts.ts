import type { Address, Abi } from "viem";
import { CHAIN_IDS, type SupportedChainId } from "./chains";
import escrowAbiJson from "./abi.json";

/**
 * EscrowLink deployment addresses.
 *
 * Set at build time:
 *   VITE_ESCROW_ADDRESS_BASE_SEPOLIA=0x…
 *   VITE_ESCROW_ADDRESS_BASE=0x…
 *
 * A network without an address simply reports `undefined` and the UI shows
 * the "not deployed here" state instead of failing.
 */
export const ESCROW_ADDRESS: Partial<Record<number, Address>> = {
  [CHAIN_IDS.base]: (import.meta.env.VITE_ESCROW_ADDRESS_BASE as Address | undefined) ?? undefined,
  [CHAIN_IDS.baseSepolia]: (import.meta.env.VITE_ESCROW_ADDRESS_BASE_SEPOLIA as Address | undefined) ?? undefined,
};

export function escrowAddressFor(chainId: number | undefined): Address | undefined {
  if (chainId === undefined) return undefined;
  return ESCROW_ADDRESS[chainId];
}

/**
 * The chain Bond is actually deployed on — the target for every
 * "Switch network" action. Prefers Base mainnet once it carries a
 * deployment, otherwise Base Sepolia.
 *
 * Hard-coding Base mainnet here used to bounce users onto a chain with
 * no contract: the wallet switched, the "not deployed" banner appeared
 * immediately, and the app looked broken.
 */
export function homeChainId(): SupportedChainId {
  if (ESCROW_ADDRESS[CHAIN_IDS.base]) return CHAIN_IDS.base;
  return CHAIN_IDS.baseSepolia;
}

export const ESCROW_ABI = escrowAbiJson as Abi;

/** Canonical USDC on Base — matches script/Deploy.s.sol. */
export const USDC_ADDRESS: Partial<Record<number, Address>> = {
  [CHAIN_IDS.base]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [CHAIN_IDS.baseSepolia]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export function usdcAddressFor(chainId: number | undefined): Address | undefined {
  if (chainId === undefined) return undefined;
  return USDC_ADDRESS[chainId];
}

/** USDC uses 6 decimals on every chain. */
export const USDC_DECIMALS = 6;

export const FEE_BPS = 50; // 0.5% — read from the contract at runtime; this is the default.

/** State enum — mirrors EscrowLink.State. */
export const EscrowState = {
  None: 0,
  Created: 1,
  Funded: 2,
  Disputed: 3,
  Completed: 4,
  Cancelled: 5,
  Refunded: 6,
} as const;

export type EscrowStateName = keyof typeof EscrowState;

export const ESCROW_STATE_NAMES: EscrowStateName[] = [
  "None",
  "Created",
  "Funded",
  "Disputed",
  "Completed",
  "Cancelled",
  "Refunded",
];

export interface EscrowRecord {
  payer: Address;
  payee: Address;
  arbiter: Address;
  amount: bigint;
  feeBps: number;
  deadline: number;
  createdAt: number;
  state: number;
  description: string;
}

/** Shareable link — `?escrow=<id>` on the deployed origin. */
export function buildEscrowLink(origin: string, id: number | bigint): string {
  return `${origin}?escrow=${String(id)}`;
}

export function parseEscrowLink(search: string): bigint | null {
  const params = new URLSearchParams(search);
  const raw = params.get("escrow");
  if (!raw) return null;
  try {
    const id = BigInt(raw);
    return id > 0n ? id : null;
  } catch {
    return null;
  }
}
