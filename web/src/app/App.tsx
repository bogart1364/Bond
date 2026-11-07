import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useReadContract, useSwitchChain } from "wagmi";
import { WalletButton } from "../components/wallet/WalletButton";
import { AlertBox } from "../components/ui/AlertBox";
import { CardSkeleton } from "../components/ui/Feedback";
import { LandingView } from "../features/landing/LandingView";
import { DocsView, isDocSlug, type DocSlug } from "../features/docs/DocsView";
import { IconExternal, IconMenu } from "../components/ui/Icons";
import { escrowAddressFor, ESCROW_ABI, parseEscrowLink, homeChainId } from "../lib/contracts";
import { isSupportedChain, chainLabel, explorerAddressUrl } from "../lib/chains";
import { useTheme } from "../lib/theme";
import { PAUSED_BANNER } from "../lib/errors";

// Computed once at module load: a newspaper edition line and a copyright year
// are page-load facts, not render-time state — calling Date during render is
// impure and re-renders would sample a different value.
const EDITION = new Date()
  .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
  .toUpperCase();
const COPYRIGHT_YEAR = new Date().getFullYear();

// Route-level code split: only the landing page ships in the first chunk.
// Everything else loads when its query param asks for it.
const CreateEscrowView = lazy(() => import("../features/create/CreateEscrowView").then((m) => ({ default: m.CreateEscrowView })));
const EscrowDetailView = lazy(() => import("../features/escrow/EscrowDetailView").then((m) => ({ default: m.EscrowDetailView })));
const MyRecordsView = lazy(() => import("../features/records/MyRecordsView").then((m) => ({ default: m.MyRecordsView })));

/** Fallback while a route chunk loads — same skeleton the views use. */
function RouteFallback() {
  return (
    <div className="page">
      <div className="stack gap-4" style={{ maxWidth: 760 }}>
        <CardSkeleton lines={4} />
      </div>
    </div>
  );
}

