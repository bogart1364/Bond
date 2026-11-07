import { useState } from "react";
import { AlertBox } from "../../components/ui/AlertBox";
import { Badge } from "../../components/ui/Feedback";
import { IconCheck, IconExternal } from "../../components/ui/Icons";
import { useToast } from "../../components/ui/toast-context";
import { escrowAddressFor, ESCROW_ABI } from "../../lib/contracts";
import { useChainId, useReadContract } from "wagmi";

interface Props {
  id: bigint;
  link: string;
  onReset: () => void;
}

/**
 * Success screen: the whole point of the product is a copyable link, so it
 * gets the largest, most obvious treatment on the page.
 */
export function EscrowCreatedCard({ id, link, onReset }: Props) {
  const toast = useToast();
  const chainId = useChainId();
  const contract = escrowAddressFor(chainId);
  const [copied, setCopied] = useState(false);

  const { data } = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "getEscrow",
    args: [id],
    chainId,
    query: { enabled: !!contract },
  });

  // uint256 decodes as bigint — normalize before any date maths.
  const raw = data as
    | { payer: string; payee: string; amount: bigint; deadline: number | bigint; state: number }
    | undefined;
  const record = raw ? { ...raw, deadline: Number(raw.deadline) } : undefined;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("Link copied");
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.warning("Copy failed", "Select the link and copy it manually.");
    }
  }

  function share() {
    if (navigator.share) {
      void navigator.share({ title: "Bond escrow", url: link }).catch(() => undefined);
    } else {
      void copy();
    }
  }

  return (
    <div className="stack gap-6" style={{ maxWidth: 720, margin: "0 auto" }}>
      <AlertBox
        variant="success"
        title="Escrow created"
        description="This escrow is waiting to be funded. Share the link with the payer."
      />

      <div className="card" style={{ padding: 28 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
          <div className="row gap-3">
            <span
              aria-hidden
              style={{
                width: 44,
                height: 44,
                borderRadius: 0,
                background: "var(--success-fg)",
                color: "#fff",
                display: "grid",
                placeItems: "center",
              }}
            >
              <IconCheck size={24} strokeWidth={4} />
            </span>
            <div>
              <h2 style={{ fontSize: "var(--text-lg)" }}>Your escrow link</h2>
              <div className="small muted">Escrow #{id.toString()}</div>
            </div>
          </div>
          <Badge tone="warning">Awaiting funding</Badge>
        </div>

        {/* ── The link ─────────────────────────────────── */}
        <div
          className="row gap-3"
          style={{
            background: "var(--bg-inset)",
            border: "1px dashed var(--border-strong)",
            borderRadius: 0,
            padding: "14px 16px",
            flexWrap: "wrap",
          }}
        >
          <code
            className="mono truncate"
            style={{ flex: "1 1 260px", fontSize: 13.5, color: "var(--text-1)", wordBreak: "break-all" }}
          >
            {link}
          </code>
          <div className="row gap-2">
            <button type="button" className="btn btn--primary btn--sm" onClick={copy}>
              {copied ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Copied <IconCheck size={13} strokeWidth={4} />
                </span>
              ) : (
                "Copy link"
              )}
            </button>
            <button type="button" className="btn btn--secondary btn--sm" onClick={share}>
              Share
            </button>
          </div>
        </div>

        {/* ── Summary ──────────────────────────────────── */}
        {record && (
          <dl
            className="stack gap-3"
            style={{ margin: "20px 0 0", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}
          >
            <Summary label="Amount">
              <span className="tnum">{formatAmount(record.amount)}</span>
            </Summary>
            <Summary label="Payer" mono>
              {record.payer}
            </Summary>
            <Summary label="Payee" mono>
              {record.payee}
            </Summary>
            <Summary label="Deadline">
              {new Date(record.deadline * 1000).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </Summary>
          </dl>
        )}
      </div>

      <AlertBox
        variant="info"
        title="Next step: fund the escrow"
        description="Open the link as the payer, approve USDC, and lock the amount. Only then can the payee deliver and the payer release."
      />

      <div className="row gap-3" style={{ justifyContent: "center" }}>
        <button type="button" className="btn btn--secondary" onClick={() => window.open(link, "_blank", "noopener")}>
          Open link <IconExternal size={14} strokeWidth={3} />
        </button>
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Create another
        </button>
      </div>
    </div>
  );
}

function Summary({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt className="small muted" style={{ fontWeight: 550, marginBottom: 4 }}>
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          fontSize: 14,
          color: "var(--text-1)",
          fontWeight: 570,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: mono ? "var(--font-mono)" : undefined,
        }}
      >
        {children}
      </dd>
    </div>
  );
}

function formatAmount(v: bigint): string {
  const base = 10n ** 6n;
  const whole = v / base;
  const frac = (v % base).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac} USDC` : `${whole} USDC`;
}
