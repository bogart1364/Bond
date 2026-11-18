/**
 * Shared press-room form furniture used by both creation entrypoints:
 * the one-click preset row and the "Specification" table in the hero.
 *
 * Lives apart from `CreateEscrowView` so the payment-request builder can
 * use them without importing the whole create chunk (it is lazy-loaded on
 * its own route).
 */

/** One row of pill buttons: a preset label, an active value, a callback. */
export function PresetRow({
  label,
  options,
  active,
  onPick,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  active: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span
        className="mono"
        style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)" }}
      >
        {label}
      </span>
      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {options.map((o) => {
          const isActive = active === o.value;
          return (
            <button
              key={o.value}
              type="button"
              className={`mono tnum ${isActive ? "preset preset--on" : "preset"}`}
              aria-pressed={isActive}
              onClick={() => onPick(o.value)}
              style={{ fontSize: 11, letterSpacing: "0.06em" }}
            >
              {o.label}
            </button>
          );
        })}
      </span>
    </div>
  );
}

/** One row of the architectural spec table. */
export function SpecRow({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div
      className="row"
      style={{
        justifyContent: "space-between",
        gap: 16,
        padding: "10px 14px",
        borderBottom: last ? "none" : "1px solid var(--border)",
      }}
    >
      <span className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-3)" }}>
        {k}
      </span>
      <span className="mono tnum" style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-1)" }}>
        {v}
      </span>
    </div>
  );
}
