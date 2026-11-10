import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWalletClient } from "wagmi";
import { type Address } from "viem";
import { TxButton } from "../../components/ui/TxButton";
import { TxStatusCard } from "../../components/ui/TxStatusCard";
import { AlertBox } from "../../components/ui/AlertBox";
import { Badge, CardSkeleton, EmptyState } from "../../components/ui/Feedback";
import { IconExternal, IconMissingRecord } from "../../components/ui/Icons";
import { useToast } from "../../components/ui/toast-context";
import { runTx, IDLE_TX, type TxState } from "../../lib/tx";
import { EscrowTimeline } from "./EscrowTimeline";
import { EvidenceDossier } from "./EvidenceDossier";
import { ContractVerifyCard } from "./ContractVerifyCard";
import { ShareCard } from "./ShareCard";
import { MilestonesCard } from "./MilestonesCard";
import { GaslessReleaseCard } from "./GaslessReleaseCard";
import { EvidenceAnchorCard } from "./EvidenceAnchorCard";
import { ESCROW_ABI, ESCROW_STATE_NAMES, USDC_ADDRESS } from "../../lib/contracts";
import { escrowAddressFor } from "../../lib/contracts";
import { getContractLedger, reputationFor, reputationBadge, type LedgerEntry } from "../../lib/reputation";
import { explorerAddressUrl, asChainId } from "../../lib/chains";
import { formatUsdc, shortAddress, deadlineLabel } from "../../lib/format";

type StateName = (typeof ESCROW_STATE_NAMES)[number];

const STATE_BADGE: Record<string, { tone: "neutral" | "brand" | "success" | "warning" | "danger"; label: string }> = {
  None: { tone: "neutral", label: "Not found" },
  Created: { tone: "warning", label: "Awaiting funding" },
  Funded: { tone: "brand", label: "Funds locked" },
  Disputed: { tone: "danger", label: "In dispute" },
  Completed: { tone: "success", label: "Completed" },
  Cancelled: { tone: "neutral", label: "Cancelled" },
  Refunded: { tone: "neutral", label: "Refunded" },
};

const STATE_EXPLANATION: Record<string, string> = {
  Created: "The payer has not locked the funds yet. Nothing is at risk — this escrow can still be cancelled.",
  Funded: "The amount is locked in the contract. The payer can confirm delivery, or either party can open a dispute.",
  Disputed:
    "The arbiter is reviewing this escrow. Settlement is paused for a published 7-day window; if they stay silent, the plain timeout rule takes over again.",
  Completed: "Funds have been released to the payee. This escrow is final.",
  Cancelled: "This escrow was cancelled before funding. No money was ever locked.",
  Refunded: "The full amount was returned to the payer. This escrow is final.",
};

interface EscrowRecord {
  payer: Address;
  payee: Address;
  arbiter: Address;
  amount: bigint;
  feeBps: number;
  deadline: number;
  createdAt: number;
  /** 0 until a dispute opens; starts the arbiter's published window. */
  disputedAt: number;
  /** True when payee AND arbiter signed the EIP-712 terms off-chain. */
  consented: boolean;
  state: number;
  description: string;
}

