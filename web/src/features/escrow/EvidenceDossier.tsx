import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { AlertBox } from "../../components/ui/AlertBox";
import { Skeleton } from "../../components/ui/Feedback";
import { IconCopy, IconLedger } from "../../components/ui/Icons";
import { useToast } from "../../components/ui/toast-context";
import { escrowAddressFor, ESCROW_STATE_NAMES } from "../../lib/contracts";
import { eventLabel, getEscrowTimeline, type TimelineEntry } from "../../lib/activity";
import { asChainId, chainLabel, explorerAddressUrl, explorerTxUrl } from "../../lib/chains";
import { formatUsdc } from "../../lib/format";

type StateName = (typeof ESCROW_STATE_NAMES)[number];

interface Props {
  id: bigint;
  chainId: number;
  payer: Address;
  payee: Address;
  arbiter: Address;
  amount: bigint;
  feeBps: number;
  /** Unix seconds. */
  deadline: number;
  /** Unix seconds. */
  createdAt: number;
  state: number;
  description: string;
  /** True when payee and arbiter co-signed the terms off-chain. */
  consented: boolean;
}

/**
 * Evidence dossier — the dispute packet.
 *
 * When a deal goes bad, somebody has to reconstruct what happened from a
 * screen: the arbiter, a mediator, a small-claims judge. This card assembles
 * the whole record — parties, amounts, terms, and every lifecycle event with
 * its tx hash and block — into one print-ready PDF packet (plus a plain-text
 * copy for the clipboard). Nothing here is fetched from Bond: the timeline
 * comes from the same public logs the timeline card shows, so the file can
 * be re-derived by anyone with a block explorer.
 */