export function App() {
  const connectedChainId = useChainId();
  const { isConnected } = useAccount();

  // Disconnected users get the chain Bond actually lives on (homeChainId:
  // Base mainnet once it carries a deployment, else Base Sepolia) so the app
  // is browsable before a wallet joins the session — and never shows a
  // network we have abandoned.
  const chainId = isConnected ? connectedChainId : homeChainId();

  const escrowId = useMemo(() => parseEscrowLink(window.location.search), []);
  const search = useMemo(() => new URLSearchParams(window.location.search), []);
  const view = search.get("view");
  // `watch=1` renders the escrow record with every action hidden — the
  // variant meant for reading on a machine where nothing should be signed.
  const watchOnly = search.get("watch") === "1";
  const showRecords = view === "records";
  const showCreate = view === "create";
  const docSlug: DocSlug = isDocSlug(search.get("doc")) ? (search.get("doc") as DocSlug) : "about";
  const showDoc = view === "doc";
  const contract = escrowAddressFor(chainId);
  const supported = isSupportedChain(chainId);
  // Chain we are deployed on — the only valid switch target.
  const homeId = homeChainId();
  // Supported chain but no deployment (e.g. wallet parked on Base mainnet):
  // without this, every page silently looks empty and actions vanish.
  const noDeploy = isConnected && supported && !contract;

  // Global pause banner (E11) — read once, cheap, always visible.
  const { data: paused } = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "paused",
    chainId,
    query: { enabled: !!contract, retry: 1 },
  });

  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const wrongChain = isConnected && !supported;
  const [menuOpen, setMenuOpen] = useState(false);

  // Edition switch: day print run or Shabnameh night press.
  const { theme, toggleTheme } = useTheme();
  const themeLabel = theme === "dark" ? "DAY" : "NIGHT";
  const themeAction = theme === "dark" ? "Switch to the day edition" : "Switch to the night edition";

  // Escape folds the mobile menu back up, matching the modal behaviour.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const edition = EDITION;

  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
      {/* ── Registration marks ────────────────────────────── */}
      <div className="crop-marks" aria-hidden>
        <span className="crop crop--tl" />
        <span className="crop crop--tr" />
        <span className="crop crop--bl" />
        <span className="crop crop--br" />
      </div>

      {/* ── Masthead: newspaper nameplate ─────────────────── */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 100,
          background: "var(--bg-page)",
          borderBottom: "4px double var(--border-ink)",
          boxShadow: "0 10px 24px -24px rgba(22,19,15,0.8)",
        }}
      >
        <div
          className="mast-bar"
          style={{
            maxWidth: "var(--content-max)",
            margin: "0 auto",
            minHeight: "var(--nav-height)",
            padding: "10px var(--gutter)",
            display: "flex",
            alignItems: "center",
          }}
        >
          <a href="/" className="mast-brand">
            <span
              aria-hidden
              className="brand-chip"
              style={{
                width: 26,
                height: 26,
                background: "var(--brand)",
                color: "var(--text-inverse)",
                fontSize: 14,
                fontWeight: 900,
                fontFamily: "var(--font-display)",
                transform: "translateY(4px)",
              }}
            >
              B
            </span>
            <span className="mast-word">Bond</span>
          </a>

          <span className="mast-date">{edition}</span>

          <div style={{ flex: 1 }} />

          <nav className="mast-nav">
            <a href="?view=create">Create</a>
            <a href="?view=records">My records</a>
            <a href="/#how">How it works</a>
            <a href="?view=doc&doc=docs">Docs</a>
          </nav>

          <button
            type="button"
            className="btn btn--secondary btn--sm mast-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="mast-panel"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconMenu size={15} strokeWidth={3} />
            <span className="mast-menu-label">{menuOpen ? "Close" : "Menu"}</span>
          </button>

          <button
            type="button"
            className="btn btn--secondary btn--sm mast-theme"
            onClick={toggleTheme}
            aria-label={themeAction}
            title={themeAction}
          >
            {themeLabel}
          </button>

          <WalletButton />
        </div>

        {/* ── Mobile panel: the folded edition ─────────────── */}
        {menuOpen && (
          <div className="mast-panel" id="mast-panel">
            <div className="mast-panel__date">{edition}</div>
            <nav className="mast-panel__links" aria-label="Sections">
              <a href="?view=create" onClick={() => setMenuOpen(false)}>
                Create escrow
              </a>
              <a href="?view=records" onClick={() => setMenuOpen(false)}>
                My records
              </a>
              <a href="/#how" onClick={() => setMenuOpen(false)}>
                How it works
              </a>
              <a href="?view=doc&doc=docs" onClick={() => setMenuOpen(false)}>
                Docs
              </a>
            </nav>
            <div className="mast-panel__theme">
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={toggleTheme}
                aria-label={themeAction}
                title={themeAction}
              >
                {theme === "dark" ? "Day edition" : "Night edition"}
              </button>
            </div>
          </div>
        )}
      </header>

      {/* ── Global alerts ─────────────────────────────────── */}
      {(paused === true || wrongChain || noDeploy) && (
        <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: "20px var(--gutter) 0", width: "100%" }}>
          <div className="stack gap-3">
            {paused === true && (
              <AlertBox
                variant={PAUSED_BANNER.kind}
                code={PAUSED_BANNER.code}
                title={PAUSED_BANNER.title}
                description={PAUSED_BANNER.description}
              />
            )}
            {noDeploy ? (
              <AlertBox
                variant="warning"
                code="E02"
                title="Bond is not deployed on this network"
                description={`Your wallet is on ${chainLabel(chainId)}. The EscrowLink contract lives on ${chainLabel(homeId)} — switch the network to see your records and act on your escrows.`}
                action={{
                  label: isSwitching ? "Switching…" : `Switch to ${chainLabel(homeId)}`,
                  onClick: () => switchChain({ chainId: homeId }),
                }}
              />
            ) : (
              wrongChain && (
                <AlertBox
                  variant="warning"
                  code="E02"
                  title={`You are on ${chainLabel(chainId)}`}
                  description={`Bond runs on ${chainLabel(homeId)}. Switch your wallet there to create and settle escrows on this app.`}
                  action={{
                    label: isSwitching ? "Switching…" : `Switch to ${chainLabel(homeId)}`,
                    onClick: () => switchChain({ chainId: homeId }),
                  }}
                />
              )
            )}
          </div>
        </div>
      )}

      {/* ── Main ──────────────────────────────────────────── */}
      <main style={{ flex: 1, width: "100%" }}>
        <Suspense fallback={<RouteFallback />}>
          {escrowId !== null ? (
            <div className="page">
              <EscrowDetailView id={escrowId} chainId={chainId} watchOnly={watchOnly} />
            </div>
          ) : showRecords ? (
            <div className="page">
              <MyRecordsView chainId={chainId} onOpen={(id) => (window.location.href = `?escrow=${id}`)} />
            </div>
          ) : showDoc ? (
            <div className="page">
              <DocsView slug={docSlug} chainId={chainId} />
            </div>
          ) : showCreate ? (
            <div className="page">
              <CreateEscrowView contract={contract} chainId={chainId} />
            </div>
          ) : (
            /* Landing owns its own measure + full-bleed ticker/CTA bands. */
            <LandingView chainId={chainId} />
          )}
        </Suspense>
      </main>

      <SiteFooter chainId={chainId} contract={contract} />
    </div>
  );
}

