import type { ReactNode } from "react";
import { useReadContract } from "wagmi";
import { ESCROW_ABI, escrowAddressFor, usdcAddressFor } from "../../lib/contracts";
import { CHAIN_IDS, asChainId, chainLabel, explorerAddressUrl } from "../../lib/chains";
import { deployBlockFor } from "../../lib/activity";
import type { DocSlug } from "./docsMeta";

/**
 * DocsView — the platform's own documentation pages.
 *
 * Every footer link resolves here (or to a real external destination).
 * No backend: these are static, honest documents written from what the
 * deployed system actually does — routes, events, error matrix, terms.
 * Slug metadata (DocSlug, isDocSlug, DOC_TITLES) lives in docsMeta.ts.
 */

interface DocSection {
  h: string;
  p?: string[];
  list?: string[];
}

interface DocDef {
  eyebrow: string;
  title: string;
  deck: string;
  sections: DocSection[];
  /** Rendered above the sections when the chain data is available. */
  live?: boolean;
}

const DOCS: Record<DocSlug, DocDef> = {
  docs: {
    eyebrow: "For builders",
    title: "Documentation",
    deck: "How Bond is wired: routes, contract, events, and the error matrix every failure in this app is mapped to.",
    live: true,
    sections: [
      {
        h: "Routes",
        p: ["The whole app is static files — routing happens in the URL:"],
        list: [
          "/ — landing: how it works, security model, live contract figures.",
          "?view=create — draft a new escrow link.",
          "?view=records — the on-chain inbox for the connected wallet.",
          "?escrow=N — escrow detail: state, actions, public timeline, verification.",
          "?view=doc&doc=slug — these documents (docs, about, terms, privacy, status, contact, arbitration).",
        ],
      },
      {
        h: "Contract & token",
        p: [
          "One EscrowLink contract per network, compiled with Solidity 0.8.31 and OpenZeppelin v5 (ReentrancyGuard, Pausable, Ownable2Step). The fee is snapshotted into each escrow at creation — the owner can raise the protocol fee later, but never for escrows that already exist.",
          "Settlement token is native USDC on Base / Base Sepolia (6 decimals). The contract checks the exact received amount when funding, so fee-on-transfer or rebasing tokens cannot under-collateralise an escrow.",
        ],
      },
      {
        h: "Events (the public API)",
        list: [
          "EscrowCreated(id, payer, payee, amount, deadline, arbiter, feeBps, consented, description)",
          "EscrowFunded(id)",
          "EscrowConfirmed(id, payeeAmount, fee)",
          "EscrowCancelled(id)",
          "EscrowRefunded(id)",
          "DisputeOpened(id, by)",
          "DisputeResolved(id, payeeAmount, payerAmount, fee)",
        ],
        p: [
          "My Records and the timeline are built on these logs alone: one eth_getLogs call per page-load, bounded by the deploy block and auto-split when the RPC caps the range. There is no indexer and no server.",
        ],
      },
      {
        h: "Error matrix",
        p: ["Every failure in the UI is funnelled through one decoder (lib/errors.ts) into an AlertBox with a stable code:"],
        list: [
          "E01 — form validation failed in the browser; nothing was sent.",
          "E02 — wallet is on the wrong network (switch to the deployed chain).",
          "E03 — signature declined in the wallet; nothing was sent.",
          "E04 — not enough ETH for gas (or USDC shortfall in the form).",
          "E05 — two-step approve and fund flow for USDC allowance.",
          "E06 — the contract rejected the call (simulation caught it before signing, or it reverted on-chain).",
          "E07 — a wallet is required for this action and none is connected.",
          "E08 — read path failed: the RPC did not answer.",
          "E09 — transaction broadcast, waiting for confirmation.",
          "E10 — transaction dropped or replaced by the network.",
          "E11 — the contract is paused (creation and funding blocked, settlement still safe).",
          "E12 — informational: the payee is a contract, double-check before funding.",
        ],
      },
      {
        h: "ABI",
        p: [
          "The exact ABI this interface ships with is served at /abi.json — the same file the app imports. Diff it against the explorer's verified source to be sure you are talking to the contract you think you are.",
        ],
      },
    ],
  },

  about: {
    eyebrow: "Colophon",
    title: "About Bond",
    deck: "A non-custodial escrow protocol on Base: one contract, one bearer link, one arbiter — and no server in the middle.",
    sections: [
      {
        h: "What it does",
        p: [
          "Bond locks USDC inside open-source, source-verified code until the payer confirms delivery — or an arbiter rules on a dispute, or the deadline plus a 48-hour grace period returns the money. The payer shares a link; whoever holds the link can open the escrow record, but nobody — including the people running this website — can move the funds except through the contract's own rules.",
        ],
      },
      {
        h: "How it stays honest",
        list: [
          "Custody: funds sit in the contract, never with an operator. The UI is a read/write window, not a bank.",
          "Fees: 0.5% (50 bps), snapshotted into each escrow at creation and shown before you sign anything.",
          "Receipts: every state change emits an event with a transaction hash; the timeline links each line to the explorer.",
          "Source: the deployed bytecode was independently re-compiled on Sourcify — exact match — so you can read the real source.",
          "Discovery: the inbox is rebuilt from chain logs on every load. Nothing about you is stored on our side, because there is no side.",
        ],
      },
      {
        h: "What Bond is not",
        list: [
          "Not custodial and not an arbitrator: the arbiter is an address you choose when you create the escrow.",
          "Not an account system: there is no sign-up, no password, no recovery — your wallet is your identity.",
          "Not a guarantee of the counterparty: verify the payee address and pick an arbiter both sides trust.",
          "Not testnet-only: the production deployment runs on Base mainnet with real USDC — the Base Sepolia deployment stays available as a practice table.",
        ],
      },
    ],
  },

  terms: {
    eyebrow: "The fine print",
    title: "Terms of service",
    deck: "Plain English, because the product is a public smart contract and there is little to legislate.",
    sections: [
      {
        h: "1. The service",
        p: [
          "Bond provides a web interface to public, open-source smart contracts on Base. The interface is provided as-is, without warranty of any kind. The contracts are immutable and operate independently of this interface — you can always interact with them directly from a block explorer.",
        ],
      },
      {
        h: "2. Your responsibilities",
        list: [
          "You control your wallet and keys. Nobody can recover them for you.",
          "The escrow link is a bearer instrument: anyone who obtains it can open the escrow record. It contains no secrets and cannot move funds, but share it only with intended parties.",
          "Verify addresses (payee, arbiter, contract) before signing. Transactions are irreversible once confirmed.",
          "You pay your own network fees (gas) in ETH.",
        ],
      },
      {
        h: "3. Funds, custody and fees",
        p: [
          "Escrowed funds are held by the EscrowLink contract under rules fixed at creation: release on confirmation, split on arbiter ruling, refund after deadline + 48 hours (executable by anyone — the contract only ever sends it back to the payer). Bond's operators cannot withdraw, freeze or redirect escrowed funds. The protocol fee is 0.5% of the released amount (0 for refunds to the payer) and is disclosed in the UI before every settlement.",
        ],
      },
      {
        h: "4. Networks",
        p: [
          "The production deployment runs on Base mainnet (chain 8453), where escrowed USDC carries real value. A parallel deployment on Base Sepolia (chain 84532) exists for practice: testnet tokens have no monetary value and the network may be reset. Nothing on a testnet should be relied upon for production value transfer.",
        ],
      },
      {
        h: "5. Liability",
        p: [
          "To the maximum extent permitted by law, the Bond contributors are not liable for losses arising from key mishandling, malicious counterparties, arbiter decisions, smart-contract risk, RPC failures, or use of the interface. If you cannot accept that, do not use the protocol.",
        ],
      },
    ],
  },

  privacy: {
    eyebrow: "Short, because there is nothing to hide",
    title: "Privacy policy",
    deck: "No account, no server, no analytics — the policy is one screen because there is almost nothing to collect.",
    sections: [
      {
        h: "What we do not collect",
        list: [
          "No names, emails or sign-up — the app has no account system.",
          "No analytics, tracking cookies or advertising pixels.",
          "No server-side logs of your browsing: the app is static files served to your browser; reads go straight from your browser to the RPC.",
        ],
      },
      {
        h: "What the chain sees",
        p: [
          "Your wallet address and every transaction you broadcast are public and permanent on Base. That is inherent to public blockchains, not something Bond adds. Anyone holding your escrow link can look up the escrow's public data (parties, amount, state) on-chain.",
        ],
      },
      {
        h: "Third parties",
        list: [
          "Your wallet extension (its own privacy policy governs it).",
          "The public RPC endpoints configured in the app (publicnode) — they see your IP and the queries you make.",
          "Google Fonts serves the two typefaces this page is set in (Playfair Display, Source Serif 4, Courier Prime). Your browser requests those files directly from fonts.googleapis.com / fonts.gstatic.com, which sees your IP like any static file host. No analytics are attached to that request.",
          "Block explorer / Sourcify links open those sites directly; leaving this app is always an explicit click.",
        ],
      },
      {
        h: "Local storage",
        p: [
          "Two things live in your browser's storage: connection preferences (last wallet, selected network), kept by the wallet library, and Bond's own event index — the cached block range and escrow rows it read, so the next visit only scans what the chain added since. Both are cleared together when you clear site data; neither ever leaves your browser, and deleting them cannot lose anything, because every value is re-read from the chain.",
        ],
      },
    ],
  },

  status: {
    eyebrow: "Live figures, read from the chain",
    title: "System status",
    deck: "Everything on this page is checkable: the contract answers for itself.",
    live: true,
    sections: [
      {
        h: "How to verify us",
        list: [
          "Open the contract on the explorer — state, code and events are public.",
          "Compare the source: our Sourcify entry must read exact_match.",
          "Call escrowCount() and feeBps() yourself — the numbers above come from those two calls.",
        ],
      },
      {
        h: "When something is wrong",
        p: [
          "If reads fail, the banner in the UI shows E08 (RPC unreachable) and every write is blocked before it can be signed — a failed read never moves funds. If the contract itself is paused (E11), creation and funding of new escrows stop; funds already locked keep settling.",
        ],
      },
    ],
  },

  contact: {
    eyebrow: "No help desk — but every answer is on-chain",
    title: "Contact",
    deck: "Bond has no support inbox. Escrows have parties, an arbiter and a public record — that is the support system.",
    sections: [
      {
        h: "Questions about an escrow",
        p: [
          "Open the escrow page (?escrow=N) and read the timeline: every action with its transaction hash is there, and it is the same data everyone else sees. The link itself contains no secrets — sharing it is the fastest way to show someone exactly what you see.",
        ],
      },
      {
        h: "Disputes",
        p: [
          "A dispute is resolved by the arbiter address chosen at creation, on-chain. Read the arbitration document for the exact procedure, windows and split mechanics before opening one.",
        ],
      },
      {
        h: "Technical feedback",
        p: [
          "Report interface issues with the escrow id, transaction hash and the E-code shown in the alert — that is enough to reproduce any failure without any personal data. Contract-level discussion belongs with the repository that ships this interface.",
        ],
      },
      {
        h: "What Bond will never ask for",
        list: [
          "Your seed phrase or private key — nobody ever needs it.",
          "Tokens sent anywhere except the escrow contract address shown in the footer and on the escrow page.",
          "Payments to 'unlock', 'release' or 'prioritise' a transaction. Signatures come from your wallet, never from us.",
        ],
      },
    ],
  },

  arbitration: {
    eyebrow: "Rules of the court",
    title: "Dispute & arbitration",
    deck: "One arbiter per escrow, chosen by the payer before funding — with every rule enforced by code, not by patience.",
    sections: [
      {
        h: "Choosing the arbiter",
        p: [
          "The arbiter is a third address fixed at creation. It must differ from the payer and the payee (the contract enforces this), and it is shown on the escrow page for both sides to check before any money is locked. Pick someone both parties trust; once funded, the arbiter cannot be swapped.",
        ],
      },
      {
        h: "Opening a dispute",
        p: [
          "While funds are locked — and before the timeout window closes — either the payer or the payee can escalate. The contract moves the escrow to Disputed and every settlement action pauses until the ruling arrives.",
        ],
      },
      {
        h: "The ruling",
        list: [
          "Only the arbiter can call resolveDispute, with a payee share between 0 and 10000 basis points.",
          "0 = the payer takes everything back (Refunded); 10000 = the payee takes it all (Completed); anything in between splits the principal.",
          "The 0.5% protocol fee applies only to the payee's share — a refund to the payer is always fee-free.",
          "The ruling is a transaction like any other: hash, timestamp and both amounts land in the public timeline.",
        ],
      },
      {
        h: "Timeout — the escape hatch",
        p: [
          "If nobody confirms and nobody disputes by the deadline plus a 48-hour grace period, the timeout opens — and anyone may execute it (claimTimeout, fee-free) because the payout is fixed by the contract: everything returns to the payer, so the caller can neither profit from it nor redirect it. That is what stops an abandoned link from staying locked forever. The dispute path is for disagreement; the timeout is for silence. If a dispute IS open, the arbiter gets a published 7-day window first — waiting out a silent arbiter never invents a new distribution of the money. Both rules are enforced by code, so neither party can stall the other forever.",
        ],
      },
    ],
  },
};