export function EvidenceDossier(props: Props) {
  const { id, chainId } = props;
  const toast = useToast();
  const publicClient = usePublicClient({ chainId: asChainId(chainId) });
  const contract = escrowAddressFor(chainId);

  // Destructured so the document memo keys on values, not the props object
  // (whose identity changes on every render).
  const { payer, payee, arbiter, amount, feeBps, deadline, createdAt, state, description, consented } = props;

  const [timeline, setTimeline] = useState<{ key: string; rows: TimelineEntry[] } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const identity = `${chainId}:${contract ?? "none"}:${id.toString()}`;

  useEffect(() => {
    if (!publicClient || !contract) return;
    const ac = new AbortController();
    getEscrowTimeline(publicClient, contract, id, chainId)
      .then((rows) => {
        if (ac.signal.aborted) return;
        setTimeline({ key: identity, rows });
        setFailure(null);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setFailure({ key: identity, message: e instanceof Error ? e.message : "Timeline unavailable." });
      });
    return () => ac.abort();
  }, [publicClient, contract, id, chainId, identity]);

  const rows = timeline?.key === identity ? timeline.rows : null;
  const error = failure?.key === identity ? failure.message : null;

  const stateName: StateName = ESCROW_STATE_NAMES[state] ?? "None";

  // ── The document itself ────────────────────────────────────
  // Built on demand (download / copy) rather than during render: the
  // generation stamp belongs to the moment the file is written, not to
  // whatever render happened to compute it.
  function buildDossier(generatedAt: number): string | null {
    if (rows === null) return null;
    const line = "─".repeat(64);
    const when = (unix?: number) =>
      unix ? new Date(unix * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : "unknown";

    const out: string[] = [
      "BOND EVIDENCE DOSSIER",
      line,
      `Escrow          : #${id.toString()}`,
      `Chain           : ${chainLabel(chainId)} (${chainId})`,
      `Contract        : ${contract ?? "not deployed on this chain"}`,
      `State           : ${stateName}`,
      `Generated       : ${when(generatedAt)}`,
      "",
      "PARTIES",
      line,
      `Payer           : ${payer}`,
      `Payee           : ${payee}`,
      `Arbiter         : ${arbiter}`,
      "",
      "AMOUNTS",
      line,
      `Amount          : ${formatUsdc(amount)} USDC`,
      `Protocol fee    : ${Number(feeBps) / 100}% (${formatUsdc((amount * BigInt(feeBps)) / 10_000n)} USDC)`,
      `Payee receives  : ${formatUsdc(amount - (amount * BigInt(feeBps)) / 10_000n)} USDC`,
      "",
      "TIMES",
      line,
      `Created         : ${when(createdAt)}`,
      `Deadline        : ${when(deadline)}`,
      `Timeout opens   : ${when(deadline + 48 * 60 * 60)} (deadline plus the 48-hour grace)`,
      "",
      "TERMS",
      line,
      description.trim() || "(no description was recorded)",
      "",
      `Terms co-signed by payee and arbiter (EIP-712): ${consented ? "yes" : "no"}`,
      "",
      `EVENT LOG (${rows.length} event${rows.length === 1 ? "" : "s"}, from public logs)`,
      line,
    ];

    if (rows.length === 0) {
      out.push("(no lifecycle events found yet)");
    } else {
      for (const e of rows) {
        out.push(`${when(e.timestamp)}  ${eventLabel(e)}`);
        out.push(`    tx      : ${e.txHash}`);
        out.push(`    block   : #${e.blockNumber.toString()}`);
        out.push(`    explorer: ${explorerTxUrl(chainId, e.txHash)}`);
        out.push("");
      }
    }

    out.push(line);
    out.push("HOW TO VERIFY");
    out.push(line);
    out.push("Every line above was read from public event logs. Re-check any tx");
    out.push("hash on the explorer, or re-read the contract directly at:");
    out.push(contract ? explorerAddressUrl(chainId, contract) : "(no contract on this chain)");
    out.push("");
    out.push("Bond is open-source and source-verified, not audited.");

    return out.join("\n");
  }

  // ── The PDF packet ────────────────────────────────────────
  // jsPDF, the layout code and the vendored fonts all load on this click,
  // so nothing of the exporter weighs on first paint. The generation
  // stamp belongs to the moment the file is written.
  async function downloadPdf() {
    if (rows === null || exporting) return;
    setExporting(true);
    try {
      const { downloadDossierPdf } = await import("../../lib/dossierPdf");
      await downloadDossierPdf({
        id,
        chainId,
        contract,
        payer,
        payee,
        arbiter,
        amount,
        feeBps,
        deadline,
        createdAt,
        stateName,
        description,
        consented,
        rows,
        generatedAt: Math.floor(Date.now() / 1000),
      });
      toast.success("Dossier downloaded", "A print-ready PDF — every transaction hash inside is a live link.");
    } catch {
      toast.warning("PDF could not be composed", "The record is safe on-chain — try again, or copy the plain text instead.");
    } finally {
      setExporting(false);
    }
  }

  async function copy() {
    const dossier = buildDossier(Math.floor(Date.now() / 1000));
    if (!dossier) return;
    try {
      await navigator.clipboard.writeText(dossier);
      toast.success("Dossier copied");
    } catch {
      toast.warning("Copy failed", "Download the file instead.");
    }
  }

  const ready = rows !== null;

  return (
    <div className="card">
      <div
        className="row"
        style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}
      >
        <h3>Evidence dossier</h3>
        <span className="eyebrow">dispute packet</span>
      </div>
      <p className="small muted" style={{ marginBottom: 16 }}>
        One print-ready PDF with the whole record: a cover, the parties, the amounts, the terms and every
        event with its transaction hash — the packet to hand an arbiter, a mediator or a court.
      </p>

      {error && (
        <AlertBox
          variant="warning"
          title="Dossier could not be assembled"
          description="The RPC refused the log query. The escrow itself is unaffected — retry later."
          details={error}
        />
      )}

      {rows === null && !error && (
        <div className="stack gap-3">
          <Skeleton h={18} w="75%" />
          <Skeleton h={18} w="55%" />
        </div>
      )}

      {ready && (
        <div className="row gap-3" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn btn--primary btn--sm row gap-2"
            onClick={() => void downloadPdf()}
            disabled={exporting}
          >
            {exporting ? "Composing PDF…" : "Download dossier (PDF)"}
            <IconLedger size={14} strokeWidth={3.5} />
          </button>
          <button type="button" className="btn btn--secondary btn--sm row gap-2" onClick={() => void copy()}>
            Copy as text
            <IconCopy size={13} strokeWidth={4} />
          </button>
          <span className="small muted tnum">
            {rows.length} event{rows.length === 1 ? "" : "s"} included · state {stateName}
          </span>
        </div>
      )}
    </div>
  );
}
