import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { AlertBox } from "../../components/ui/AlertBox";
import { Badge, CardSkeleton, EmptyState } from "../../components/ui/Feedback";
import { IconExternal, IconInbox, IconMissingRecord, IconRefresh, IconWallet } from "../../components/ui/Icons";
import { escrowAddressFor, ESCROW_ABI, ESCROW_STATE_NAMES } from "../../lib/contracts";
import { getEscrowsForAccount, isDeployBlockConfigured, deployBlockEnvKey, type EscrowCreatedEntry, type PartyRole } from "../../lib/activity";
import { explorerAddressUrl, asChainId } from "../../lib/chains";
import { formatUsdc, shortAddress } from "../../lib/format";

/**
 * My Records — the inbox.
 *
 * The escrow link is a bearer URL: whoever holds it can open the escrow. But
 * the counterparty must not depend on someone forwarding it. This view reads
 * `EscrowCreated` logs and lists every escrow the connected account is party
 * to (payer, payee or arbiter), so a payee who was never sent the link still
 * sees "you are owed 4 USDC, awaiting confirmation".
 *
 * No backend, no indexer: pure event logs bounded by the deploy block.
 */

const ROLE_LABEL: Record<PartyRole, string> = {
  payer: "You are the payer",
  payee: "You are the payee",
  arbiter: "You are the arbiter",
};

const ROLE_TONE: Record<PartyRole, "brand" | "success" | "warning"> = {
  payer: "brand",
  payee: "success",
  arbiter: "warning",
};

/** One-line "what should happen next" per state, from this seat's perspective. */
function nextStep(stateName: string, roles: PartyRole[]): string {
  const isPayer = roles.includes("payer");
  const isPayee = roles.includes("payee");
  const isArbiter = roles.includes("arbiter");

  switch (stateName) {
    case "Created":
      if (isPayer) return "Approve USDC, then lock the funds to activate this link.";
      if (isPayee) return "Waiting for the payer to lock the funds. Nothing is at risk yet.";
      return "Waiting for the payer to fund.";
    case "Funded":
      if (isPayer) return "Funds are locked. Confirm delivery to release them — or open a dispute.";
      if (isPayee) return "Funds are locked. Deliver the work, then ask the payer to confirm.";
      if (isArbiter) return "Funds are locked. You can only act once one of the parties opens a dispute.";
      return "Funds are locked; only payer or payee can move it.";
    case "Disputed":
      if (isArbiter) return "Your decision is required: open this record and split the funds (0–100% to the payee).";
      return "Under review by the arbiter.";
    case "Completed":
      if (isPayee) return "Settled — the payout has been sent to your address.";
      if (isPayer) return "Released. This escrow is final.";
      return "Settled. This escrow is final.";
    case "Cancelled":
      return "Cancelled before funding — no money was ever locked.";
    case "Refunded":
      return "Refunded to the payer. This escrow is final.";
    default:
      return "";
  }
}

const STATE_TONE: Record<string, "neutral" | "brand" | "success" | "warning" | "danger"> = {
  Created: "warning",
  Funded: "brand",
  Disputed: "danger",
  Completed: "success",
  Cancelled: "neutral",
  Refunded: "neutral",
};