/* ── Live status block ──────────────────────────────────── */

function LiveFacts({ chainId, contract }: { chainId: number; contract?: `0x${string}` }) {
  const { data: count } = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "escrowCount",
    chainId: asChainId(chainId),
    query: { enabled: !!contract, staleTime: 30_000 },
  });
  const { data: fee } = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "feeBps",
    chainId: asChainId(chainId),
    query: { enabled: !!contract, staleTime: 30_000 },
  });
  const { data: paused } = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "paused",
    chainId: asChainId(chainId),
    query: { enabled: !!contract, staleTime: 30_000 },
  });

  const usdc = usdcAddressFor(chainId);
  const deployBlock = deployBlockFor(chainId);
  const rows: { k: string; v: ReactNode }[] = [
    { k: "Network", v: `${chainLabel(chainId)} · chain ${chainId}` },
    {
      k: "EscrowLink contract",
      v: contract ? (
        <a className="mono" href={explorerAddressUrl(chainId, contract)} target="_blank" rel="noopener noreferrer">
          {contract}
        </a>
      ) : (
        "not deployed on this network"
      ),
    },
    { k: "USDC token", v: usdc ? <span className="mono">{usdc}</span> : "not configured for this network" },
    { k: "Protocol fee", v: fee !== undefined ? `${(Number(fee) / 100).toFixed(2)}% (snapshotted per escrow)` : "reading…" },
    { k: "Escrows created", v: count !== undefined ? String(count) : "reading…" },
    { k: "Paused", v: paused === undefined ? "reading…" : paused ? "yes — creation and funding blocked (E11)" : "no" },
    {
      k: "Deploy block",
      v: deployBlock > 0n ? deployBlock.toString() : "not set",
    },
    { k: "Source verification", v: "Sourcify — exact_match" },
    { k: "RPC transport", v: "publicnode (public endpoints, no proxy)" },
  ];

  return (
    <div className="card" style={{ marginBottom: 32 }}>
      <div className="eyebrow" style={{ marginBottom: 14 }}>
        Deployment record — live
      </div>
      <dl style={{ display: "grid", gap: 10, margin: 0 }}>
        {rows.map((r) => (
          <div
            key={r.k}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(140px, 200px) 1fr",
              gap: 14,
              alignItems: "baseline",
              borderBottom: "1px dashed var(--border)",
              paddingBottom: 8,
            }}
          >
            <dt className="mono" style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-3)" }}>
              {r.k}
            </dt>
            <dd style={{ margin: 0, fontSize: 14, wordBreak: "break-all" }}>{r.v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* ── Document ───────────────────────────────────────────── */

export function DocsView({ slug, chainId }: { slug: DocSlug; chainId: number }) {
  const doc = DOCS[slug];
  const contract = escrowAddressFor(chainId);
  const isChainAware = chainId === CHAIN_IDS.base || chainId === CHAIN_IDS.baseSepolia;

  return (
    <article className="stack gap-5" style={{ maxWidth: 780 }}>
      <header className="stack gap-2">
        <span className="eyebrow">{doc.eyebrow}</span>
        <h1 className="fit-doc-h1" style={{ lineHeight: 1.05 }}>{doc.title}</h1>
        <p className="muted" style={{ fontSize: "var(--text-sm)", lineHeight: 1.75 }}>
          {doc.deck}
        </p>
        <div style={{ height: 1, background: "var(--border-ink)", marginTop: 8 }} />
      </header>

      {doc.live && isChainAware && <LiveFacts chainId={chainId} contract={contract} />}

      {doc.sections.map((s) => (
        <section key={s.h} className="stack gap-3">
          <h2 style={{ fontSize: "var(--text-md)", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}>{s.h}</h2>
          {s.p?.map((para) => (
            <p key={para} style={{ fontSize: 15, lineHeight: 1.8, color: "var(--text-2)" }}>
              {para}
            </p>
          ))}
          {s.list && (
            <ul className="stack gap-2" style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
              {s.list.map((item) => (
                <li
                  key={item}
                  style={{
                    fontSize: 14.5,
                    lineHeight: 1.7,
                    color: "var(--text-2)",
                    borderLeft: "3px solid var(--brand)",
                    paddingLeft: 14,
                  }}
                >
                  {item}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <p className="small muted mono" style={{ marginTop: 18 }}>
        End of document · Bond · printed on Base
      </p>
    </article>
  );
}
