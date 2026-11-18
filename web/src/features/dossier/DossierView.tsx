import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { isAddress, type Address } from "viem";
import { AlertBox } from "../../components/ui/AlertBox";
import { Badge, CardSkeleton, EmptyState, type BadgeTone } from "../../components/ui/Feedback";
import { IconExternal, IconInspect, IconMissingRecord, IconRefresh, IconWallet } from "../../components/ui/Icons";
import { escrowAddressFor } from "../../lib/contracts";
import {
  getEscrowsForAccount,
  isDeployBlockConfigured,
  deployBlockEnvKey,
  type EscrowCreatedEntry,
  type PartyRole,
} from "../../lib/activity";
import { getContractLedger, reputationFor, type AddressReputation, type LedgerEntry } from "../../lib/reputation";
import { asChainId, explorerAddressUrl } from "../../lib/chains";
import { formatUsdc, shortAddress } from "../../lib/format";

/**
 * Dossier — one address's public reputation page.
 *
 * A newspaper's morgue file: what this address has done on Bond, counted
 * from the contract's own event logs. No account, no login, no server —
 * anyone can paste any address (or open the link a counterparty shared)
 * and read the same record the parties see.
 *
 * Two log sources, one page:
 *   - `getContractLedger`  every lifecycle event on the contract, which
 *     feeds `reputationFor` (the maths) and the per-escrow outcome badge;
 *   - `getEscrowsForAccount` the EscrowCreated rows that mention this
 *     address, which carry the fields the ledger's created event lacks
 *     (amount, deadline, description) plus this address's seats.
 *
 * Outcomes are derived, never stored: EscrowConfirmed means Settled,
 * DisputeResolved means Ruled, and an escrow with no terminal event is
 * still Open. The chain is the only source of truth.
 */

/** This address's seat in each escrow, phrased for a third-party reader. */
const SEAT_LABEL: Record<PartyRole, string> = {
  payer: "As payer",
  payee: "As payee",
  arbiter: "As arbiter",
};

const SEAT_TONE: Record<PartyRole, BadgeTone> = {
  payer: "brand",
  payee: "success",
  arbiter: "warning",
};

type Outcome = { label: string; tone: BadgeTone };

const OUTCOME_SETTLED: Outcome = { label: "Settled", tone: "success" };
const OUTCOME_REFUNDED: Outcome = { label: "Refunded", tone: "neutral" };
const OUTCOME_CANCELLED: Outcome = { label: "Cancelled", tone: "neutral" };
const OUTCOME_RULED: Outcome = { label: "Arbiter ruled", tone: "brand" };
const OUTCOME_DISPUTED: Outcome = { label: "Disputed", tone: "danger" };
const OUTCOME_OPEN: Outcome = { label: "Open", tone: "warning" };

/**
 * Terminal state per escrow id, walked oldest-first so a dispute that was
 * later resolved reads as "Arbiter ruled" — the last terminal event wins.
 * Ids with no terminal event are simply absent, hence Open.
 */
function deriveOutcomes(rows: readonly LedgerEntry[]): Map<string, Outcome> {
  const map = new Map<string, Outcome>();
  for (const e of rows) {
    if (e.kind === "EscrowCreated") continue;
    let next: Outcome | undefined;
    if (e.kind === "EscrowConfirmed") next = OUTCOME_SETTLED;
    else if (e.kind === "EscrowRefunded") next = OUTCOME_REFUNDED;
    else if (e.kind === "EscrowCancelled") next = OUTCOME_CANCELLED;
    else if (e.kind === "DisputeResolved") next = OUTCOME_RULED;
    else if (e.kind === "DisputeOpened") next = OUTCOME_DISPUTED;
    if (next) map.set(e.id.toString(), next);
  }
  return map;
}

/** Payee escrows that reached a verdict: share of them that paid out. */
function settlementRate(stats: AddressReputation): { pct: number; decided: number } | null {
  const decided = stats.settled + stats.returned;
  if (decided === 0) return null;
  return { pct: Math.round((stats.settled / decided) * 100), decided };
}

