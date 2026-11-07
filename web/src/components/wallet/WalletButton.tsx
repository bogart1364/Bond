import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { CHAINS, chainLabel, explorerAddressUrl } from "../../lib/chains";
import { escrowAddressFor, homeChainId } from "../../lib/contracts";
import { useToast } from "../ui/toast-context";
import { IconCross, IconExternal } from "../ui/Icons";

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Connect -> account menu -> one-click network switch (E02).
 * Connection failures surface as a toast, never a raw viem error.
 */
export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Escape dismisses the open account menu (the modal handles its own key).
  // Registered unconditionally: hooks must run before any early return.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!isConnected) {
    return (
      <>
        <button
          type="button"
          className="btn btn--primary"
          disabled={isPending}
          onClick={() => setPickerOpen(true)}
        >
          {isPending && <span className="spinner" aria-hidden />}
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>

        {pickerOpen && (
          <Modal onClose={() => setPickerOpen(false)} title="Connect a wallet">
            <div className="stack gap-2">
              {connectors.map((c) => (
                <button
                  key={c.uid}
                  type="button"
                  className="btn btn--secondary btn--block"
                  style={{ justifyContent: "flex-start", height: 50 }}
                  onClick={() => {
                    connect(
                      { connector: c },
                      {
                        onSuccess: () => {
                          setPickerOpen(false);
                          toast.success("Wallet connected", short(address ?? ""));
                        },
                      },
                    );
                  }}
                >
                  {c.name}
                </button>
              ))}
            </div>
            {error && (
              <div style={{ marginTop: 14 }}>
                <AlertInline
                  title="Connection failed"
                  description={error.message.split("\n")[0]}
                />
              </div>
            )}
          </Modal>
        )}
      </>
    );
  }

  const wrongNetwork = !CHAINS.some((c) => c.id === chainId);
  // Where the contract actually lives. Switching to a chain without a
  // deployment would land the user straight on the "not deployed" banner.
  const homeId = homeChainId();
  const homeLabel = chainLabel(homeId);
  // Supported chain, but no contract deployed on it (a network we do not
  // ship on yet) — same bounce, different badge.
  const noDeploy = !wrongNetwork && !escrowAddressFor(chainId);

  if ((wrongNetwork || noDeploy) && !compact) {
    return (
      <div className="row gap-2" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
        <span className="badge badge--warning">
          {wrongNetwork ? "Wrong network" : `Not on ${homeLabel}`}
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={isSwitching || chainId === homeId}
          onClick={() => switchChain({ chainId: homeId })}
        >
          {isSwitching && <span className="spinner" aria-hidden />}
          Switch to {homeLabel}
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn--secondary"
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        style={{ gap: 8 }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 0,
            background: wrongNetwork ? "var(--warning)" : "var(--success)",
          }}
        />
        {short(address!)}
      </button>

      {menuOpen && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 900 }}
            onClick={() => setMenuOpen(false)}
            aria-hidden
          />
          <div
            className="card card--flat"
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 8px)",
              width: 260,
              zIndex: 901,
              padding: 12,
              boxShadow: "var(--shadow-pop)",
            }}
          >
            <div className="small muted" style={{ padding: "4px 8px 8px" }}>
              Connected · {chainLabel(chainId)}
            </div>

            <a
              href={explorerAddressUrl(chainId, address!)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn--ghost btn--block"
              style={{ justifyContent: "flex-start" }}
              onClick={() => setMenuOpen(false)}
            >
              View on BaseScan{" "}
              <IconExternal size={13} strokeWidth={3} style={{ display: "inline", verticalAlign: "-2px" }} />
            </a>

            <div className="small muted" style={{ padding: "10px 8px 4px", fontWeight: 600 }}>
              Network
            </div>
            {CHAINS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="btn btn--ghost btn--block"
                style={{
                  justifyContent: "flex-start",
                  color: c.id === chainId ? "var(--brand)" : undefined,
                  fontWeight: c.id === chainId ? 620 : undefined,
                }}
                onClick={() => {
                  switchChain({ chainId: c.id });
                  setMenuOpen(false);
                }}
              >
                {c.name}
              </button>
            ))}

            <div style={{ borderTop: "1px solid var(--border)", margin: "8px 0 4px" }} />
            <button
              type="button"
              className="btn btn--ghost btn--block"
              style={{ justifyContent: "flex-start", color: "var(--danger-fg)" }}
              onClick={() => {
                disconnect();
                setMenuOpen(false);
                toast.neutral("Wallet disconnected");
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AlertInline({ title, description }: { title: string; description?: string }) {
  return (
    <div
      role="alert"
      style={{
        background: "var(--danger-soft)",
        border: "1px solid var(--border-ink)",
        borderLeft: "5px solid var(--danger)",
        borderRadius: 0,
        padding: "10px 12px",
        fontSize: 13,
      }}
    >
      <strong style={{ color: "var(--danger-fg)" }}>{title}</strong>
      {description && <div className="muted">{description}</div>}
    </div>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // Keep the latest onClose without re-running the key/focus effects.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Escape closes, focus enters the dialog, Tab cycles inside it, and the
  // focus returns to whatever opened it. Without this the dialog is a
  // keyboard trap: Tab escapes behind the overlay and Escape does nothing.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey) {
        if (!inside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg-overlay)",
        zIndex: 1100,
        display: "grid",
        placeItems: "center",
        padding: 20,
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(420px, 100%)", boxShadow: "var(--shadow-pop)", animation: "toastIn 200ms var(--ease)" }}
      >
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
          <h3>{title}</h3>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onClose}
            aria-label="Close"
          >
            <IconCross size={14} strokeWidth={3.5} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
