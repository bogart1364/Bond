import type { ReactNode } from "react";
import { IconCross } from "./Icons";

/**
 * AlertBox — the single component for every error, warning, success and
 * informational message in the app (error matrix E01–E12).
 *
 * Press styling: black classified bar, rubber-stamp label, serif headline.
 * Rule: never show a raw error code or English revert text to the user.
 * Every alert = one clear sentence + one next action.
 */

export type AlertVariant = "error" | "warning" | "success" | "info";

export interface AlertAction {
  label: string;
  onClick: () => void;
}

interface AlertBoxProps {
  variant?: AlertVariant;
  title: string;
  description?: ReactNode;
  action?: AlertAction;
  secondaryAction?: AlertAction;
  /** Collapsible "What happened?" technical detail (for E06 reverts). */
  details?: string;
  onDismiss?: () => void;
  /** Matrix code, rendered in the classified bar. */
  code?: string;
  className?: string;
}

interface AlertStyle {
  rule: string;
  label: string;
}

const STYLE: Record<AlertVariant, AlertStyle> = {
  error: { rule: "var(--danger)", label: "Urgent" },
  warning: { rule: "var(--warning)", label: "Notice" },
  success: { rule: "var(--success)", label: "Confirmed" },
  info: { rule: "var(--info)", label: "Bulletin" },
};

export function AlertBox({
  variant = "info",
  title,
  description,
  action,
  secondaryAction,
  details,
  onDismiss,
  code,
  className = "",
}: AlertBoxProps) {
  const s = STYLE[variant];

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={`alertbox ${className}`}
      style={{ ["--rule" as string]: s.rule }}
    >
      {/* Classified bar */}
      <div className="alertbox__bar">
        <span>{s.label}</span>
        <span style={{ opacity: 0.55 }}>/ {code ?? "BOND"}</span>
        <span style={{ flex: 1 }} />
        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            style={{
              background: "transparent",
              border: "0",
              color: "var(--plate-bar)",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.14em",
              padding: "0 2px",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <IconCross size={10} strokeWidth={4} />
              CLOSE
            </span>
          </button>
        )}
      </div>

      {/* Rubber stamp */}
      <span aria-hidden className="alertbox__stamp" style={{ color: s.rule }}>
        {s.label}
      </span>

      <div className="alertbox__body">
        <div className="alertbox__title">{title}</div>

        {description && <div className="alertbox__desc">{description}</div>}

        {details && (
          <details className="alertbox__details">
            <summary className="alertbox__summary">What happened?</summary>
            <pre className="alertbox__pre">{details}</pre>
          </details>
        )}

        {(action || secondaryAction) && (
          <div className="alertbox__actions">
            {action && (
              <button type="button" className="btn btn--sm btn--primary" onClick={action.onClick}>
                {action.label}
              </button>
            )}
            {secondaryAction && (
              <button type="button" className="btn btn--sm btn--secondary" onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