/* ── Footer: newspaper colophon ─────────────────────────── */

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

interface FooterColumn {
  title: string;
  links: FooterLink[];
}

/**
 * Every destination is real: an in-app view, a landing anchor that exists,
 * the live contract on the explorer, the Sourcify record, the served ABI,
 * or one of the documents rendered by DocsView. No dead fragments.
 */
function columnsFor(chainId: number, contract?: `0x${string}`): FooterColumn[] {
  const explorer = contract ? explorerAddressUrl(chainId, contract) : "https://sepolia.basescan.org";
  const sourcify = contract
    ? `https://repo.sourcify.dev/contracts/full_match/${chainId}/${contract}/`
    : "https://repo.sourcify.dev/";

  return [
    {
      title: "Product",
      links: [
        { label: "Create escrow", href: "?view=create" },
        { label: "My records", href: "?view=records" },
        { label: "How it works", href: "/#how" },
        // The fee schedule lives in the docs ("Funds, custody and fees"),
        // not in the verify section this used to point at.
        { label: "Fee schedule", href: "?view=doc&doc=docs" },
      ],
    },
    {
      title: "Protocol",
      links: [
        { label: "EscrowLink contract", href: explorer, external: true },
        { label: "Verified on Sourcify", href: sourcify, external: true },
        { label: "Security model", href: "/#security" },
        { label: "Dispute & arbitration", href: "?view=doc&doc=arbitration" },
      ],
    },
    {
      title: "Developers",
      links: [
        { label: "Documentation", href: "?view=doc&doc=docs" },
        { label: "Contract ABI (JSON)", href: "/abi.json", external: true },
        { label: "Testnet explorer", href: "https://sepolia.basescan.org", external: true },
        { label: "Base developer docs", href: "https://docs.base.org", external: true },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "About", href: "?view=doc&doc=about" },
        { label: "Terms of service", href: "?view=doc&doc=terms" },
        { label: "Privacy policy", href: "?view=doc&doc=privacy" },
        { label: "Contact", href: "?view=doc&doc=contact" },
      ],
    },
  ];
}

