import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconCross, IconDot, IconWarning } from "./Icons";
import { ToastCtx, type ToastApi, type ToastItem, type ToastTone } from "./toast-context";

/**
 * Toast stack — top-right, auto-dismiss.
 *
 * Neutral outcomes (E03 user declined a signature) use the neutral tone on
 * purpose: declining is not an error and must not look like one.
 */

/** Tone -> engraved glyph. Icons, never emoji — see Icons.tsx. */
const TONE_STYLE: Record<ToastTone, { bg: string; border: string; fg: string; icon: ReactNode }> = {
  neutral: { bg: "var(--bg-card)", border: "var(--border-strong)", fg: "var(--text-1)", icon: <IconDot size={12} /> },
  success: { bg: "var(--success-soft)", border: "var(--success-border)", fg: "var(--success-fg)", icon: <IconCheck size={13} strokeWidth={4} /> },
  warning: { bg: "var(--warning-soft)", border: "var(--warning-border)", fg: "var(--warning-fg)", icon: <IconWarning size={13} strokeWidth={3.5} /> },
  error: { bg: "var(--danger-soft)", border: "var(--danger-border)", fg: "var(--danger-fg)", icon: <IconCross size={12} strokeWidth={4} /> },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: Omit<ToastItem, "id">) => {
      const id = nextId.current++;
      setItems((prev) => [...prev.slice(-3), { ...t, id }]);
      window.setTimeout(() => remove(id), 5000);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, description) => push({ tone: "success", title, description }),
      warning: (title, description) => push({ tone: "warning", title, description }),
      error: (title, description) => push({ tone: "error", title, description }),
      neutral: (title, description) => push({ tone: "neutral", title, description }),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          top: "calc(var(--nav-height) + 16px)",
          right: 20,
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          width: "min(360px, calc(100vw - 40px))",
          pointerEvents: "none",
        }}
      >
        {items.map((t) => {
          const s = TONE_STYLE[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === "error" ? "alert" : "status"}
              onClick={() => remove(t.id)}
              style={{
                pointerEvents: "auto",
                cursor: "pointer",
                background: s.bg,
                border: `1px solid ${s.border}`,
                borderLeft: `3px solid ${s.fg}`,
                boxShadow: "var(--shadow-pop)",
                padding: "15px 17px",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                animation: "toastIn 240ms var(--ease)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 20,
                  height: 20,
                  background: s.fg,
                  color: "#fff",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                {s.icon}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
                  <span style={{ fontWeight: 650, fontSize: "var(--text-sm)", color: s.fg }}>{t.title}</span>
                  <span
                    className="mono"
                    style={{ fontSize: 9.5, letterSpacing: "0.14em", color: s.fg, opacity: 0.7 }}
                  >
                    {t.tone.toUpperCase()}
                  </span>
                </div>
                {t.description && (
                  <div style={{ fontSize: 13, color: "var(--text-2)", marginTop: 3, lineHeight: 1.55 }}>
                    {t.description}
                  </div>
                )}
              </div>
              {/* Real button, not just a clickable div: toasts must be
                  dismissible from the keyboard (Escape / Enter / Space). */}
              <button
                type="button"
                aria-label={`Dismiss: ${t.title}`}
                onClick={() => remove(t.id)}
                style={{
                  background: "transparent",
                  border: "1px solid transparent",
                  color: s.fg,
                  cursor: "pointer",
                  padding: "0 2px",
                  lineHeight: 1,
                  flexShrink: 0,
                  opacity: 0.7,
                }}
              >
                <IconCross size={13} strokeWidth={3.5} />
              </button>
            </div>
          );
        })}
      </div>
      <style>{`@keyframes toastIn{from{opacity:0;transform:translateY(-8px) scale(.97)}to{opacity:1;transform:none}}`}</style>
    </ToastCtx.Provider>
  );
}
