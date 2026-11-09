import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useAccount, useChainId, useReadContract, useSwitchChain } from "wagmi";
import { WalletButton } from "../components/wallet/WalletButton";
import { AlertBox } from "../components/ui/AlertBox";
import { CardSkeleton } from "../components/ui/Feedback";
import { LandingView } from "../features/landing/LandingView";
import { DocsView } from "../features/docs/DocsView";
import { isDocSlug, DOC_TITLES, DOC_FOLIO, type DocSlug } from "../features/docs/docsMeta";
import { IconExternal, IconMenu } from "../components/ui/Icons";
import { escrowAddressFor, ESCROW_ABI, parseEscrowLink, homeChainId } from "../lib/contracts";
import { isSupportedChain, chainLabel, explorerAddressUrl } from "../lib/chains";
import { shortAddress } from "../lib/format";
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
  const { isConnected, address } = useAccount();

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

  // The landing prints the full colophon; every other page gets the strip
  // footer carrying this page's own folio instead of the site-wide links.
  const isLanding = escrowId === null && !showRecords && !showDoc && !showCreate;

  const folio: PageFolio =
    escrowId !== null
      ? {
          title: `Escrow #${escrowId}`,
          detail: contract ? shortAddress(contract) : `No deployment on ${chainLabel(chainId)}`,
          detailHref: contract ? explorerAddressUrl(chainId, contract) : undefined,
        }
      : showRecords
        ? {
            title: "My records",
            detail: address ? `Inbox for ${shortAddress(address)}` : "Connect a wallet to load your records",
          }
        : showCreate
          ? { title: "Create escrow", detail: "Draft — nothing locks until the payer signs" }
          : { title: DOC_TITLES[docSlug], detail: DOC_FOLIO[docSlug] };

  return (
    <div style={{ minHeight: "100%", display: "flex", flexDirection: "column" }}>
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
              style={{ width: 26, height: 26, background: "var(--brand)" }}
            >
              {/* The escrow mark: payer [ value ] payee. */}
              <svg width="20" height="20" viewBox="0 0 64 64" fill="var(--on-brand)" focusable="false">
                <rect x="8" y="10" width="8" height="44" />
                <rect x="8" y="10" width="12" height="8" />
                <rect x="8" y="46" width="12" height="8" />
                <rect x="48" y="10" width="8" height="44" />
                <rect x="44" y="10" width="12" height="8" />
                <rect x="44" y="46" width="12" height="8" />
                <rect x="24" y="24" width="16" height="16" />
              </svg>
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

      {isLanding ? (
        <SiteFooter chainId={chainId} contract={contract} />
      ) : (
        <PageStrip chainId={chainId} contract={contract} folio={folio} />
      )}
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
          <div className="row" style={{ gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <span
              aria-hidden
              style={{
                width: 30,
                height: 30,
                background: "var(--brand)",
                display: "grid",
                placeItems: "center",
              }}
            >
              {/* The escrow mark: payer [ value ] payee. */}
              <svg width="22" height="22" viewBox="0 0 64 64" fill="var(--on-brand)" focusable="false">
                <rect x="8" y="10" width="8" height="44" />
                <rect x="8" y="10" width="12" height="8" />
                <rect x="8" y="46" width="12" height="8" />
                <rect x="48" y="10" width="8" height="44" />
                <rect x="44" y="10" width="12" height="8" />
                <rect x="44" y="46" width="12" height="8" />
                <rect x="24" y="24" width="16" height="16" />
              </svg>
            </span>
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 40,
                fontWeight: 400,
                letterSpacing: "-0.01em",
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

        {/* The stack: official marks of the brands Bond runs on */}
        <div className="footer-brands">
          <span className="footer-brands__label">Built on</span>
          <ul className="footer-brands__list">
            <li>
              <a
                className="footer-brands__item"
                href="https://base.org"
                target="_blank"
                rel="noopener noreferrer"
              >
                {/* Base: the notched disc, official geometry. */}
                <svg width="16" height="16" viewBox="10 10 27.7563 27.7563" fill="none" aria-hidden focusable="false">
                  <path
                    d="M23.8539 37.7563C31.532 37.7563 37.7563 31.5428 37.7563 23.8782C37.7563 16.2135 31.532 10 23.8539 10C16.5695 10 10.5935 15.5928 10 22.7116H28.3757V25.0447H10C10.5935 32.1635 16.5695 37.7563 23.8539 37.7563Z"
                    fill="#0052FF"
                  />
                </svg>
                Base
                <span className="footer-brands__meta">Chain 8453</span>
              </a>
            </li>
            <li>
              <a
                className="footer-brands__item"
                href="https://www.circle.com/usdc"
                target="_blank"
                rel="noopener noreferrer"
              >
                {/* USDC: Circle's coin, official #2775ca. */}
                <svg width="16" height="16" viewBox="0 0 2000 2000" aria-hidden focusable="false">
                  <path
                    d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z"
                    fill="#2775ca"
                  />
                  <path
                    d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z"
                    fill="#fff"
                  />
                  <path
                    d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z"
                    fill="#fff"
                  />
                </svg>
                USDC
                <span className="footer-brands__meta">Settles it</span>
              </a>
            </li>
            <li>
              <a
                className="footer-brands__item"
                href="https://www.openzeppelin.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                {/* OpenZeppelin: the three bands, monochrome on plate. */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="var(--plate-bright)"
                  aria-hidden
                  focusable="false"
                >
                  <path d="M22.783 24H9.317l2.196-3.69a5.23 5.23 0 0 1 4.494-2.558h6.775ZM1.217 0h21.566l-3.718 6.247H1.217ZM9.76 9.763a5.73 5.73 0 0 1 4.92-2.795h4.01L8.498 24h-7.26Z" />
                </svg>
                OpenZeppelin
                <span className="footer-brands__meta">Contract libs</span>
              </a>
            </li>
          </ul>
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

/* ── Strip footer: the page's own folio line ────────────── */

interface PageFolio {
  title: string;
  detail: string;
  /** When the folio names something on-chain, it links to it. */
  detailHref?: string;
}

/**
 * Everything except the landing keeps the footer's press skin — ink plate,
 * double rule, mono caps — but prints this page's folio instead of the
 * site-wide link farm: what the page is, where its record lives, and the
 * same truthful deployment status the colophon claims.
 */
function PageStrip({ chainId, contract, folio }: { chainId: number; contract?: `0x${string}`; folio: PageFolio }) {
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
      <div
        className="row"
        style={{
          maxWidth: "var(--content-max)",
          margin: "0 auto",
          padding: "16px var(--gutter)",
          gap: "14px 24px",
          flexWrap: "wrap",
          justifyContent: "space-between",
        }}
      >
        {/* Identity */}
        <div className="row" style={{ gap: 10 }}>
          <span
            aria-hidden
            style={{ width: 24, height: 24, background: "var(--brand)", display: "grid", placeItems: "center" }}
          >
            <svg width="18" height="18" viewBox="0 0 64 64" fill="var(--on-brand)" focusable="false">
              <rect x="8" y="10" width="8" height="44" />
              <rect x="8" y="10" width="12" height="8" />
              <rect x="8" y="46" width="12" height="8" />
              <rect x="48" y="10" width="8" height="44" />
              <rect x="44" y="10" width="12" height="8" />
              <rect x="44" y="46" width="12" height="8" />
              <rect x="24" y="24" width="16" height="16" />
            </svg>
          </span>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 19,
              fontWeight: 400,
              letterSpacing: "-0.01em",
              lineHeight: 1,
              color: "var(--plate-title)",
            }}
          >
            Bond
          </span>
        </div>

        {/* This page's folio */}
        <div className="row" style={{ gap: 10, flexWrap: "wrap", minWidth: 0 }}>
          <span
            className="mono"
            style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--plate-bright)" }}
          >
            {folio.title}
          </span>
          <span aria-hidden style={{ color: "var(--plate-rule-strong)" }}>
            ·
          </span>
          {folio.detailHref ? (
            <a
              className="mono"
              href={folio.detailHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 10.5,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "var(--plate-addr)",
                display: "inline-flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              {folio.detail}
              <IconExternal size={11} strokeWidth={3} />
            </a>
          ) : (
            <span
              className="mono"
              style={{ fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--plate-muted)" }}
            >
              {folio.detail}
            </span>
          )}
        </div>

        {/* Colophon facts: truthful status + year */}
        <div className="row" style={{ gap: 18, flexWrap: "wrap" }}>
          <span
            className="row gap-2"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--plate-muted)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                background: contract ? "var(--success)" : "var(--plate-muted)",
                display: "inline-block",
              }}
            />
            {contract ? `Live on ${chainLabel(chainId)}` : `No deployment on ${chainLabel(chainId)}`}
          </span>
          <span
            className="mono"
            style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--plate-muted)" }}
          >
            © {COPYRIGHT_YEAR}
          </span>
        </div>
      </div>
    </footer>
  );
}