function SiteFooter({ chainId, contract }: { chainId: number; contract?: `0x${string}` }) {
  const year = COPYRIGHT_YEAR;
  const columns = columnsFor(chainId, contract);

  return (
    <footer
      id="colophon"
      style={{
        borderTop: "4px double var(--border-ink)",
        background: "var(--bg-ink)",
        color: "var(--plate-text)",
        marginTop: "auto",
      }}
    >
      <div style={{ maxWidth: "var(--content-max)", margin: "0 auto", padding: "0 var(--gutter)" }}>
        {/* Nameplate */}
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            gap: 24,
            flexWrap: "wrap",
            padding: "34px 0 20px",
            borderBottom: "1px solid var(--plate-rule)",
          }}
        >
          <div className="row" style={{ gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
            <span
              aria-hidden
              style={{
                width: 30,
                height: 30,
                background: "var(--brand)",
                color: "var(--plate-bright)",
                display: "grid",
                placeItems: "center",
                fontSize: 16,
                fontWeight: 900,
                fontFamily: "var(--font-display)",
              }}
            >
              B
            </span>
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 44,
                fontWeight: 900,
                letterSpacing: "-0.03em",
                lineHeight: 1,
                color: "var(--plate-title)",
              }}
            >
              Bond
            </span>
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                color: "var(--plate-muted)",
              }}
            >
              The non-custodial escrow record
            </span>
          </div>

          <span
            className="mono"
            style={{ fontSize: 10.5, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--plate-muted)" }}
          >
            Vol. I — No. 1 · Printed on Base
          </span>
        </div>

        {/* Columns */}
        <div className="footer-grid">
          <div>
            <p style={{ fontSize: 15, lineHeight: 1.75, color: "var(--plate-body)", maxWidth: 340 }}>
              Non-custodial escrow infrastructure on Base. Funds are locked in open-source,
              source-verified code and released only on confirmation — never held by us.
            </p>

            <div className="row gap-2" style={{ marginTop: 22, flexWrap: "wrap" }}>
              {["Base · 8453", "USDC", "Fee 0.5%"].map((t) => (
                <span
                  key={t}
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    color: "var(--plate-chip)",
                    border: "1px solid var(--plate-rule-2)",
                    padding: "6px 10px",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <div className="footer-title">{col.title}</div>
              <ul className="footer-links">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a
                      className="footer-link"
                      href={l.href}
                      target={l.external ? "_blank" : undefined}
                      rel={l.external ? "noopener noreferrer" : undefined}
                    >
                      {l.label}
                      {l.external && <IconExternal size={11} strokeWidth={3} />}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Contract strip */}
        {contract && (
          <div
            className="row"
            style={{
              gap: 18,
              padding: "16px 0",
              borderTop: "1px solid var(--plate-rule)",
              borderBottom: "1px solid var(--plate-rule)",
              flexWrap: "wrap",
              justifyContent: "space-between",
            }}
          >
            <span
              className="mono"
              style={{ fontSize: 10.5, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--plate-muted)" }}
            >
              EscrowLink contract
            </span>
            <a
              href={explorerAddressUrl(chainId, contract)}
              target="_blank"
              rel="noopener noreferrer"
              className="mono footer-addr"
              style={{ color: "var(--plate-addr)", display: "inline-flex", gap: 6, alignItems: "center" }}
            >
              {contract}
              <IconExternal size={12} strokeWidth={3} />
            </a>
          </div>
        )}

        {/* Colophon */}
        <div
          className="row"
          style={{
            gap: 20,
            padding: "20px 0 28px",
            flexWrap: "wrap",
            justifyContent: "space-between",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--plate-muted)",
          }}
        >
          <span>© {year} Bond Protocol — All rights reserved</span>

          <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
            <span className="row gap-2">
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  background: contract ? "var(--success)" : "var(--plate-muted)",
                  display: "inline-block",
                }}
              />
              {/* Truthful by construction: we only claim what the deploy
                  config proves for this chain — never a generic
                  "all systems operational". */}
              <span>
                {contract
                  ? `Contract live on ${chainLabel(chainId)}`
                  : `No deployment on ${chainLabel(chainId)}`}
              </span>
            </span>
            <a href="?view=doc&doc=status" style={{ color: "var(--plate-chip)" }}>
              Status
            </a>
            <a href="?view=doc&doc=terms" style={{ color: "var(--plate-chip)" }}>
              Terms
            </a>
            <a href="?view=doc&doc=privacy" style={{ color: "var(--plate-chip)" }}>
              Privacy
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
