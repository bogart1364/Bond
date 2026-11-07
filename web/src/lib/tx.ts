import type { Abi, Address, Hash } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { simulateContract, writeContract } from "viem/actions";
import { isNodeSideFailure, toUserError, type UserError } from "./errors";

/**
 * Transaction state machine — drives TxButton / TxStatusCard.
 *
 *   idle -> simulating -> signing -> pending -> success | error
 *
 * The `simulating` step is the whole point (ADR-6): a revert is caught by
 * `simulateContract` BEFORE the wallet popup, so the user never signs a
 * transaction that is guaranteed to fail.
 */
export type TxPhase = "idle" | "simulating" | "signing" | "pending" | "success" | "error";

export interface TxState {
  phase: TxPhase;
  /** Set once the wallet has broadcast the transaction. */
  hash?: Hash;
  /** Populated on `error`. */
  error?: UserError;
  /** Populated on `success`. */
  receipt?: { status: "success" | "reverted"; blockNumber: bigint };
}

export const IDLE_TX: TxState = { phase: "idle" };

export interface TxContext {
  /** Loosely typed: wagmi binds the client to a concrete chain, and viem's
   *  block types differ per chain — `any` keeps this assignment-safe. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: PublicClient<any, any>;
  walletClient: WalletClient;
  account: Address;
  chainId: number;
  /** Called after a successful receipt so callers can refresh reads. */
  onSuccess?: (hash: Hash) => void;
}

export interface WriteArgs {
  abi: Abi;
  address: Address;
  functionName: string;
  args?: readonly unknown[];
  /** ERC-20 approve amount override (defaults to contract amount). */
  value?: bigint;
}

export type SetTxState = (s: TxState) => void;

export interface TxResult {
  ok: boolean;
  hash?: Hash;
  error?: UserError;
}

/**
 * Simulate -> sign -> send -> wait.
 *
 * Every failure is normalized through `toUserError`, so callers only ever
 * deal with matrix entries (E01–E12), never raw viem objects.
 */
export async function runTx(args: WriteArgs, ctx: TxContext, setState: SetTxState): Promise<TxResult> {
  // ── Layer 2: pre-flight ────────────────────────────────
  setState({ phase: "simulating" });
  try {
    const params = {
      account: ctx.account,
      address: args.address,
      abi: args.abi,
      functionName: args.functionName,
      args: (args.args ?? []) as never,
      value: args.value,
      chain: null,
    } as never;

    let simulated: Awaited<ReturnType<typeof simulateContract>>;
    try {
      simulated = await simulateContract(ctx.publicClient, params);
    } catch (err) {
      // One automatic re-simulation, but only when the node failed to answer
      // (no selector, no reason, no panic). A genuine revert always carries a
      // payload and is surfaced immediately — never retried into silence.
      if (!isNodeSideFailure(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 700));
      simulated = await simulateContract(ctx.publicClient, params);
    }
    const { request } = simulated;

    // ── Layer 3: wallet popup ────────────────────────────
    setState({ phase: "signing" });
    let hash: Hash;
    try {
      hash = await writeContract(ctx.walletClient, request as never);
    } catch (err) {
      const error = toUserError(err);
      setState({ phase: "error", error });
      return { ok: false, error };
    }

    // ── Layer 3: broadcast & confirm ─────────────────────
    setState({ phase: "pending", hash });
    try {
      const receipt = await ctx.publicClient.waitForTransactionReceipt({
        hash,
        timeout: 120_000,
      });

      if (receipt.status === "reverted") {
        // Mined but reverted: a contract verdict, not a network one. E10 is
        // reserved for "dropped or replaced" — using it here used to blur
        // two very different failures into one code.
        const error: UserError = {
          code: "E06",
          layer: 3,
          kind: "error",
          title: "The transaction reverted on-chain",
          description:
            "The transaction was mined, the contract rejected it, and it reverted. Only gas was spent — no escrow funds moved. It is safe to try again.",
          actionLabel: "Try again",
          retryable: true,
          details: hash,
        };
        setState({ phase: "error", hash, error });
        return { ok: false, hash, error };
      }

      setState({
        phase: "success",
        hash,
        receipt: { status: receipt.status, blockNumber: receipt.blockNumber },
      });
      ctx.onSuccess?.(hash);
      return { ok: true, hash };
    } catch (err) {
      const error = toUserError(err);
      setState({ phase: "error", hash, error });
      return { ok: false, hash, error };
    }
  } catch (err) {
    const error = toUserError(err);
    setState({ phase: "error", error });
    return { ok: false, error };
  }
}

/** Read helper that funnels RPC failures into the matrix (E08). */
export async function runRead<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toUserError(err);
  }
}
