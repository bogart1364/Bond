import { useReadContract } from "wagmi";
import { TxButton } from "../../components/ui/TxButton";
import { Badge } from "../../components/ui/Feedback";
import { ESCROW_ABI } from "../../lib/contracts";
import { asChainId } from "../../lib/chains";
import { formatUsdc } from "../../lib/format";
import type { TxState } from "../../lib/tx";

/**
 * Milestone table — the slice ledger of a v3 escrow.
 *
 * One row per milestone: what was promised, when it was due, and whether
 * the payer has released it. Plain (v2) escrows have no slices, so this
 * card renders nothing for them — the same page serves both generations.
 *
 * Release actions are the payer's, one slice at a time; releasing the last
 * unsettled slice completes the escrow (the contract proves that, not UI).
 */

export interface MilestoneSlice {
  amount: bigint;
  /** Delivery target in unix seconds; 0 = no target. Informational only. */
  due: bigint;
  settled: boolean;
  title: string;
}

export function MilestonesCard({
  id,
  chainId,
  contract,
  feeBps,
  stateName,
  role,
  watchOnly,
  tx,
  act,
}: {
  id: bigint;
  chainId: number;
  contract?: `0x${string}`;
  feeBps: number;
  stateName: string;
  role: "payer" | "payee" | "arbiter" | "observer";
  watchOnly: boolean;
  tx: TxState;
  act: (fn: string, args: unknown[], opts?: { label?: string; success?: string }) => Promise<void>;
}) {
  const query = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "getMilestones",
    args: [id],
    chainId: asChainId(chainId),
    // Live like the escrow read: a slice released by the counterparty
    // flips to "Released" here within one poll without a manual reload.
    query: { enabled: !!contract, retry: 2, refetchInterval: 8_000 },
  });

  const slices = (query.data as MilestoneSlice[] | undefined) ?? null;
  if (!slices || slices.length === 0) return null;

  const total = slices.reduce((acc, s) => acc + s.amount, 0n);
  const releasedGross = slices.filter((s) => s.settled).reduce((acc, s) => acc + s.amount, 0n);
  const settledCount = slices.filter((s) => s.settled).length;
  const feeShare = (gross: bigint) => (gross * BigInt(feeBps)) / 10_000n;
  const canRelease = stateName === "Funded" && role === "payer" && !watchOnly;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h3>Milestones</h3>
        <span className="eyebrow">slice ledger</span>
      </div>
      <p className="small muted" style={{ marginBottom: 16 }}>
        The payer releases each slice as it lands — or confirms once to release everything that remains. A
        released slice is final: the timeout refund and any arbiter ruling only ever touch what is still open.
      </p>

      <div className="stack" style={{ gap: 0 }}>
        {slices.map((s, i) => (
          <div
            key={i}
            className="row"
            style={{
              gap: 14,
              alignItems: "center",
              padding: "13px 0",
              borderTop: i === 0 ? "1px solid var(--border)" : "none",
              borderBottom: i === slices.length - 1 ? "1px solid var(--border)" : "none",
              flexWrap: "wrap",
            }}
          >
            <span
              className="mono"
              style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: "var(--brand)", minWidth: 62 }}
            >
              Slice {String(i + 1).padStart(2, "0")}
            </span>

            <span style={{ flex: "1 1 180px", minWidth: 0 }}>
              <span style={{ fontWeight: 620, fontSize: "var(--text-sm)", display: "block" }}>
                {s.title || "Untitled milestone"}
              </span>
              <span className="small muted tnum" style={{ display: "block", marginTop: 2 }}>
                {formatUsdc(s.amount)} USDC
                {s.due > 0n ? ` · due ${new Date(Number(s.due) * 1000).toLocaleDateString()}` : " · no target date"}
                {` · fee ${formatUsdc(feeShare(s.amount))}`}
              </span>
            </span>

            <span className="row" style={{ gap: 10, alignItems: "center" }}>
              <Badge tone={s.settled ? "success" : "neutral"}>{s.settled ? "Released" : "Open"}</Badge>
              {canRelease && !s.settled && (
                <TxButton
                  label={`Release ${formatUsdc(s.amount)}`}
                  busyLabel="Releasing…"
                  state={tx}
                  onClick={() =>
                    act("confirmMilestone", [id, BigInt(i)], { success: `Milestone ${i + 1} released` })
                  }
                />
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 14, flexWrap: "wrap", gap: 8 }}>
        <span className="small muted tnum">
          {settledCount} of {slices.length} released · {formatUsdc(releasedGross)} of {formatUsdc(total)} USDC
        </span>
        {releasedGross > 0n && (
          <span className="small muted tnum">
            Still locked: {formatUsdc(total - releasedGross)} USDC (plus accrued fees on released slices)
          </span>
        )}
      </div>
    </div>
  );
}