export function DossierView({ chainId, onOpen }: { chainId: number; onOpen: (id: bigint) => void }) {
  const { address: connected } = useAccount();
  // Bound to the active chain — a bare usePublicClient() would default to
  // Base mainnet and read the wrong chain's logs on Base Sepolia.
  const publicClient = usePublicClient({ chainId: asChainId(chainId) });
  const contract = escrowAddressFor(chainId);

  // Address precedence: a pasted override, then the link's ?address=, then
  // the connected wallet. Pasting must beat the wallet, or a visitor could
  // never look up a counterparty while connected.
  const urlAddress = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get("address");
    return raw && isAddress(raw) ? (raw as Address) : null;
  }, []);
  const [pasted, setPasted] = useState<Address | null>(null);
  const target = pasted ?? urlAddress ?? (connected as Address | undefined) ?? null;

  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const [data, setData] = useState<{ key: string; ledger: LedgerEntry[]; escrows: EscrowCreatedEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Identity key: switching address, chain or contract derives an empty
  // page (skeleton) instead of showing the previous target's record —
  // no reset inside the effect, same pattern as the inbox.
  const dataKey = `${target ?? "none"}:${chainId}:${contract ?? "none"}`;
  const loaded = data?.key === dataKey ? data : null;

  const load = useMemo(
    () => async (opts: { force?: boolean; silent?: boolean } = {}) => {
      if (!publicClient || !contract || !target) return;
      if (!opts.silent) setRefreshing(true);
      setError(null);
      try {
        const [ledger, escrows] = await Promise.all([
          getContractLedger(publicClient, contract, chainId, { force: opts.force }),
          getEscrowsForAccount(publicClient, contract, target, chainId, { force: opts.force }),
        ]);
        setData({ key: dataKey, ledger, escrows });
      } catch (e) {
        if (!opts.silent) {
          setError(e instanceof Error ? e.message : "Could not read on-chain events.");
        }
      } finally {
        if (!opts.silent) setRefreshing(false);
      }
    },
    [publicClient, contract, target, chainId, dataKey],
  );

  // First paint: use the local index so the page appears immediately, and
  // schedule the scan instead of running it — an effect must not cascade
  // a render. Re-runs whenever the target identity changes.
  useEffect(() => {
    if (loaded || !target || !contract) return;
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [loaded, target, contract, load]);

  const stats = useMemo(() => (loaded && target ? reputationFor(loaded.ledger, target) : null), [loaded, target]);
  const outcomes = useMemo(() => (loaded ? deriveOutcomes(loaded.ledger) : null), [loaded]);
  const rate = stats ? settlementRate(stats) : null;

  const seats: Outcome[] = [];
  if (stats) {
    if (stats.opened > 0) seats.push({ label: `Payer seat · ${stats.opened} opened`, tone: "brand" });
    if (stats.received > 0) seats.push({ label: `Payee seat · ${stats.received} received`, tone: "success" });
    if (stats.arbitrated > 0) seats.push({ label: `Arbiter seat · ${stats.arbitrated} assigned`, tone: "warning" });
  }

  function lookup(e: FormEvent) {
    e.preventDefault();
    const v = input.trim();
    if (!v) {
      setInputError("Paste a 0x address to look up.");
      return;
    }
    if (!isAddress(v)) {
      setInputError("That is not a valid 0x address.");
      return;
    }
    setInputError(null);
    setPasted(v as Address);
    // The query param stays canonical, so the address bar is shareable.
    const url = new URL(window.location.href);
    url.searchParams.set("view", "dossier");
    url.searchParams.set("address", v);
    window.history.replaceState(null, "", url);
  }

  function useConnected() {
    if (!connected) return;
    setInputError(null);
    setPasted(null);
    setInput("");
  }

  const bar = (
    <AddressBar
      input={input}
      setInput={setInput}
      inputError={inputError}
      lookup={lookup}
      target={target}
      chainId={chainId}
      canResetToWallet={pasted !== null && !!connected && pasted.toLowerCase() !== connected.toLowerCase()}
      onReset={useConnected}
    />
  );

  // ── Guards ──────────────────────────────────────────────
  // The chain's deploy block missing or 0: the scan would start at genesis,
  // every public RPC refuses that range, and the dossier looks simply empty.
  if (!isDeployBlockConfigured(chainId)) {
    const key = deployBlockEnvKey(chainId);
    return (
      <div className="stack gap-5" style={{ maxWidth: 900 }}>
        {bar}
        <AlertBox
          variant="warning"
          code="E08"
          title="Deployment block not configured"
          description={`This build is missing ${key}, so the app cannot bound its event scan on this chain. Dossiers are unavailable until it is set — no record has been lost.`}
          details={`Expected ${key} in web/.env — current value: "${String((import.meta.env as Record<string, string | undefined>)[key] ?? "")}"`}
        />
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="stack gap-5" style={{ maxWidth: 900 }}>
        {bar}
        <EmptyState
          icon={<IconMissingRecord size={30} strokeWidth={3} />}
          eyebrow="Wrong network"
          title="Not deployed here"
          description="Bond has no contract on this chain yet. Switch your wallet to Base or Base Sepolia to read dossiers."
        />
      </div>
    );
  }

  return (
    <div className="stack gap-5" style={{ maxWidth: 900 }}>
      {/* ── Header ────────────────────────────────────────── */}
      <div className="stack gap-2">
        <span className="eyebrow">Public record · counted from event logs</span>
        <h1 style={{ fontSize: "var(--text-xl)", lineHeight: 1.05 }}>Reputation dossier</h1>
        <p className="muted" style={{ fontSize: "var(--text-sm)", maxWidth: 640, lineHeight: 1.7 }}>
          What one address has done on Bond: escrows opened, seats held, funds settled and disputes ruled — every
          figure derived from this contract's own logs. No account, no login, no server; paste any address to read
          the file the parties themselves see.
        </p>
      </div>

      {bar}

      {error && (
        <AlertBox
          variant="error"
          code="E08"
          title="Could not read the chain"
          description="The RPC endpoint did not answer. Nothing is wrong with this record — retry in a moment."
          action={{ label: "Retry", onClick: () => void load() }}
          details={error}
        />
      )}

      {!target && !error && (
        <EmptyState
          icon={<IconWallet size={30} strokeWidth={3} />}
          eyebrow="No address yet"
          title="Look up any address"
          description="Paste a 0x address above, or connect a wallet to open your own dossier. The record is public the moment an escrow mentions the address — nothing has to be registered first."
        />
      )}

      {target && !loaded && !error && <CardSkeleton lines={5} />}

      {target && loaded && loaded.escrows.length === 0 && !error && (
        <EmptyState
          icon={<IconInspect size={30} strokeWidth={3} />}
          eyebrow="File empty"
          title="No escrow record"
          description={`${shortAddress(target)} has never been the payer, payee or arbiter of an escrow on this contract. The moment an escrow mentions it, the file opens itself.`}
          action={{ label: "Create the first escrow link", onClick: () => (window.location.href = "/?view=create") }}
        />
      )}

      {target && loaded && stats && loaded.escrows.length > 0 && (
        <>
          {/* ── Seats this address has held ─────────────────── */}
          <div className="card card--flat">
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              Seats held
            </div>
            {seats.length > 0 ? (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {seats.map((s) => (
                  <Badge key={s.label} tone={s.tone}>
                    {s.label}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="small muted">No seats on this contract.</span>
            )}
          </div>

          {/* ── The count ──────────────────────────────────── */}
          <div className="card card--flat">
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              The record
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
              }}
            >
              {[
                { label: "Escrows opened", value: String(stats.opened) },
                { label: "Escrows received", value: String(stats.received) },
                { label: "Settled", value: String(stats.settled) },
                { label: "Returned", value: String(stats.returned) },
                { label: "Rulings given", value: String(stats.rulings) },
                { label: "Settled volume", value: formatUsdc(stats.settledVolume) },
                { label: "Settlement rate", value: rate ? `${rate.pct}%` : "-" },
              ].map((cell) => (
                <div
                  key={cell.label}
                  style={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    // Overlap neighbours by 1px so shared edges stay one line,
                    // and a partial last row shows plain card, not trough.
                    margin: "-1px 0 0 -1px",
                    padding: "12px 14px",
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--text-2)",
                      marginBottom: 6,
                    }}
                  >
                    {cell.label}
                  </div>
                  <div className="tnum" style={{ fontSize: "var(--text-lg)", fontWeight: 800, lineHeight: 1 }}>
                    {cell.value}
                  </div>
                </div>
              ))}
            </div>
            <div className="small muted" style={{ marginTop: 10, lineHeight: 1.6 }}>
              {rate
                ? `Settlement rate counts the ${rate.decided} payee escrow${rate.decided === 1 ? "" : "s"} that reached a verdict: ${stats.settled} paid out, ${stats.returned} returned.`
                : "Settlement rate appears once a payee escrow reaches a verdict."}{" "}
              Volume is net of the protocol fee, in USDC.
            </div>
          </div>

          {/* ── The escrows ────────────────────────────────── */}
          <div className="stack gap-3">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <span className="eyebrow">
                {loaded.escrows.length} escrow{loaded.escrows.length === 1 ? "" : "s"} mentioning this address
              </span>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => void load({ force: true })}
                disabled={refreshing}
              >
                {refreshing ? (
                  "Scanning chain…"
                ) : (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    <IconRefresh size={13} strokeWidth={3.5} />
                    Refresh from chain
                  </span>
                )}
              </button>
            </div>

            {loaded.escrows.map((row) => (
              <DossierRow
                key={String(row.id)}
                row={row}
                outcome={outcomes?.get(String(row.id)) ?? OUTCOME_OPEN}
                onOpen={onOpen}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Address bar: paste, look up, share ──────────────────── */

function AddressBar({
  input,
  setInput,
  inputError,
  lookup,
  target,
  chainId,
  canResetToWallet,
  onReset,
}: {
  input: string;
  setInput: (v: string) => void;
  inputError: string | null;
  lookup: (e: FormEvent) => void;
  target: Address | null;
  chainId: number;
  canResetToWallet: boolean;
  onReset: () => void;
}) {
  return (
    <div className="card card--flat">
      <form onSubmit={lookup} className="stack gap-3">
        <div className="row" style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "1 1 320px", marginBottom: 0 }}>
            <label className="field__label" htmlFor="dossier-address">
              Address to look up
            </label>
            <input
              id="dossier-address"
              className={`field__input ${inputError ? "field__input--invalid" : ""}`}
              placeholder="0x… any payer, payee or arbiter"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn btn--primary">
            Open dossier
          </button>
        </div>
        {inputError && <span className="field__error">{inputError}</span>}

        <div className="row" style={{ gap: 12, flexWrap: "wrap", justifyContent: "space-between" }}>
          <span className="small mono muted" title={target ?? "No address selected"}>
            {target ? `File: ${shortAddress(target)}` : "No file open"}
          </span>
          <span className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            {target && (
              <a
                href={explorerAddressUrl(chainId, target)}
                target="_blank"
                rel="noopener noreferrer"
                className="small"
                style={{ display: "inline-flex", gap: 5, alignItems: "center", color: "var(--brand)" }}
              >
                View address on explorer
                <IconExternal size={11} strokeWidth={3} />
              </a>
            )}
            {canResetToWallet && (
              <button type="button" className="btn btn--secondary btn--sm" onClick={onReset}>
                Back to my address
              </button>
            )}
          </span>
        </div>
      </form>
    </div>
  );
}

/* ── One escrow in the file ──────────────────────────────── */

function DossierRow({
  row,
  outcome,
  onOpen,
}: {
  row: EscrowCreatedEntry;
  outcome: Outcome;
  onOpen: (id: bigint) => void;
}) {
  const deadline = new Date(Number(row.deadline) * 1000);

  return (
    <div
      className="card record-row"
      style={{
        textAlign: "left",
        cursor: "pointer",
        border: "1px solid var(--border)",
        display: "block",
        width: "100%",
        font: "inherit",
        color: "inherit",
      }}
    >
      <div className="row" style={{ justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div className="stack gap-2" style={{ minWidth: 240, flex: "1 1 300px" }}>
          <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
            <span className="mono" style={{ fontWeight: 700 }}>
              #{String(row.id)}
            </span>
            {/* Stretched link: one real anchor covering the whole card, so
                the markup stays valid, the row is keyboard reachable, and
                it can open in a new tab. */}
            <a
              href={`?escrow=${String(row.id)}`}
              className="record-row__open"
              onClick={(e) => {
                e.preventDefault();
                onOpen(row.id);
              }}
            >
              <span style={{ fontWeight: 650 }}>
                {row.description || <span className="muted">No description</span>}
              </span>
            </a>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {row.roles.map((r) => (
              <Badge key={r} tone={SEAT_TONE[r]}>
                {SEAT_LABEL[r]}
              </Badge>
            ))}
            <Badge tone={outcome.tone}>{outcome.label}</Badge>
          </div>
        </div>

        <div className="stack" style={{ alignItems: "flex-end", gap: 6 }}>
          <span className="tnum" style={{ fontSize: "var(--text-lg)", fontWeight: 800 }}>
            {formatUsdc(row.amount)} <span className="small muted">USDC</span>
          </span>
          <span className="small muted">deadline {deadline.toLocaleDateString()}</span>
        </div>
      </div>

      <div
        className="row small muted mono"
        style={{ gap: 14, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}
      >
        <span>payer {shortAddress(row.payer)}</span>
        <span>payee {shortAddress(row.payee)}</span>
        <span>arbiter {shortAddress(row.arbiter)}</span>
      </div>
    </div>
  );
}
