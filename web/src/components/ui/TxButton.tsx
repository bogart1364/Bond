import type { ReactNode } from "react";
import type { TxState } from "../../lib/tx";

interface TxButtonProps {
  label: string;
  state: TxState;
  onClick: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** Shown in place of `label` while simulating/signing/pending. */
  busyLabel?: string;
  children?: ReactNode;
  block?: boolean;
}

const PHASE_TEXT: Record<string, string> = {
  simulating: "Checking…",
  signing: "Confirm in wallet…",
  pending: "Confirming…",
};

/**
 * Button with an internal transaction lifecycle. The label changes at each
 * phase so the user always knows what is happening and never double-clicks.
 */
export function TxButton({
  label,
  state,
  onClick,
  variant = "primary",
  disabled = false,
  busyLabel,
  block = false,
}: TxButtonProps) {
  const busy = state.phase === "simulating" || state.phase === "signing" || state.phase === "pending";
  const text = busy ? (busyLabel ?? PHASE_TEXT[state.phase] ?? "Working…") : label;

  return (
    <button
      type="button"
      className={`btn btn--${variant} ${block ? "btn--block" : ""} ${busy ? "btn--loading" : ""}`}
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
    >
      {busy && <span className="spinner" aria-hidden />}
      {text}
    </button>
  );
}