export function MyRecordsView({ chainId, onOpen }: { chainId: number; onOpen: (id: bigint) => void }) {
  const { address, isConnected } = useAccount();
  // Bound to the active chain — a bare usePublicClient() would default to
  // Base mainnet and return an empty inbox on Base Sepolia.
  const publicClient = usePublicClient({ chainId: asChainId(chainId) });
  const contract = escrowAddressFor(chainId);

  const [rowsState, setRowsState] = useState<{ key: string; rows: EscrowCreatedEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** id -> state name, read in ONE multicall instead of one eth_call per row. */
  const [statesState, setStatesState] = useState<{ key: string; map: Record<string, string> } | null>(null);

  // Inbox identity: rows and state maps are stored against it, so switching
  // wallet or chain derives an empty inbox immediately (skeleton) instead of
  // showing the previous account's escrows — no reset inside the effect.
  const inboxKey = `${address ?? "none"}:${chainId}:${contract ?? "none"}`;
  const rows = rowsState?.key === inboxKey ? rowsState.rows : null;
  const states = statesState?.key === inboxKey ? statesState.map : null;

  /**
   * State is not in the EscrowCreated event, so it has to be read. Doing it
   * per row was one eth_call per record (an N+1 against a rate-limited public
   * RPC); `multicall` folds them into a single request and the result lands
   * in one map keyed by id. Falls back to per-row reads if Multicall3 is
   * unavailable on the chain.
   */
  const readStates = useMemo(
    () => async (list: EscrowCreatedEntry[]) => {
      if (!publicClient || !contract || list.length === 0) {
        setStatesState({ key: inboxKey, map: {} });
        return;
      }
      const ids = list.map((r) => r.id);
      try {
        const results = await publicClient.multicall({
          allowFailure: true,
          contracts: ids.map((id) => ({
            address: contract,
            abi: ESCROW_ABI,
            functionName: "getEscrow",
            args: [id],
          })),
        });
        const map: Record<string, string> = {};
        results.forEach((r, i) => {
          const key = String(ids[i]);
          if (r.status === "success" && r.result && typeof r.result === "object") {
            const idx = Number((r.result as { state: number | bigint }).state);
            map[key] = ESCROW_STATE_NAMES[idx] ?? "None";
          } else {
            map[key] = "None";
          }
        });
        setStatesState({ key: inboxKey, map });
      } catch {
        // Multicall unsupported / unreachable: one call per row still works.
        try {
          const map: Record<string, string> = {};
          await Promise.all(
            ids.map(async (id) => {
              try {
                const res = (await publicClient.readContract({
                  address: contract,
                  abi: ESCROW_ABI,
                  functionName: "getEscrow",
                  args: [id],
                })) as { state: number | bigint };
                map[String(id)] = ESCROW_STATE_NAMES[Number(res.state)] ?? "None";
              } catch {
                map[String(id)] = "None";
              }
            }),
          );
          setStatesState({ key: inboxKey, map });
        } catch {
          /* leave the previous map in place rather than blanking badges */
        }
      }
    },
    [publicClient, contract, inboxKey],
  );

  const load = useMemo(
    () => async (opts: { force?: boolean; silent?: boolean } = {}) => {
      if (!publicClient || !contract || !address) return;
      if (!opts.silent) setRefreshing(true);
      setError(null);
      try {
        const found = await getEscrowsForAccount(publicClient, contract, address as Address, chainId, {
          force: opts.force,
        });
        setRowsState({ key: inboxKey, rows: found });
        void readStates(found);
      } catch (e) {
        if (!opts.silent) {
          setError(e instanceof Error ? e.message : "Could not read on-chain events.");
        }
      } finally {
        setRefreshing(false);
      }
    },
    [publicClient, contract, address, chainId, readStates, inboxKey],
  );

  // First paint: use the local index so the inbox appears immediately. Rows
  // and state maps are keyed by inbox identity, so a wallet or chain switch
  // derives an empty inbox on its own — nothing to blank out here. The scan
  // itself is scheduled, not run: an effect must not cascade a render.
  useEffect(() => {
    if (!isConnected || !address || !contract) return;
    const t = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(t);
  }, [isConnected, address, contract, load]);

  // Live refresh: a new block can carry a fund/confirm/dispute. The scan is
  // incremental (from the cached block), so this costs one getLogs, not a
  // full rescan — and it never steals focus from the user.
  useEffect(() => {
    if (!publicClient || !contract || !address) return;
    let alive = true;
    let inflight = false;
    try {
      const unwatch = publicClient.watchBlockNumber({
        poll: true,
        pollingInterval: 15_000,
        onBlockNumber: () => {
          if (!alive || inflight) return;
          inflight = true;
          void load({ silent: true }).finally(() => {
            inflight = false;
          });
        },
      });
      return () => {
        alive = false;
        unwatch();
      };
    } catch {
      // watchBlockNumber is a nicety — a client without it just stays manual.
      return () => {
        alive = false;
      };
    }
  }, [publicClient, contract, address, load]);

  // ── Guards ──────────────────────────────────────────────
  // The chain's deploy block missing or 0: the scan would start at genesis,
  // every public RPC refuses that range, and the inbox looks simply empty.
  // Say so instead of pretending the wallet has no escrows.
  if (!isDeployBlockConfigured(chainId)) {
    const key = deployBlockEnvKey(chainId);
    return (
      <AlertBox
        variant="warning"
        code="E08"
        title="Deployment block not configured"
        description={`This build is missing ${key}, so the app cannot bound its event scan on this chain. Records are unavailable until it is set — no escrow data has been lost.`}
        details={`Expected ${key} in web/.env — current value: "${String((import.meta.env as Record<string, string | undefined>)[key] ?? "")}"`}
      />
    );
  }

  if (!contract) {
    return (
      <EmptyState
        icon={<IconMissingRecord size={30} strokeWidth={3} />}
        eyebrow="Wrong network"
        title="Not deployed here"
        description="Bond has no contract on this chain yet. Switch your wallet to Base or Base Sepolia."
      />
    );
  }

  if (!isConnected) {
    return (
      <EmptyState
        icon={<IconWallet size={30} strokeWidth={3} />}
        eyebrow="Wallet required"
        title="Connect your wallet"
        description="Your wallet address is the key: Bond reads the chain to list every escrow you are party to — payer, payee or arbiter — without an account or a server."
        action={{ label: "Connect wallet in the header", onClick: () => window.scrollTo({ top: 0, behavior: "smooth" }) }}
      />
    );
  }

  // ── Header ──────────────────────────────────────────────
  return (
    <div className="stack gap-5" style={{ maxWidth: 900 }}>
      <div className="stack gap-2">
        <span className="eyebrow">On-chain inbox · no account required</span>
        <h1 style={{ fontSize: "var(--text-xl)", lineHeight: 1.05 }}>My records</h1>
        <p className="muted" style={{ fontSize: "var(--text-sm)", maxWidth: 620, lineHeight: 1.7 }}>
          Every escrow this wallet is party to, read straight from{" "}
          <span className="mono">EscrowCreated</span> events on Base. Nothing is stored on our side —
          if the chain knows it, this page shows it.
        </p>
      </div>

      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span className="small muted mono">
          {shortAddress(address ?? "—")} · {contract ? shortAddress(contract) : ""}
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

      {error && (
        <AlertBox
          variant="error"
          code="E08"
          title="Could not read the chain"
          description="The RPC endpoint did not answer. Nothing is wrong with your escrows — retry in a moment."
          action={{ label: "Retry", onClick: () => void load() }}
          details={error}
        />
      )}

      {rows === null && !error && <CardSkeleton lines={4} />}

      {rows !== null && rows.length === 0 && !error && (
        <EmptyState
          icon={<IconInbox size={30} strokeWidth={3} />}
          eyebrow="Inbox empty"
          title="No escrows yet"
          description="Create one from the front page, or ask the sender to share the link — as soon as the escrow is created on-chain, it will appear here automatically."
          action={{ label: "Create an escrow link", onClick: () => (window.location.href = "/?view=create") }}
        />
      )}

      {rows !== null && rows.length > 0 && (
        <div className="stack gap-3">
          <div className="eyebrow">{rows.length} record{rows.length === 1 ? "" : "s"}</div>
          {rows.map((row) => (
            <RecordRow
              key={String(row.id)}
              row={row}
              chainId={chainId}
              stateName={states?.[String(row.id)] ?? null}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RecordRow({
  row,
  chainId,
  stateName,
  onOpen,
}: {
  row: EscrowCreatedEntry;
  chainId: number;
  /** State name from the parent's single multicall, or null while reading. */
  stateName: string | null;
  onOpen: (id: bigint) => void;
}) {
  const contract = escrowAddressFor(chainId);

  const deadline = new Date(Number(row.deadline) * 1000);
  const roleBadges = row.roles.map((r) => (
    <Badge key={r} tone={ROLE_TONE[r]}>
      {ROLE_LABEL[r]}
    </Badge>
  ));

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
            {/* Stretched link: one real anchor covering the whole card, so the
                markup stays valid (an <a> inside a <button> is not allowed),
                the row is keyboard reachable, and it can open in a new tab. */}
            <a href={`?escrow=${String(row.id)}`} className="record-row__open" onClick={(e) => {
              e.preventDefault();
              onOpen(row.id);
            }}>
              <span style={{ fontWeight: 650 }}>
                {row.description || <span className="muted">No description</span>}
              </span>
            </a>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {roleBadges}
            {stateName && <Badge tone={STATE_TONE[stateName] ?? "neutral"}>{stateName}</Badge>}
          </div>
          <div className="small muted" style={{ lineHeight: 1.6 }}>
            {stateName ? nextStep(stateName, row.roles) : "Reading state from chain…"}
          </div>
        </div>

        <div className="stack" style={{ alignItems: "flex-end", gap: 6 }}>
          <span className="tnum" style={{ fontSize: "var(--text-lg)", fontWeight: 800 }}>
            {formatUsdc(row.amount)} <span className="small muted">USDC</span>
          </span>
          <span className="small muted">deadline {deadline.toLocaleDateString()}</span>
          <span className="small row gap-1" style={{ color: "var(--brand)", fontWeight: 700 }} aria-hidden>
            OPEN
            <IconExternal size={11} strokeWidth={3} />
          </span>
        </div>
      </div>

      <div
        className="row small muted mono"
        style={{ gap: 14, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}
      >
        <span>
          payee {shortAddress(row.payee)}
        </span>
        <span>
          arbiter {shortAddress(row.arbiter)}
        </span>
        <a
          href={explorerAddressUrl(chainId, contract!)}
          target="_blank"
          rel="noopener noreferrer"
          className="record-row__stop"
          onClick={(e) => e.stopPropagation()}
          style={{ display: "inline-flex", gap: 5, alignItems: "center" }}
        >
          contract
          <IconExternal size={11} strokeWidth={3} />
        </a>
      </div>
    </div>
  );
}
