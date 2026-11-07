import type { CSSProperties, ReactNode } from "react";
import { IconMissingRecord } from "./Icons";

/* ── Badge: one color + one icon per escrow state ───────── */

export type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/* ── Skeleton: replaces spinners for content loading ────── */

export function Skeleton({ w = "100%", h = 16, r = 8 }: { w?: number | string; h?: number; r?: number }) {
  return <div className="skeleton" style={{ width: w, height: h, borderRadius: r }} aria-hidden />;
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card" aria-busy="true" aria-label="Loading">
      <Skeleton w={140} h={12} />
      <div style={{ height: 14 }} />
      <Skeleton w="70%" h={26} r={10} />
      <div style={{ height: 20 }} />
      <div className="stack gap-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} w={`${85 - i * 12}%`} h={12} />
        ))}
      </div>
    </div>
  );
}

/* ── EmptyState: no data, no links, read failures ───────── */

interface EmptyStateProps {
  /** A glyph or a full <svg> from components/ui/Icons. */
  icon?: ReactNode;
  /** Small typewriter label above the title. Omit it when nothing
   *  honest can be said — never ship a placeholder like "Empty state". */
  eyebrow?: string;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void };
}

export function EmptyState({ icon = <IconMissingRecord size={30} strokeWidth={3} />, eyebrow, title, description, action, secondary }: EmptyStateProps) {
  return (
    <div
      className="card card--tick empty-state"
      style={{
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
      }}
    >
      <div
        aria-hidden
        className="mono"
        style={
          {
            width: 52,
            height: 52,
            background: "var(--bg-ink)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 20,
            // Icons.tsx glyphs that must occlude their own plate fill with
            // this — matches the plate's background exactly.
            "--icon-bg": "var(--bg-ink)",
          } as CSSProperties
        }
      >
        {icon}
      </div>
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h2 style={{ fontSize: "clamp(24px, 7vw, var(--text-xl))" }}>{title}</h2>
      <p className="muted" style={{ maxWidth: 460, fontSize: "var(--text-sm)", lineHeight: 1.7 }}>
        {description}
      </p>
      {(action || secondary) && (
        <div className="row gap-3" style={{ marginTop: 12, flexWrap: "wrap", justifyContent: "center" }}>
          {action && (
            <button type="button" className="btn btn--primary" onClick={action.onClick}>
              {action.label}
            </button>
          )}
          {secondary && (
            <button type="button" className="btn btn--secondary" onClick={secondary.onClick}>
              {secondary.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
