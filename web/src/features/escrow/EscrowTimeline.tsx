import { useEffect, useState, type ReactNode } from "react";
import { usePublicClient } from "wagmi";
import { AlertBox } from "../../components/ui/AlertBox";
import { Skeleton } from "../../components/ui/Feedback";
import {
  IconCheck,
  IconCreated,
  IconCross,
  IconExternal,
  IconLock,
  IconRefund,
  IconScales,
  IconWarning,
} from "../../components/ui/Icons";
import { escrowAddressFor } from "../../lib/contracts";
import { getEscrowTimeline, type TimelineEntry } from "../../lib/activity";
import { explorerTxUrl, asChainId } from "../../lib/chains";
import { formatUsdc, shortAddress } from "../../lib/format";

/**
 * Escrow timeline — the public audit trail.
 *
 * Every lifecycle event carries a tx hash, so anyone (payer, payee, arbiter,
 * or a stranger holding the link) can see exactly what happened, when, and
 * verify it on the explorer. This is the "how do I check this myself" part:
 * the UI no longer asks for trust, it shows receipts.
 */

const COPY: Record<TimelineEntry["kind"], (e: TimelineEntry) => string> = {
  EscrowCreated: (e) =>
    `Escrow created — ${formatUsdc(e.amount ?? 0n)} USDC to ${shortAddress(e.payee ?? "0x")}`,
  EscrowFunded: () => "Payer locked the funds into the contract",
  EscrowCancelled: () => "Payer cancelled before funding — nothing was locked",
  EscrowConfirmed: (e) =>
    `Payer confirmed delivery — ${formatUsdc(e.payeeAmount ?? 0n)} USDC paid to the payee, ${formatUsdc(e.fee ?? 0n)} USDC protocol fee`,
  EscrowRefunded: (e) =>
    e.byTimeout
      ? "Deadline + 48h grace passed — payer reclaimed the funds"
      : "Funds returned to the payer",
  DisputeOpened: (e) => `Dispute opened by ${shortAddress(e.by ?? "0x")}`,
  DisputeResolved: (e) =>
    `Arbiter resolved — payee ${formatUsdc(e.payeeAmount ?? 0n)}, payer ${formatUsdc(
      e.payerAmount ?? 0n,
    )}, fee ${formatUsdc(e.fee ?? 0n)}`,
};

/** Engraved mark per event kind — SVG glyphs, never emoji (see Icons.tsx). */
const KIND_MARK: Record<TimelineEntry["kind"], ReactNode> = {
  EscrowCreated: <IconCreated size={16} strokeWidth={3} />,
  EscrowFunded: <IconLock size={16} strokeWidth={3} />,
  EscrowCancelled: <IconCross size={16} strokeWidth={3.5} />,
  EscrowConfirmed: <IconCheck size={16} strokeWidth={3.5} />,
  EscrowRefunded: <IconRefund size={16} strokeWidth={3} />,
  DisputeOpened: <IconWarning size={16} strokeWidth={3} />,
  DisputeResolved: <IconScales size={16} strokeWidth={3} />,
};

export function EscrowTimeline({
  id,
  chainId,
  refreshToken,
}: {
  id: bigint;
  chainId: number;
  /** Bump to re-scan (parent passes escrow state) so new events show up live. */
  refreshToken?: string | number;
}) {
  // Must bind to the active chain: a bare usePublicClient() defaults to the
  // first configured chain (Base mainnet) and silently returns no events.
  const publicClient = usePublicClient({ chainId: asChainId(chainId) });
  const contract = escrowAddressFor(chainId);

  const [entries, setEntries] = useState<{ id: string; rows: TimelineEntry[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

  // Identity resets the list (a different escrow starts empty); the scan key
  // also folds in refreshToken, so a re-scan drops the previous alert the way
  // a fresh attempt should — all derived in render, none reset in the effect.
  const identity = `${chainId}:${contract ?? "none"}:${id.toString()}`;
  const scanKey = `${identity}:${refreshToken ?? ""}`;

  useEffect(() => {
    if (!publicClient || !contract) return;
    const ac = new AbortController();
    getEscrowTimeline(publicClient, contract, id, chainId)
      .then((rows) => {
        if (ac.signal.aborted) return;
        setEntries({ id: identity, rows });
        setFailure(null);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setFailure({ key: scanKey, message: e instanceof Error ? e.message : "Timeline unavailable." });
      });
    return () => ac.abort();
    // Re-run when the escrow state changes so the new event appears without
    // a reload; a failed scan keeps showing its alert instead of blanking.
  }, [publicClient, contract, id, chainId, refreshToken, identity, scanKey]);

  const rows = entries?.id === identity ? entries.rows : null;
  const error = failure?.key === scanKey ? failure.message : null;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h3>Timeline</h3>
        <span className="eyebrow">from event logs</span>
      </div>
      <p className="small muted" style={{ marginBottom: 16 }}>
        Every line below is an on-chain event — click a tx to verify it on the explorer yourself.
      </p>

      {error && (
        <AlertBox
          variant="warning"
          title="Timeline could not be loaded"
          description="The RPC refused the log query. The escrow itself is unaffected."
          details={error}
        />
      )}

      {rows === null && !error && (
        <div className="stack gap-3">
          <Skeleton h={18} w="80%" />
          <Skeleton h={18} w="65%" />
          <Skeleton h={18} w="70%" />
        </div>
      )}

      {rows !== null && rows.length === 0 && (
        <p className="small muted">No events found for this escrow yet.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <ol className="stack gap-0" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((e, i) => (
            <li
              key={`${e.txHash}-${i}`}
              style={{
                display: "grid",
                gridTemplateColumns: "26px 1fr auto",
                gap: 12,
                padding: "11px 0",
                borderTop: i === 0 ? "none" : "1px solid var(--border)",
                alignItems: "start",
              }}
            >
              <span
                aria-hidden
                style={{ display: "grid", placeItems: "center", height: 20, color: "var(--text-2)" }}
              >
                {KIND_MARK[e.kind]}
              </span>

              <div className="stack gap-1" style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 620, fontSize: "var(--text-sm)" }}>{COPY[e.kind](e)}</span>
                <span className="small muted mono">
                  {e.timestamp
                    ? new Date(e.timestamp * 1000).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : `block #${e.blockNumber.toString()}`}
                </span>
              </div>

              <a
                href={explorerTxUrl(chainId, e.txHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="small mono"
                style={{ color: "var(--brand)", fontWeight: 700, whiteSpace: "nowrap", display: "inline-flex", gap: 4, alignItems: "center" }}
              >
                {e.txHash.slice(0, 8)}…
                <IconExternal size={11} strokeWidth={3} />
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
