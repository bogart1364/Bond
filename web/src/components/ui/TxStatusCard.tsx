import { useEffect, useState } from "react";
import type { TxState } from "../../lib/tx";
import { explorerTxUrl } from "../../lib/chains";
import { AlertBox } from "./AlertBox";
import { IconExternal } from "./Icons";

interface TxStatusCardProps {
  state: TxState;
  chainId: number;
  /** Reset back to idle (e.g. when the user dismisses). */
  onReset?: () => void;
  /** Shown in the success state. */
  successTitle?: string;
  successDescription?: string;
}

/**
 * TxStatusCard — live transaction feedback (E09 pending, E03/E06 errors).
 * Shows a running timer while pending so a slow network feels intentional
 * rather than broken.
 *
 * The body is keyed by phase+hash: a new transaction remounts it, so the
 * elapsed counter restarts at zero without resetting state inside an effect.
 */
export function TxStatusCard(props: TxStatusCardProps) {
  if (props.state.phase === "idle") return null;
  const key = props.state.hash ?? props.state.phase;
  return <TxStatusBody key={key} {...props} />;
}

function TxStatusBody({ state, chainId, onReset, successTitle, successDescription }: TxStatusCardProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (state.phase !== "pending") return;
    const started = Date.now();
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [state.phase, state.hash]);

  if (state.phase === "error") {
    const e = state.error!;
    return (
      <AlertBox
        variant={e.kind === "warning" ? "warning" : "error"}
        code={e.code}
        title={e.title}
        description={e.description}
        details={e.details}
        action={
          onReset
            ? { label: e.actionLabel ?? "Dismiss", onClick: onReset }
            : undefined
        }
        secondaryAction={state.hash ? { label: "View on BaseScan", onClick: () => window.open(explorerTxUrl(chainId, state.hash!), "_blank", "noopener") } : undefined}
        onDismiss={onReset}
      />
    );
  }

  if (state.phase === "success") {
    return (
      <AlertBox
        variant="success"
        title={successTitle ?? "Transaction confirmed"}
        description={
          <>
            {successDescription}
            {state.hash && (
              <>
                {" "}
                <a href={explorerTxUrl(chainId, state.hash)} target="_blank" rel="noopener noreferrer">
                  View on BaseScan
                </a>
              </>
            )}
          </>
        }
        action={onReset ? { label: "Done", onClick: onReset } : undefined}
      />
    );
  }

  // simulating | signing | pending
  const copy: Record<string, { title: string; desc: string }> = {
    simulating: {
      title: "Checking this transaction",
      desc: "Simulating against the contract before asking you to sign. Nothing is sent yet.",
    },
    signing: {
      title: "Waiting for your signature",
      desc: "Approve the request in your wallet to continue.",
    },
    pending: {
      title: `Confirming on Base… ${elapsed}s`,
      desc: "Your transaction is in the mempool. This usually takes a few seconds.",
    },
  };

  const c = copy[state.phase];

  return (
    <div
      className="card card--flat"
      style={{
        padding: 18,
        display: "flex",
        gap: 14,
        alignItems: "flex-start",
        borderColor: "var(--info-border)",
        background: "var(--info-soft)",
        borderLeft: "4px solid var(--info)",
      }}
    >
      <span className="spinner" style={{ color: "var(--info)", marginTop: 4 }} aria-hidden />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="row" style={{ gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ fontWeight: 650, fontSize: "var(--text-base)", color: "var(--info-fg)" }}>{c.title}</span>
          <span
            className="mono"
            style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--info-fg)", opacity: 0.8 }}
          >
            {state.phase === "pending" ? "E09 · BROADCAST" : "PRE-FLIGHT"}
          </span>
        </div>
        <div className="small muted" style={{ marginTop: 5, lineHeight: 1.6 }}>
          {c.desc}
        </div>
        {state.hash && (
          <div style={{ marginTop: 10, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mono truncate" style={{ fontSize: 11.5, color: "var(--text-3)", maxWidth: 260 }}>
              {state.hash}
            </span>
            <a
              href={explorerTxUrl(chainId, state.hash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                fontWeight: 500,
                display: "inline-flex",
                gap: 5,
                alignItems: "center",
              }}
            >
              BaseScan
              <IconExternal size={11} strokeWidth={3} />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