export function EscrowDetailView({
  id,
  chainId,
  watchOnly = false,
}: {
  id: bigint;
  chainId: number;
  /** Read-only rendering: every action hidden regardless of the wallet. */
  watchOnly?: boolean;
}) {
  const { address } = useAccount();
  const contract = escrowAddressFor(chainId);
  // Bound to the active chain (a bare call defaults to Base mainnet).
  const publicClient = usePublicClient({ chainId: asChainId(chainId) });
  const { data: walletClient } = useWalletClient();
  const toast = useToast();

  const [tx, setTx] = useState<TxState>(IDLE_TX);
  const [approvalTx, setApprovalTx] = useState<TxState>(IDLE_TX);
  const [approveDone, setApproveDone] = useState(false);

  // ── Read: the escrow itself ──────────────────────────────
  const escrowQuery = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "getEscrow",
    args: [id],
    chainId: asChainId(chainId),
    // Live: the counterparty's transaction must show up without a manual
    // refresh — this is how a payee learns the payer just locked funds.
    query: { enabled: !!contract, retry: 2, refetchInterval: 8_000 },
  });

  // viem decodes uint256 as bigint — normalize the fields we render as
  // numbers so date maths never mixes BigInt with Number (E-crash).
  const record = useMemo(() => {
    const raw = escrowQuery.data as EscrowRecord | undefined;
    if (!raw) return undefined;
    return {
      ...raw,
      deadline: Number(raw.deadline),
      createdAt: Number(raw.createdAt),
      disputedAt: Number(raw.disputedAt ?? 0),
    };
  }, [escrowQuery.data]);

  // ── Read: may ANYONE run the timeout right now? ──────────
  // The contract owns this answer (v2 made the sweep permissionless), so the
  // button can never disagree with what the chain will actually accept — no
  // client-side clock guessing against a reorged timestamp.
  const timeoutReady = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "canClaimTimeout",
    args: [id],
    chainId: asChainId(chainId),
    query: { enabled: !!contract, retry: 2, refetchInterval: 15_000 },
  });
  const canSweep = timeoutReady.data === true;

  // ── Read: USDC allowance (drives the two-step E05 flow) ──
  const usdc = USDC_ADDRESS[chainId];

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: usdc,
    abi: [
      {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
        ],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "allowance",
    args: address && contract ? [address, contract] : undefined,
    chainId: asChainId(chainId),
    query: { enabled: !!address && !!contract && !!usdc },
  });

  // ── Read: is the payee a contract? (E12 — informational) ─
  // Keyed by payee: a missing record or client derives "unknown" instead of
  // clearing state inside the effect, and a refresh keeps the last answer.
  const [bytecode, setBytecode] = useState<{ payee: string; value: boolean | null } | null>(null);
  useEffect(() => {
    if (!record || !publicClient) return;
    const ac = new AbortController();
    const payee = record.payee;
    void publicClient
      .getBytecode({ address: payee })
      .then((code) => {
        if (!ac.signal.aborted) setBytecode({ payee, value: code !== undefined && code !== "0x" });
      })
      .catch(() => {
        if (!ac.signal.aborted) setBytecode({ payee, value: null });
      });
    return () => ac.abort();
  }, [record, publicClient]);

  const payeeIsContract = bytecode && record && bytecode.payee === record.payee ? bytecode.value : null;

  // ── Read: contract ledger (powers the reputation badges) ──
  // One scan feeds all three parties; keyed by identity so a chain or
  // contract switch starts empty instead of showing the old chain's counts.
  const [ledger, setLedger] = useState<{ key: string; rows: LedgerEntry[] } | null>(null);
  const ledgerKey = `${chainId}:${contract ?? "none"}`;
  useEffect(() => {
    if (!publicClient || !contract) return;
    const ac = new AbortController();
    getContractLedger(publicClient, contract, chainId)
      .then((rows) => {
        if (!ac.signal.aborted) setLedger({ key: ledgerKey, rows });
      })
      .catch(() => {
        // Badges are decoration: a refused log query must never break the
        // escrow page, so the failure simply leaves them unrendered.
        if (!ac.signal.aborted) setLedger({ key: ledgerKey, rows: [] });
      });
    return () => ac.abort();
  }, [publicClient, contract, chainId, ledgerKey]);

  // Derived per render: badges appear only once BOTH the ledger and the
  // escrow (which names the parties) have arrived.
  const partyBadges = useMemo(() => {
    if (!record || !ledger || ledger.key !== ledgerKey) return null;
    const stats = {
      payer: reputationFor(ledger.rows, record.payer),
      payee: reputationFor(ledger.rows, record.payee),
      arbiter: reputationFor(ledger.rows, record.arbiter),
    };
    return {
      payer: reputationBadge("payer", stats.payer),
      payee: reputationBadge("payee", stats.payee),
      arbiter: reputationBadge("arbiter", stats.arbiter),
    };
  }, [record, ledger, ledgerKey]);

  const stateName: StateName = ESCROW_STATE_NAMES[record?.state ?? 0] ?? "None";
  const badge = STATE_BADGE[stateName];

  // Live notice: tell the connected party the moment the on-chain state
  // changes under them (payer funded / payee disputed / arbiter resolved).
  // First render only seeds the ref — no toast for the state you arrived on.
  const lastState = useRef<StateName | null>(null);
  useEffect(() => {
    if (lastState.current === null) {
      lastState.current = stateName;
      return;
    }
    if (lastState.current !== stateName) {
      lastState.current = stateName;
      toast.success(`Escrow #${id.toString()} is now ${badge.label}`, STATE_EXPLANATION[stateName]);
    }
  }, [stateName, badge.label, id, toast]);

  const role = useMemo(() => {
    if (!address || !record) return "observer" as const;
    const a = address.toLowerCase();
    if (a === record.payer.toLowerCase()) return "payer" as const;
    if (a === record.payee.toLowerCase()) return "payee" as const;
    if (a === record.arbiter.toLowerCase()) return "arbiter" as const;
    return "observer" as const;
  }, [address, record]);

  // Watch-only downgrades every gate to the spectator's seat: the wallet may
  // even hold the payer's key, and this view still offers nothing to sign.
  const actionRole = watchOnly ? ("observer" as const) : role;

  const needsApproval =
    stateName === "Created" &&
    role === "payer" &&
    record !== undefined &&
    ((allowance as bigint | undefined) ?? 0n) < record.amount &&
    !approveDone;

  const deadline = record ? deadlineLabel(record.deadline) : null;
  const feeAmount = record ? (record.amount * BigInt(record.feeBps)) / 10_000n : 0n;

  // ── Breakdown, state-aware ─────────────────────────────
  // The nominal split (fee, payee share) only holds for a plain confirm.
  // An arbiter can move the split — the actuals live in the DisputeResolved
  // event — a refund pays nobody, and a cancelled escrow locked nothing,
  // so every terminal state states its own outcome instead of the
  // hypothetical one. `undefined` = ledger still scanning,
  // `null` = scan finished with no ruling row.
  const ruling: LedgerEntry | null | undefined =
    stateName === "Completed" && record?.disputedAt
      ? ledger && ledger.key === ledgerKey
        ? (ledger.rows.find((e) => e.kind === "DisputeResolved" && e.id === id) ?? null)
        : undefined
      : null;

  // ── Writers ──────────────────────────────────────────────
  async function act(fn: string, args: unknown[], opts?: { label?: string; success?: string }) {
    if (!contract || !publicClient || !walletClient || !address) {
      toast.warning("Connect your wallet", "A connected wallet is required for this action.");
      return;
    }
    const result = await runTx(
      // `contract` is the escrow contract; `address` is only the sender account.
      { abi: ESCROW_ABI, address: contract, functionName: fn, args },
      { publicClient, walletClient, account: address, chainId, onSuccess: () => void refresh() },
      setTx,
    );
    if (!result.ok) {
      if (result.error?.code === "E03") toast.neutral("Signature declined", "Nothing was sent.");
      return;
    }
    toast.success(opts?.success ?? `${opts?.label ?? fn} confirmed`);
  }

  async function approve() {
    if (!contract || !publicClient || !walletClient || !address || !usdc || !record) return;
    const result = await runTx(
      {
        abi: [
          {
            type: "function",
            name: "approve",
            stateMutability: "nonpayable",
            inputs: [
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ type: "bool" }],
          },
        ] as const,
        address: usdc,
        functionName: "approve",
        args: [contract, record.amount],
      },
      {
        publicClient,
        walletClient,
        account: address,
        chainId,
        onSuccess: () => {
          void refetchAllowance();
          setApproveDone(true);
        },
      },
      setApprovalTx,
    );
    if (!result.ok && result.error?.code === "E03") toast.neutral("Signature declined", "Nothing was sent.");
    if (result.ok) toast.success("USDC approved", "Now lock the funds into the escrow.");
  }

  async function refresh() {
    await escrowQuery.refetch();
    await refetchAllowance();
  }

  // ── Guards ───────────────────────────────────────────────
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

  if (escrowQuery.isPending) {
    return (
      <div className="stack gap-4" style={{ maxWidth: 760 }}>
        <CardSkeleton lines={4} />
      </div>
    );
  }

  if (escrowQuery.isError || !record) {
    return (
      <EmptyState
        icon={<IconMissingRecord size={30} />}
        eyebrow="No record"
        title="Escrow not found"
        description={`No escrow #${id.toString()} exists on this contract. The link may be wrong, from another network, or a different deployment.`}
        action={{ label: "Create a new link", onClick: () => window.location.assign("/?view=create") }}
        secondary={{ label: "Try again", onClick: () => void escrowQuery.refetch() }}
      />
    );
  }

  const terminal = stateName === "Completed" || stateName === "Cancelled" || stateName === "Refunded";

  return (
    <div className="stack gap-6" style={{ maxWidth: 860 }}>
      {/* ── Watch-only: say so before anything else ─────── */}
      {watchOnly && (
        <AlertBox
          variant="info"
          title="Watch-only mode"
          description="This record is open with every action hidden, so nothing can be signed by accident from this view. The chain data is identical — only the buttons are gone."
          action={{ label: "Exit watch-only", onClick: () => window.location.assign(`?escrow=${id.toString()}`) }}
        />
      )}

      {/* ── Header card ──────────────────────────────────── */}
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div className="row gap-4" style={{ minWidth: 0 }}>
            <div>
              <div className="row gap-3" style={{ flexWrap: "wrap" }}>
                <h1 style={{ fontSize: "var(--text-xl)" }}>Escrow #{id.toString()}</h1>
                <Badge tone={badge.tone}>{badge.label}</Badge>
                {/* v2: consent is a property of the escrow, not of trust —
                    both counterparties signed these exact terms off-chain. */}
                {record.consented && <Badge tone="brand">Terms co-signed</Badge>}
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                Created {new Date(record.createdAt * 1000).toLocaleString()}
                {record.description && (
                  <>
                    {" · "}
                    <span style={{ color: "var(--text-2)" }}>{record.description}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div style={{ textAlign: "right" }}>
            <div className="tnum" style={{ fontSize: "var(--text-2xl)", fontWeight: 660, letterSpacing: "-0.03em" }}>
              {formatUsdc(record.amount)}
            </div>
            <div className="small muted tnum">USDC · fee {Number(record.feeBps) / 100}%</div>
          </div>
        </div>

        {/* Progress strip */}
        <div className="row gap-2" style={{ marginTop: 22, flexWrap: "wrap" }}>
          {(["Created", "Funded", stateName] as string[]).map((s, i) => {
            const active = i < 2 || terminal || s === stateName;
            const tone = terminal ? "var(--success)" : "var(--brand)";
            return (
              <div key={`${s}-${i}`} className="row gap-2" style={{ flex: "1 1 120px", minWidth: 100 }}>
                <div
                  style={{
                    height: 5,
                    flex: 1,
                    borderRadius: 3,
                    background: active ? tone : "var(--bg-inset)",
                    transition: "background 300ms var(--ease)",
                  }}
                />
                <span className="small" style={{ color: active ? "var(--text-1)" : "var(--text-3)", fontWeight: 570 }}>
                  {i === 0 ? "Created" : i === 1 ? "Funded" : STATE_BADGE[stateName].label}
                </span>
              </div>
            );
          })}
        </div>

        {deadline && (
          <div className="row gap-2" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <Badge tone={deadline.urgent ? "warning" : "neutral"}>{deadline.text}</Badge>
            {watchOnly ? (
              <Badge tone="neutral">Watch-only view</Badge>
            ) : (
              role !== "observer" && <Badge tone="neutral">You are the {role}</Badge>
            )}
          </div>
        )}
      </div>

      {/* ── State explanation ────────────────────────────── */}
      {STATE_EXPLANATION[stateName] && (
        <AlertBox
          variant={stateName === "Disputed" ? "warning" : stateName === "Funded" || stateName === "Created" ? "info" : "success"}
          title={badge.label}
          description={STATE_EXPLANATION[stateName]}
        />
      )}

      {/* ── E12: payee is a contract, not an EOA ─────────── */}
      {payeeIsContract && stateName !== "Completed" && (
        <AlertBox
          variant="info"
          title="The payee is a smart contract"
          description="This address is a contract (multisig, Safe, or app). That is fine — just confirm it is the one you intend, since contract wallets can have custom withdrawal rules."
        />
      )}

      {/* ── v3: the slice ledger — empty card for plain escrows ── */}
      <MilestonesCard
        id={id}
        chainId={chainId}
        contract={contract}
        feeBps={record.feeBps}
        stateName={stateName}
        role={role}
        watchOnly={watchOnly}
        tx={tx}
        act={act}
      />

      {/* ── Transaction feedback ─────────────────────────── */}
      <TxStatusCard
        state={approvalTx}
        chainId={chainId}
        onReset={() => setApprovalTx(IDLE_TX)}
        successTitle="USDC approved"
        successDescription="You can now lock the funds."
      />
      <TxStatusCard
        state={tx}
        chainId={chainId}
        onReset={() => setTx(IDLE_TX)}
        successTitle="Transaction confirmed"
        successDescription="The escrow state has been updated."
      />

      {/* ── Actions ──────────────────────────────────────── */}
      {!terminal && (
        <div className="card">
          <h3 style={{ marginBottom: 6 }}>Actions</h3>
          <p className="small muted" style={{ marginBottom: 18 }}>
            {watchOnly
              ? "Watch-only mode: the record is fully readable, but every action is hidden."
              : actionRole === "observer"
                ? "You are viewing this escrow as a spectator. Only the payer, payee and arbiter can act — though the timeout sweep below is open to everyone."
                : `Connected as the ${actionRole}.`}
          </p>

          {actionRole === "observer" ? (
            <AlertBox
              variant="info"
              title={watchOnly ? "Actions hidden by watch-only mode" : "Read-only view"}
              description={
                watchOnly
                  ? "Exit watch-only mode to act on this escrow from this device. Nothing is lost — the record stays exactly as it is."
                  : "Connect the payer, payee or arbiter wallet to unlock this escrow's actions. The timeout sweep below stays open to anyone once its window opens."
              }
              action={
                watchOnly
                  ? { label: "Exit watch-only", onClick: () => window.location.assign(`?escrow=${id.toString()}`) }
                  : undefined
              }
            />
          ) : (
            <div className="stack gap-4">
              {/* E05 — two-step approve -> fund */}
              {stateName === "Created" && actionRole === "payer" && needsApproval && (
                <AlertBox
                  variant="info"
                  title="Step 1 of 2: approve USDC"
                  description={`Your allowance is below ${formatUsdc(record.amount)} USDC. Approve the contract first, then lock the funds — two signatures, no extra cost.`}
                />
              )}

              {/* Locked: explain the loss of the cancel option, by state. */}
              {stateName === "Funded" && actionRole === "payer" && (
                <AlertBox
                  variant="info"
                  title="Locked — this escrow can no longer be cancelled"
                  description="Cancel only exists before funding. Your options now: confirm delivery to release, open a dispute for the arbiter to split, or reclaim after the deadline plus a 48-hour grace period if nobody acts."
                />
              )}

              {stateName !== "Disputed" && actionRole === "arbiter" && (
                <AlertBox
                  variant="info"
                  title="The arbiter steps in only when a dispute is open"
                  description="Nothing needs your ruling yet. If either party opens a dispute, this page will show your split panel."
                />
              )}

              <div className="row gap-3" style={{ flexWrap: "wrap" }}>
                {stateName === "Created" && actionRole === "payer" && (
                  <>
                    {needsApproval ? (
                      <TxButton
                        label={`Approve ${formatUsdc(record.amount)} USDC`}
                        busyLabel="Approving…"
                        state={approvalTx}
                        onClick={approve}
                      />
                    ) : (
                      <TxButton
                        label="Fund escrow (lock USDC)"
                        busyLabel="Locking…"
                        state={tx}
                        onClick={() => act("fund", [id], { success: "Funds locked" })}
                      />
                    )}
                    <TxButton
                      label="Cancel escrow"
                      variant="secondary"
                      state={tx}
                      onClick={() => act("cancel", [id], { success: "Escrow cancelled" })}
                    />
                  </>
                )}

                {stateName === "Funded" && actionRole === "payer" && (
                  <>
                    <TxButton
                      label="Confirm delivery & release"
                      state={tx}
                      onClick={() => act("confirm", [id], { success: "Funds released to payee" })}
                    />
                    <TxButton
                      label="Open dispute"
                      variant="secondary"
                      state={tx}
                      onClick={() => act("openDispute", [id], { success: "Dispute opened" })}
                    />
                  </>
                )}

                {stateName === "Funded" && actionRole === "payee" && (
                  <TxButton
                    label="Open dispute"
                    variant="secondary"
                    state={tx}
                    onClick={() => act("openDispute", [id], { success: "Dispute opened" })}
                  />
                )}

                {stateName === "Disputed" && actionRole === "arbiter" && (
                  <ArbiterPanel onResolve={(bps) => act("resolveDispute", [id, bps], { success: "Dispute resolved" })} tx={tx} />
                )}

                {stateName === "Disputed" && actionRole !== "arbiter" && (
                  <AlertBox
                    variant="warning"
                    title="Waiting for the arbiter"
                    description="The arbiter must resolve this dispute. Only they can split the funds."
                  />
                )}
              </div>
            </div>
          )}

          {/* ── v2: the timeout sweep is permissionless ────────
              Anyone may run it — the payout is fixed by the escrow
              itself (everything returns to the payer), so a spectator
              can clear an abandoned link without being able to profit
              from or redirect it. */}
          {canSweep && (
            <div className="stack gap-3" style={{ marginTop: 18 }}>
              <AlertBox
                variant="info"
                title="Deadline and grace period have passed"
                description={
                  stateName === "Disputed"
                    ? "The arbiter's 7-day window has closed without a ruling, so the plain timeout rule applies again. Anyone can execute it and the full amount returns to the payer."
                    : "Nobody confirmed or disputed before the deadline plus its 48-hour grace period. Anyone can execute the timeout and the full amount returns to the payer, fee-free."
                }
              />
              {/* The button itself is a signature — watch-only keeps the
                  fact visible and drops the affordance. */}
              {!watchOnly && (
                <div>
                  <TxButton
                    label="Execute timeout (funds return to payer)"
                    variant="danger"
                    state={tx}
                    onClick={() => act("claimTimeout", [id], { success: "Timeout executed" })}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── v3: sign off-chain, file with anyone's gas ──────── */}
      {!terminal && stateName === "Funded" && !watchOnly && (
        <GaslessReleaseCard id={id} chainId={chainId} contract={contract} role={role} tx={tx} act={act} />
      )}

      {/* ── Breakdown & links ────────────────────────────── */}
      <div className="row gap-4" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div className="card card--flat" style={{ flex: "1 1 300px" }}>
          <h3 style={{ marginBottom: 14 }}>Breakdown</h3>
          <Row label="Amount" value={`${formatUsdc(record.amount)} USDC`} />
          {stateName === "Cancelled" ? (
            <>
              <Row label="Locked in contract" value="0 USDC" />
              <Row label="Payee receives" value="0 USDC" strong />
            </>
          ) : stateName === "Refunded" ? (
            <>
              <Row label={`Protocol fee (${Number(record.feeBps) / 100}%)`} value="0 USDC" />
              <Row label="Returned to payer" value={`${formatUsdc(record.amount)} USDC`} />
              <Row label="Payee receives" value="0 USDC" strong />
            </>
          ) : stateName === "Disputed" ? (
            <Row label="Outcome" value="Awaiting arbiter ruling" strong />
          ) : stateName === "Completed" && record.disputedAt > 0 ? (
            ruling === undefined ? (
              <Row label="Settlement" value="reading…" />
            ) : ruling === null || ruling.payerAmount === undefined ? (
              <Row label="Settlement" value="—" />
            ) : (
              <>
                <Row
                  label={`Protocol fee (${Number(record.feeBps) / 100}%)`}
                  value={`${formatUsdc(ruling.fee ?? 0n)} USDC`}
                />
                <Row label="Returned to payer" value={`${formatUsdc(ruling.payerAmount)} USDC`} />
                <Row label="Payee receives" value={`${formatUsdc(ruling.payeeAmount ?? 0n)} USDC`} strong />
              </>
            )
          ) : (
            <>
              <Row label={`Protocol fee (${Number(record.feeBps) / 100}%)`} value={`${formatUsdc(feeAmount)} USDC`} />
              <Row label="Payee receives" value={`${formatUsdc(record.amount - feeAmount)} USDC`} strong />
            </>
          )}
          <Row label="Deadline" value={new Date(record.deadline * 1000).toLocaleString()} />
        </div>

        <div className="card card--flat" style={{ flex: "1 1 300px" }}>
          <h3 style={{ marginBottom: 14 }}>Parties</h3>
          <PartyRow label="Payer" address={record.payer} chainId={chainId} badge={partyBadges?.payer} />
          <PartyRow label="Payee" address={record.payee} chainId={chainId} badge={partyBadges?.payee} />
          <PartyRow label="Arbiter" address={record.arbiter} chainId={chainId} badge={partyBadges?.arbiter} />
          <div style={{ borderTop: "1px solid var(--border)", margin: "12px 0" }} />
          <a
            href={explorerAddressUrl(chainId, contract)}
            target="_blank"
            rel="noopener noreferrer"
            className="small"
            style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
          >
            View contract on BaseScan
            <IconExternal size={12} strokeWidth={3} />
          </a>
        </div>
      </div>

      {/* ── Share rail: link, QR, watch-only, calendar ───── */}
      <ShareCard
        id={id}
        chainId={chainId}
        deadline={record.deadline}
        amountLabel={`${formatUsdc(record.amount)} USDC`}
        terms={record.description}
        watchOnly={watchOnly}
      />

      {/* ── v3: hash-only evidence anchoring, any state ────── */}
      <EvidenceAnchorCard id={id} role={role} watchOnly={watchOnly} tx={tx} act={act} />

      {/* ── Audit trail: what happened, provable from logs ── */}
      <EscrowTimeline id={id} chainId={chainId} refreshToken={`${stateName}:${record.state}`} />

      {/* ── The dispute packet: one file, every receipt ───── */}
      <EvidenceDossier
        id={id}
        chainId={chainId}
        payer={record.payer}
        payee={record.payee}
        arbiter={record.arbiter}
        amount={record.amount}
        feeBps={record.feeBps}
        deadline={record.deadline}
        createdAt={record.createdAt}
        state={record.state}
        description={record.description}
        consented={record.consented}
      />

      {/* ── Independent verification of the deployed code ─── */}
      <ContractVerifyCard chainId={chainId} contract={contract} />
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────── */

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", padding: "7px 0", gap: 12 }}>
      <span className="small muted">{label}</span>
      <span className="small tnum" style={{ fontWeight: strong ? 650 : 570, color: "var(--text-1)" }}>
        {value}
      </span>
    </div>
  );
}

function PartyRow({
  label,
  address,
  chainId,
  badge,
}: {
  label: string;
  address: string;
  chainId: number;
  /** Counted from event logs; null while loading or when there is no history. */
  badge?: { label: string; tone: "neutral" | "brand" | "success" } | null;
}) {
  return (
    <div className="row" style={{ justifyContent: "space-between", padding: "7px 0", gap: 12 }}>
      <span className="small muted">{label}</span>
      <span
        className="row"
        style={{ gap: 8, alignItems: "center", minWidth: 0, justifyContent: "flex-end", flexWrap: "wrap" }}
      >
        {badge && (
          <span title="Counted from this contract's event logs">
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </span>
        )}
        <a
          href={explorerAddressUrl(chainId, address)}
          target="_blank"
          rel="noopener noreferrer"
          className="small mono"
          style={{ fontWeight: 570, display: "inline-flex", gap: 5, alignItems: "center", whiteSpace: "nowrap" }}
          title={address}
        >
          {shortAddress(address)}
          <IconExternal size={11} strokeWidth={3} />
        </a>
      </span>
    </div>
  );
}

function ArbiterPanel({ onResolve, tx }: { onResolve: (bps: number) => void; tx: TxState }) {
  const [choice, setChoice] = useState<string>("10000");
  const [custom, setCustom] = useState("50");

  const bps = choice === "custom" ? Math.min(10000, Math.max(0, Number(custom) || 0)) : Number(choice);

  return (
    <div className="stack gap-4" style={{ width: "100%" }}>
      <AlertBox
        variant="warning"
        title="You are the arbiter"
        description="Choose how the locked amount is split. The protocol fee applies only to the payee's share."
      />

      <div className="stack gap-2">
        {[
          { v: "10000", label: "Payee takes 100% — work was delivered" },
          { v: "6000", label: "60% payee / 40% payer — partial delivery" },
          { v: "0", label: "Payer takes 100% — work not delivered" },
          { v: "custom", label: "Custom split" },
        ].map((o) => (
          <label
            key={o.v}
            className="row gap-3"
            style={{
              border: `1px solid ${choice === o.v ? "var(--brand)" : "var(--border)"}`,
              background: choice === o.v ? "var(--brand-softer)" : "var(--bg-card)",
              borderRadius: 0,
              padding: "12px 14px",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name="split"
              value={o.v}
              checked={choice === o.v}
              onChange={() => setChoice(o.v)}
              style={{ accentColor: "var(--brand)" }}
            />
            <span className="small" style={{ fontWeight: 570 }}>
              {o.label}
            </span>
          </label>
        ))}

        {choice === "custom" && (
          <div className="field" style={{ maxWidth: 220 }}>
            <label className="field__label">Payee share (bps, 0–10000)</label>
            <input
              className="field__input tnum"
              inputMode="numeric"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <span className="field__hint">10000 = payee takes everything</span>
          </div>
        )}
      </div>

      <div className="row gap-3" style={{ flexWrap: "wrap" }}>
        <TxButton
          label={`Resolve — payee gets ${bps / 100}%`}
          busyLabel="Resolving…"
          state={tx}
          variant={bps === 0 ? "danger" : "primary"}
          onClick={() => onResolve(bps)}
        />
      </div>
    </div>
  );
}
