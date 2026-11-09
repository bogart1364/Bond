import { useEffect, useMemo, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import { ESCROW_ABI, escrowAddressFor } from "../../lib/contracts";
import { asChainId, chainLabel, explorerAddressUrl } from "../../lib/chains";
import { IconExternal, IconHourglass, IconInspect, IconLedger, IconTimeline } from "../../components/ui/Icons";
import { ContractVerifyCard } from "../escrow/ContractVerifyCard";
import "./landing.css";

/**
 * Landing — the front page of the paper.
 *
 * Motion language is "the press run": headlines type themselves, cards print
 * in left->right, rules draw from the margin, stamps slam down, stats roll up.
 * All of it is IntersectionObserver-driven decoration on top of content that
 * exists in the DOM from first paint — no layout shift, works without JS
 * animation, and honours prefers-reduced-motion by rendering the final frame.
 *
 * Stats read straight from the deployed contract (escrowCount, feeBps), so
 * the numbers are live on-chain facts, not marketing copy.
 */

/* ── Reveal: adds `.in` when the node scrolls into view ──── */

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  // No IntersectionObserver => nothing to wait for: start revealed instead of
  // flipping a flag inside the effect (a synchronous setState in render's wake).
  const [shown, setShown] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  return { ref, shown };
}

/** Wrapper div that plays the reveal animation. */
function Reveal({
  variant = "rise",
  delay = 0,
  className = "",
  children,
}: {
  variant?: "rise" | "print" | "draw" | "stamp";
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    // The OBSERVED node is the outer div: it must never be clipped, or
    // IntersectionObserver reports ratio 0 forever (clip-path zeroes the
    // intersection rect). The inner div owns the animation classes.
    <div ref={ref} className={className}>
      <div
        className={`ld-${variant} ${shown ? "in" : ""}`}
        style={{ "--d": `${delay}ms` } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}

/* ── Typewriter: types once, when scrolled into view ─────── */

/** Reads the OS motion preference once; subscribes only to later changes. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function useTypewriter(text: string, active: boolean, speed = 45) {
  const reduced = usePrefersReducedMotion();
  const [out, setOut] = useState("");

  useEffect(() => {
    // Reduced motion resolves in render (see the return below) — nothing to
    // schedule here, so no setState fires in the effect's first breath.
    if (!active || reduced) return;
    let i = 0;
    let timer: number | undefined;
    const tick = () => {
      i += 1;
      setOut(text.slice(0, i));
      if (i < text.length) timer = window.setTimeout(tick, speed);
    };
    timer = window.setTimeout(tick, speed);
    return () => window.clearTimeout(timer);
  }, [text, active, speed, reduced]);

  // Final frame for reduced-motion users, derived instead of assigned.
  return active && reduced ? text : out;
}

/**
 * Words render individually nowrap so a line may break *between* words
 * but never inside one — "on-chain" and "non-custodial" stay whole.
 */
function keepWords(s: string) {
  return s.split(/(\s+)/).map((part, i) =>
    part === "" ? null : /^\s+$/.test(part) ? part : (
      <span key={i} style={{ whiteSpace: "nowrap" }}>
        {part}
      </span>
    ),
  );
}

function TypedLine({
  text,
  active,
  speed,
  className,
}: {
  text: string;
  active: boolean;
  speed?: number;
  className?: string;
}) {
  const typed = useTypewriter(text, active, speed);
  const done = typed.length >= text.length;
  return (
    <span className={className}>
      {keepWords(typed)}
      {!done && <span className="ld-caret" aria-hidden />}
      {/* Keep layout height stable while typing */}
      <span style={{ visibility: "hidden" }} aria-hidden>
        {keepWords(text.slice(typed.length))}
      </span>
    </span>
  );
}

/* ── Counter: rolls0 -> value when revealed ───────────────── */

function useCountUp(target: number | undefined, active: boolean, ms = 1100) {
  const reduced = usePrefersReducedMotion();
  const [n, setN] = useState(0);
  // The frame handle lives in a ref: the animation callback outlives the
  // render that scheduled it, so a plain `let` would be reassigned after render.
  const rafRef = useRef(0);

  useEffect(() => {
    if (!active || target === undefined || reduced) return;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      // ease-out cubic — fast first, settles softly
      setN(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, active, ms, reduced]);

  // Reduced motion jumps straight to the final number — derived, not set.
  return active && reduced && target !== undefined ? target : n;
}

/* ── Static copy ─────────────────────────────────────────── */

const STATIC_TICKER = [
  "Non-custodial by construction",
  "Funds locked in code, not custody",
  "Sourcify exact match",
  "Dispute, single arbiter",
];

const STEPS = [
  {
    n: "01",
    title: "Create the link",
    body: "Set payee, amount, deadline and arbiter. One transaction writes an immutable escrow record on-chain — the link is the shareable receipt.",
  },
  {
    n: "02",
    title: "Fund the lock",
    body: "The payer approves USDC and locks it into the contract. From this second the money cannot move except by the rules below — nobody, including us, can touch it.",
  },
  {
    n: "03",
    title: "Confirm & release",
    body: "Delivery happens off-chain; confirmation releases funds to the payee minus the 0.5% fee. Dispute? The arbiter splits it. Silence? The timeout returns it.",
  },
];

const FEATURES = [
  {
    icon: <IconLedger size={32} strokeWidth={3} />,
    title: "My records — the on-chain inbox",
    body: "Every escrow your address is party to, read straight from EscrowCreated events. A payee who never received the link still sees what they are owed — no server, no account, no index required.",
  },
  {
    icon: <IconTimeline size={32} strokeWidth={3} />,
    title: "Timeline — receipts, not promises",
    body: "Created, Funded, Confirmed — every step with its transaction hash. Click any line and verify it on the explorer yourself. The UI never asks for trust, it shows the proof.",
  },
  {
    icon: <IconInspect size={32} strokeWidth={3} />,
    title: "Verified source, open ABI",
    body: "The deployed bytecode matches the published Solidity — proven by independent re-compilation on Sourcify. Read the exact source your wallet talks to, then diff it against the explorer.",
  },
  {
    icon: <IconHourglass size={32} strokeWidth={3} />,
    title: "Deadline + 48h escape hatch",
    body: "After the deadline, a 48-hour grace period lets the payer reclaim unclaimed funds. Escrows can never be held hostage forever — the timeout is enforced by code, not goodwill.",
  },
];

/* ── Landing ─────────────────────────────────────────────── */

export function LandingView({ chainId }: { chainId: number }) {
  const contract = escrowAddressFor(chainId);

  const { data: countRaw } = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "escrowCount",
    chainId: asChainId(chainId),
    query: { enabled: !!contract, staleTime: 30_000 },
  });

  const { data: feeRaw } = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "feeBps",
    chainId: asChainId(chainId),
    query: { enabled: !!contract, staleTime: 30_000 },
  });

  const count = countRaw !== undefined ? Number(countRaw as bigint) : undefined;
  const feePct = feeRaw !== undefined ? Number(feeRaw as number) / 100 : 0.5;

  // Hero headline types as soon as the page paints (it's above the fold).
  const [heroReady, setHeroReady] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setHeroReady(true), 250);
    return () => window.clearTimeout(t);
  }, []);

  // The browser tries to hash-scroll before React has rendered the sections
  // (e.g. clicking "How it works" from another view), so honour it here once
  // the DOM exists. Debounced past first paint so it doesn't fight the load.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const t = window.setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 400);
    return () => window.clearTimeout(t);
  }, []);

  const { ref: statsRef, shown: statsShown } = useReveal<HTMLDivElement>();

  const escrowCount = useCountUp(count, statsShown);
  const feeCount = useCountUp(feePct, statsShown, 900);

  const feeLabel = useMemo(() => feeCount.toFixed(feeCount < 10 ? 2 : 1), [feeCount]);

  /**
   * The ticker mixes live facts with standing copy. The numbers come from
   * the same two reads as the stats block, so the strip and the stat cards
   * can never disagree — and an unknown value degrades to its printed
   * fallback instead of showing "NaN" across the front page.
   */
  const ticker = useMemo(() => {
    const live: string[] = [
      count !== undefined
        ? `${count} escrow${count === 1 ? "" : "s"} filed on-chain`
        : "Escrows filed on-chain",
      `Fee ${feeRaw !== undefined ? (Number(feeRaw) / 100).toFixed(2) : "0.50"}% — snapshotted per escrow`,
      `Printed on ${chainLabel(chainId)} · ${chainId}`,
    ];
    return [...live, ...STATIC_TICKER];
  }, [count, feeRaw, chainId]);

  return (
    <>
      {/* ── Hero: the front-page headline ─────────────────── */}
      <section className="ld-hero">
        <div>
          <Reveal variant="rise" delay={0}>
            <span className="ld-type">
              <TypedLine
                text="Vol. I — No. 1 · The non-custodial escrow record"
                active={heroReady}
                speed={28}
              />
            </span>
          </Reveal>

          <Reveal variant="rise" delay={120}>
            <h1 className="ld-h1">
              <TypedLine
                text={"Lock funds in seconds.\nRelease on confirmation."}
                active={heroReady}
                speed={34}
              />
            </h1>
          </Reveal>

          <Reveal variant="rise" delay={420}>
            <p className="ld-hero__deck dropcap">
              Bond is escrow infrastructure on Base: money locked in open-source, source-verified code,
              released only when the payer confirms — never held by us, never held by anyone.
              Share a link, not your funds.
            </p>
          </Reveal>

          <Reveal variant="rise" delay={560}>
            <div className="row gap-3" style={{ marginTop: 28, flexWrap: "wrap" }}>
              <a className="btn btn--primary" href="?view=create">
                Create an escrow link
              </a>
              <a className="btn btn--secondary" href="?view=records">
                Open my records
              </a>
            </div>
          </Reveal>

          <Reveal variant="draw" delay={700}>
            <div className="ld-hero__rule" />
          </Reveal>
        </div>

        {/* Spec sheet — the press box beside the headline */}
        <Reveal variant="print" delay={300}>
          <div className="ld-spec">
            <div className="ld-spec__title">Protocol specification</div>

            <div className="ld-spec__row">
              <span className="ld-spec__k">Network</span>
              <span className="ld-spec__v">Base · 8453 / Sepolia · 84532</span>
            </div>
            <div className="ld-spec__row">
              <span className="ld-spec__k">Asset</span>
              <span className="ld-spec__v">USDC (6 decimals)</span>
            </div>
            <div className="ld-spec__row">
              <span className="ld-spec__k">Protocol fee</span>
              <span className="ld-spec__v">{feeLabel}% — snapshotted per escrow</span>
            </div>
            <div className="ld-spec__row">
              <span className="ld-spec__k">Escrows filed</span>
              <span className="ld-spec__v tnum">{count ?? "—"}</span>
            </div>
            <div className="ld-spec__row">
              <span className="ld-spec__k">Custody</span>
              <span className="ld-spec__v">None — contract holds funds</span>
            </div>
            <div className="ld-spec__row">
              <span className="ld-spec__k">Contract</span>
              <span className="ld-spec__v mono" style={{ fontSize: 11 }}>
                {contract ? (
                  <a href={explorerAddressUrl(chainId, contract)} target="_blank" rel="noopener noreferrer">
                    {contract.slice(0, 10)}…{contract.slice(-6)}{" "}
                    <IconExternal size={11} strokeWidth={3} style={{ display: "inline", verticalAlign: "-1px" }} />
                  </a>
                ) : (
                  "not deployed here"
                )}
              </span>
            </div>

            {/* The seal sits squarely in the middle of the sheet, fully
                inside the box: the print wipe (clip-path) clips anything
                that hangs over the edge, which used to cut it in half. It
                rides the spec box's own reveal — a nested observer inside a
                clip-path ancestor would never fire. */}
            <div className="ld-hero__stamp-slot">
              <span
                className="ld-hero__stamp ld-stamp"
                style={{ "--d": "950ms" } as React.CSSProperties}
              >
                Non-custodial
              </span>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ── Ticker strip ──────────────────────────────────── */}
      <Reveal variant="print" delay={0}>
        <div className="ld-ticker" aria-hidden>
          <div className="ld-ticker__track">
            {[...ticker, ...ticker].map((t, i) => (
              <span key={i}>{t}</span>
            ))}
          </div>
        </div>
      </Reveal>

      {/* ── Live stats ────────────────────────────────────── */}
      <section className="ld-sec" style={{ paddingTop: 56, paddingBottom: 56 }}>
        <div ref={statsRef}>
          <div className={`ld-stats ${statsShown ? "in" : ""}`}>
            <div>
              <div className="ld-stats__n tnum">{count !== undefined ? Math.floor(escrowCount) : "—"}</div>
              <div className="ld-stats__l">Escrows filed on-chain</div>
            </div>
            <div>
              <div className="ld-stats__n tnum">{feeLabel}%</div>
              <div className="ld-stats__l">Protocol fee</div>
            </div>
            <div>
              <div className="ld-stats__n">48h</div>
              <div className="ld-stats__l">Timeout grace period</div>
            </div>
            <div>
              <div className="ld-stats__n">0</div>
              <div className="ld-stats__l">Keys we hold</div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────── */}
      <section className="ld-sec" id="how">
        <Reveal variant="rise">
          <div className="ld-head">
            <span className="index">01</span>
            <h2>How it works</h2>
            <span className="ld-head__rule" style={{ height: 3, background: "var(--border-ink)", flex: 1 }} />
          </div>
        </Reveal>

        <div className="ld-steps">
          {STEPS.map((s, i) => (
            <Reveal key={s.n} variant="rise" delay={i * 140}>
              <div className="ld-step">
                <div className="ld-step__bar" />
                <div className="ld-step__n">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Why Bond: the four guarantees ─────────────────── */}
      <section className="ld-sec" id="security">
        <Reveal variant="rise">
          <div className="ld-head">
            <span className="index">02</span>
            <h2>Built to be checked</h2>
            <span style={{ height: 3, background: "var(--border-ink)", flex: 1 }} />
          </div>
        </Reveal>

        <div className="ld-feats">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} variant="print" delay={i * 120}>
              <article className="ld-feat">
                <span className="ld-feat__mark" aria-hidden>
                  {f.icon}
                </span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Verify: independent source check ──────────────── */}
      <section className="ld-sec" id="contract">
        <Reveal variant="rise">
          <div className="ld-head">
            <span className="index">03</span>
            <h2>Read the source yourself</h2>
            <span style={{ height: 3, background: "var(--border-ink)", flex: 1 }} />
          </div>
        </Reveal>

        <Reveal variant="print">
          <div style={{ maxWidth: 780 }}>
            <ContractVerifyCard chainId={chainId} contract={contract} />
          </div>
        </Reveal>
      </section>

      {/* ── Final CTA ─────────────────────────────────────── */}
      <section className="ld-cta">
        <svg className="ld-cta__mark" aria-hidden viewBox="0 0 64 64" focusable="false" fill="rgba(244, 240, 230, 0.045)">
          <rect x="8" y="10" width="8" height="44" />
          <rect x="8" y="10" width="12" height="8" />
          <rect x="8" y="46" width="12" height="8" />
          <rect x="48" y="10" width="8" height="44" />
          <rect x="44" y="10" width="12" height="8" />
          <rect x="44" y="46" width="12" height="8" />
          <rect x="24" y="24" width="16" height="16" />
        </svg>
        <div className="ld-wrap" style={{ position: "relative" }}>
          <Reveal variant="rise">
            <span className="eyebrow" style={{ color: "var(--plate-muted)" }}>
              Last edition
            </span>
            <h2 style={{ marginTop: 14 }}>Put it in writing. On-chain.</h2>
            <p>
              One link, one lock, one confirmation. Your counterparty sees it in their records the
              moment the transaction lands — and so does everyone with a block explorer.
            </p>
          </Reveal>

          <Reveal variant="rise" delay={160}>
            <div className="row gap-3" style={{ marginTop: 30, flexWrap: "wrap" }}>
              <a className="btn btn--primary" href="?view=create">
                Create an escrow link
              </a>
              <a className="btn btn--secondary" href="?view=records">
                Open my records
              </a>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
