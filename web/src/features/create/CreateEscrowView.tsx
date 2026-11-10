import { useMemo, useState } from "react";
import { parseUnits, isAddress, zeroAddress, decodeEventLog } from "viem";
import { useAccount, useReadContract, usePublicClient, useWalletClient } from "wagmi";
import { TxButton } from "../../components/ui/TxButton";
import { TxStatusCard } from "../../components/ui/TxStatusCard";
import { AlertBox } from "../../components/ui/AlertBox";
import { useToast } from "../../components/ui/toast-context";
import { runTx, IDLE_TX, type TxState } from "../../lib/tx";
import { FORM_INVALID, WALLET_REQUIRED } from "../../lib/errors";
import {
  ESCROW_ABI,
  USDC_ADDRESS,
  USDC_DECIMALS,
  FEE_BPS,
  buildEscrowLink,
} from "../../lib/contracts";
import { chainLabel, asChainId } from "../../lib/chains";
import { formatUsdc } from "../../lib/format";
import { EscrowCreatedCard } from "./EscrowCreatedCard";

interface FormValues {
  payee: string;
  amount: string;
  deadlineDays: string;
  description: string;
  arbiter: string;
}

const EMPTY: FormValues = { payee: "", amount: "", deadlineDays: "7", description: "", arbiter: "" };

/** One draft milestone row in the create form. */
interface MilestoneRow {
  title: string;
  amount: string;
  /** Days from now; empty = no target. Must never exceed the deadline. */
  dueDays: string;
}

const EMPTY_ROW: MilestoneRow = { title: "", amount: "", dueDays: "" };

/** Mirrors the contract's MAX_MILESTONES — bounds the settlement loop. */
const MAX_MILESTONES = 12;
const MAX_TITLE_BYTES = 96;

type Structure = "single" | "milestones";

/** Layer 1 errors, plus one inline message per milestone row. */
type FormErrors = Partial<Record<keyof FormValues, string>> & {
  form?: string;
  rows?: string[];
};

/** Preset amounts in USDC — sized for typical freelance settlements. */
const AMOUNT_PRESETS = ["50", "100", "500", "2500"] as const;

/** Preset durations in days, matching the lifecycle copy elsewhere. */
const DAY_PRESETS = [3, 7, 14, 30] as const;

/** Layer 1 — validation runs before any RPC or wallet call. */
function validate(
  v: FormValues,
  connected: boolean,
  structure: Structure,
  rows: MilestoneRow[],
): FormErrors {
  const e: FormErrors = {};

  if (!connected) e.form = "Connect your wallet to create an escrow link.";

  if (!v.payee.trim()) e.payee = "Enter the recipient address.";
  else if (!isAddress(v.payee.trim())) e.payee = "That is not a valid 0x address.";
  else if (v.payee.trim().toLowerCase() === zeroAddress) e.payee = "The zero address cannot receive funds.";

  // In milestone mode the escrow amount is the SUM of the rows, so the
  // single-amount field is not rendered and must not gate the form.
  if (structure === "single") {
    if (!v.amount.trim()) e.amount = "Enter an amount.";
    else {
      try {
        const wei = parseUnits(v.amount, USDC_DECIMALS);
        if (wei <= 0n) e.amount = "Amount must be greater than zero.";
      } catch {
        e.amount = "Enter a valid number, up to 6 decimals.";
      }
    }
  }

  const days = Number(v.deadlineDays);
  if (!Number.isFinite(days) || days <= 0) e.deadlineDays = "Enter a number of days.";
  else if (days * 24 * 60 < 10) e.deadlineDays = "Minimum duration is 10 minutes.";
  else if (days > 365) e.deadlineDays = "Maximum duration is 365 days.";

  if (structure === "milestones") {
    const rowErrs: string[] = [];
    let any = false;
    const encoder = new TextEncoder();
    rows.forEach((r) => {
      let msg = "";
      if (!r.amount.trim()) msg = "Enter an amount.";
      else {
        try {
          const wei = parseUnits(r.amount, USDC_DECIMALS);
          if (wei <= 0n) msg = "Amount must be greater than zero.";
        } catch {
          msg = "Enter a valid number, up to 6 decimals.";
        }
      }
      if (!msg && encoder.encode(r.title).length > MAX_TITLE_BYTES) {
        msg = `Keep the title under ${MAX_TITLE_BYTES} bytes.`;
      }
      if (!msg && r.dueDays.trim()) {
        const d = Number(r.dueDays);
        if (!Number.isFinite(d) || d < 0) msg = "Due must be days from now.";
        else if (Number.isFinite(days) && d > days) msg = "Due cannot be past the deadline.";
      }
      rowErrs.push(msg);
      if (msg) any = true;
    });
    if (any) e.rows = rowErrs;
  }

  if (v.description.length > 256) e.description = "Keep the description under 256 characters.";

  if (!v.arbiter.trim()) e.arbiter = "Enter an arbiter address for disputes.";
  else if (!isAddress(v.arbiter.trim())) e.arbiter = "That is not a valid 0x address.";

  if (!e.payee && !e.arbiter && v.payee.trim().toLowerCase() === v.arbiter.trim().toLowerCase()) {
    e.arbiter = "The arbiter must be a different address than the payee.";
  }

  return e;
}

export function CreateEscrowView({ contract, chainId }: { contract?: `0x${string}`; chainId: number }) {
  const { address, isConnected } = useAccount();
  // Bound to the active chain (a bare call defaults to Base mainnet).
  const publicClient = usePublicClient({ chainId: asChainId(chainId) });
  const { data: walletClient } = useWalletClient();
  const toast = useToast();

  const [values, setValues] = useState<FormValues>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof FormValues, boolean>>>({});
  const [tx, setTx] = useState<TxState>(IDLE_TX);
  const [createdId, setCreatedId] = useState<bigint | null>(null);
  /** True once the user has pressed Create with an invalid form (E01). */
  const [formAttempted, setFormAttempted] = useState(false);
  /** Single amount vs milestone slices — the two creation entrypoints. */
  const [structure, setStructure] = useState<Structure>("single");
  const [rows, setRows] = useState<MilestoneRow[]>([{ ...EMPTY_ROW }]);
  /** Row fields validate on submit rather than per keystroke. */
  const [rowsTouched, setRowsTouched] = useState(false);

  const errors = useMemo(() => validate(values, isConnected, structure, rows), [values, isConnected, structure, rows]);
  const hasErrors = Object.keys(errors).length > 0;

  // Live USDC balance so E04 can show the shortfall before simulation.
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS[chainId],
    abi: [
      { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
    ] as const,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: asChainId(chainId),
    query: { enabled: !!address && !!USDC_ADDRESS[chainId] },
  });

  // The escrow locks the single amount, or the SUM of the milestone rows.
  const required = useMemo(() => {
    try {
      if (structure === "milestones") {
        return rows.reduce((acc, r) => (r.amount.trim() ? acc + parseUnits(r.amount, USDC_DECIMALS) : acc), 0n);
      }
      return values.amount ? parseUnits(values.amount, USDC_DECIMALS) : 0n;
    } catch {
      return 0n;
    }
  }, [values.amount, structure, rows]);

  const shortfall = balance !== undefined && required > (balance as bigint) ? required - (balance as bigint) : 0n;

  const set = (k: keyof FormValues) => (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues((p) => ({ ...p, [k]: ev.target.value }));
    setTouched((p) => ({ ...p, [k]: true }));
  };

  async function submit() {
    setTouched({ payee: true, amount: true, deadlineDays: true, arbiter: true, description: true });
    setRowsTouched(true);
    if (hasErrors || !contract || !publicClient || !walletClient || !address) {
      // Surface the matrix code instead of failing silently: the inline
      // field messages alone left the button looking broken.
      setFormAttempted(true);
      if (!contract) {
        toast.error("Not deployed here", `Bond has no contract on ${chainLabel(chainId)}.`);
      }
      return;
    }
    setFormAttempted(false);

    const payee = values.payee.trim() as `0x${string}`;
    const arbiter = values.arbiter.trim() as `0x${string}`;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.round(Number(values.deadlineDays) * 86400));

    // One entrypoint per structure — the milestone call sums the rows on
    // chain, so the client never sends an amount that could drift from it.
    const call =
      structure === "milestones"
        ? {
            functionName: "createEscrowMilestones",
            args: [
              payee,
              rows.map((r) => parseUnits(r.amount, USDC_DECIMALS)),
              rows.map((r) =>
                r.dueDays.trim()
                  ? BigInt(Math.floor(Date.now() / 1000) + Math.round(Number(r.dueDays) * 86400))
                  : 0n,
              ),
              rows.map((r) => r.title),
              deadline,
              values.description,
              arbiter,
            ] as const,
          }
        : {
            functionName: "createEscrow",
            args: [payee, parseUnits(values.amount, USDC_DECIMALS), deadline, values.description, arbiter] as const,
          };

    const result = await runTx(
      {
        abi: ESCROW_ABI,
        address: contract,
        functionName: call.functionName,
        args: call.args as unknown as unknown[],
      },
      {
        publicClient,
        walletClient,
        account: address,
        chainId,
        onSuccess: () => {
          void refetchBalance();
        },
      },
      setTx,
    );

    if (!result.ok) {
      // A declined signature is not a failure — neutral toast (E03).
      if (result.error?.code === "E03") toast.neutral("Signature declined", "Nothing was sent.");
      return;
    }

    // Read the new id straight from the EscrowCreated event.
    // Filter by contract address first: other tokens on the receipt (USDC's
    // Approval/Transfer) used to be handed to decodeEventLog and throw.
    let decodedId: bigint | null = null;
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: result.hash! });
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
          if (decoded.eventName === "EscrowCreated") {
            const args = decoded.args as unknown as { id: bigint } | undefined;
            if (args?.id !== undefined) {
              decodedId = args.id;
              break;
            }
          }
        } catch {
          /* not one of our events */
        }
      }
    } catch {
      /* receipt unavailable — the fallback card below still offers a path */
    }

    if (decodedId !== null) {
      setCreatedId(decodedId);
      toast.success("Escrow created", "Copy the link and send it to the payer.");
    } else {
      // Never drop the only shareable artifact: keep the success phase and
      // let the fallback card route the user to the record instead.
      toast.success("Escrow created", "The link could not be read from the receipt — open My records.");
    }
  }

  // ── Success: show the shareable link ─────────────────────
  if (tx.phase === "success") {
    if (createdId === null) {
      return (
        <AlertBox
          variant="success"
          code="E09"
          title="Escrow created on-chain"
          description={
            <>
              The transaction confirmed, but the escrow id could not be decoded from the receipt. The record
              is on-chain — open My records to copy its link.
            </>
          }
          action={{
            label: "Open my records",
            onClick: () => {
              window.location.href = "?view=records";
            },
          }}
          secondaryAction={{
            label: "Create another",
            onClick: () => {
              setTx(IDLE_TX);
              setValues(EMPTY);
              setTouched({});
              setStructure("single");
              setRows([{ ...EMPTY_ROW }]);
              setRowsTouched(false);
            },
          }}
        />
      );
    }
    return (
      <EscrowCreatedCard
        id={createdId}
        link={buildEscrowLink(window.location.origin, createdId)}
        onReset={() => {
          setCreatedId(null);
          setTx(IDLE_TX);
          setValues(EMPTY);
          setTouched({});
          setStructure("single");
          setRows([{ ...EMPTY_ROW }]);
          setRowsTouched(false);
        }}
      />
    );
  }

  const show = (k: keyof FormValues) => touched[k] && errors[k];
  const rowError = (i: number) => (rowsTouched || formAttempted ? errors.rows?.[i] : undefined);

  return (
    <div className="stack gap-8">
      {/* ── Hero: front page ─────────────────────────────── */}
      <div style={{ borderBottom: "4px double var(--border-ink)", paddingBottom: 36 }}>
        <div
          className="row"
          style={{ justifyContent: "space-between", gap: 24, flexWrap: "wrap", paddingBottom: 10 }}
        >
          <span className="eyebrow" style={{ color: "var(--brand)" }}>
            01 — Create escrow link
          </span>
          <span className="eyebrow">Base Mainnet &amp; Sepolia · Edition 001</span>
        </div>
        <div style={{ height: 1, background: "var(--border-ink)" }} />

        <div
          className="row"
          style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 44, marginTop: 24, flexWrap: "wrap" }}
        >
          <div style={{ maxWidth: 730 }}>
            <h1 className="fit-h1">
              Lock funds in seconds.
              <br />
              <em style={{ fontStyle: "italic", color: "var(--brand)" }}>Release on confirmation.</em>
            </h1>
            <div style={{ height: 3, background: "var(--border-ink)", margin: "22px 0 18px", maxWidth: 620 }} />
            <p
              className="dropcap"
              style={{ fontSize: "var(--text-md)", lineHeight: 1.7, maxWidth: 640, color: "var(--text-2)" }}
            >
              Create a USDC escrow on Base, share the link, and let the smart contract hold the money until the
              work is delivered. Non-custodial — Bond never touches your funds.
            </p>
          </div>

          {/* Spec block — classified record */}
          <div
            style={{
              border: "1px solid var(--border-ink)",
              background: "var(--bg-card)",
              minWidth: 258,
              boxShadow: "var(--shadow-card)",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.2em",
                textTransform: "uppercase",
                background: "var(--bg-ink)",
                color: "var(--plate-bar)",
                padding: "9px 14px",
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span>Specification</span>
              <span style={{ opacity: 0.55 }}>On record</span>
            </div>
            <SpecRow k="Settlement" v="USDC · 6 dec" />
            <SpecRow k="Protocol fee" v={`${FEE_BPS / 100}%`} />
            <SpecRow k="Max duration" v="365 days" />
            <SpecRow k="Timeout grace" v="48 hours" />
            <SpecRow k="Arbitration" v="Single arbiter" last />
          </div>
        </div>
      </div>

      {/* ── Contract not deployed on this chain ──────────── */}
      {!contract && (
        <AlertBox
          variant="warning"
          code="E02"
          title={`Bond is not deployed on ${chainLabel(chainId)}`}
          description="Switch your wallet to Base or Base Sepolia to create an escrow link."
        />
      )}

      <div className="row gap-6" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* ── Form card ──────────────────────────────────── */}
        <div
          className="card card--tick"
          style={{ flex: "1 1 500px", minWidth: 0, display: "flex", flexDirection: "column", gap: 22 }}
        >
          <div className="section-head" style={{ marginBottom: 0 }}>
            <span className="index">§ 1.0</span>
            <h2 style={{ fontSize: "var(--text-lg)" }}>New escrow</h2>
            <span className="section-head__rule" />
            <span className="badge badge--brand">Fee {FEE_BPS / 100}%</span>
          </div>

          {formAttempted && hasErrors && errors.form && (
            <AlertBox
              variant="warning"
              code={FORM_INVALID.code}
              title={FORM_INVALID.title}
              description={errors.form}
            />
          )}

          {!isConnected && touched.payee && (
            <AlertBox
              variant="warning"
              code={WALLET_REQUIRED.code}
              title={WALLET_REQUIRED.title}
              description={errors.form ?? WALLET_REQUIRED.description}
            />
          )}

          <div className="field">
            <label className="field__label" htmlFor="payee">
              Payee address
            </label>
            <input
              id="payee"
              className={`field__input ${show("payee") ? "field__input--invalid" : ""}`}
              placeholder="0x… recipient who receives the funds"
              value={values.payee}
              onChange={set("payee")}
              onBlur={() => setTouched((p) => ({ ...p, payee: true }))}
              spellCheck={false}
              autoComplete="off"
            />
            {show("payee") && <span className="field__error">{errors.payee}</span>}
          </div>

          {/* ── Structure: one payment vs milestone slices ──── */}
          <div className="stack gap-2">
            <span className="field__label">Structure</span>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {(
                [
                  { key: "single" as Structure, label: "Single payment", hint: "One release on confirmation" },
                  { key: "milestones" as Structure, label: "Milestones", hint: "Release slice by slice" },
                ]
              ).map((o) => {
                const on = structure === o.key;
                return (
                  <button
                    key={o.key}
                    type="button"
                    className={`mono ${on ? "preset preset--on" : "preset"}`}
                    aria-pressed={on}
                    onClick={() => setStructure(o.key)}
                    style={{ fontSize: 11, letterSpacing: "0.06em", padding: "8px 12px" }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <span className="field__hint">
              {structure === "single"
                ? "The payer confirms once and the full amount releases."
                : `Up to ${MAX_MILESTONES} slices — the payer releases each milestone as it lands, or all at once.`}
            </span>
          </div>

          <div className="row gap-4" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
            {structure === "single" ? (
            <div className="field" style={{ flex: "1 1 180px" }}>
              <label className="field__label" htmlFor="amount">
                Amount (USDC)
              </label>
              <input
                id="amount"
                inputMode="decimal"
                className={`field__input tnum ${show("amount") ? "field__input--invalid" : ""}`}
                placeholder="500.00"
                value={values.amount}
                onChange={set("amount")}
                onBlur={() => setTouched((p) => ({ ...p, amount: true }))}
                autoComplete="off"
              />
              {show("amount") ? (
                <span className="field__error">{errors.amount}</span>
              ) : balance !== undefined ? (
                <span className="field__hint tnum">
                  Balance: {formatUsdc(balance as bigint)} USDC
                </span>
              ) : null}
            </div>
            ) : (
            <div className="field" style={{ flex: "1 1 180px" }}>
              <label className="field__label" htmlFor="total">
                Escrow amount (auto)
              </label>
              <div
                id="total"
                className="field__input tnum"
                style={{ background: "var(--bg-ink)", color: "var(--text-2)", cursor: "default" }}
                aria-readonly="true"
              >
                {formatUsdc(required)} USDC
              </div>
              <span className="field__hint">Sum of the milestone amounts below.</span>
            </div>
            )}
            <div className="field" style={{ flex: "1 1 150px" }}>
              <label className="field__label" htmlFor="days">
                Deadline (days)
              </label>
              <input
                id="days"
                inputMode="numeric"
                className={`field__input tnum ${show("deadlineDays") ? "field__input--invalid" : ""}`}
                value={values.deadlineDays}
                onChange={set("deadlineDays")}
                onBlur={() => setTouched((p) => ({ ...p, deadlineDays: true }))}
                autoComplete="off"
              />
              {show("deadlineDays") ? (
                <span className="field__error">{errors.deadlineDays}</span>
              ) : (
                <span className="field__hint">10 minutes – 365 days</span>
              )}
            </div>
          </div>

          {/* ── Presets: one click fills a field, typing still wins ── */}
          <div className="stack gap-2">
            {structure === "single" && (
              <PresetRow
                label="Common amounts"
                options={AMOUNT_PRESETS.map((a) => ({ value: a, label: `${a} USDC` }))}
                active={values.amount}
                onPick={(v) => {
                  setValues((p) => ({ ...p, amount: v }));
                  setTouched((p) => ({ ...p, amount: true }));
                }}
              />
            )}
            <PresetRow
              label="Standard deadlines"
              options={DAY_PRESETS.map((d) => ({ value: String(d), label: `${d} days` }))}
              active={values.deadlineDays}
              onPick={(v) => {
                setValues((p) => ({ ...p, deadlineDays: v }));
                setTouched((p) => ({ ...p, deadlineDays: true }));
              }}
            />
          </div>

          {/* ── Milestone rows: the slice table, validated on submit ── */}
          {structure === "milestones" && (
            <div className="stack gap-3" style={{ borderTop: "1px solid var(--border)", paddingTop: 18 }}>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="eyebrow">Milestones</span>
                <span className="mono tnum" style={{ fontSize: 11, color: "var(--text-3)" }}>
                  {rows.length}/{MAX_MILESTONES} · {formatUsdc(required)} USDC
                </span>
              </div>

              {rows.map((r, i) => (
                <div
                  key={i}
                  className="stack gap-2"
                  style={{ border: "1px solid var(--border)", padding: 12, background: "var(--bg-card)" }}
                >
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                    <span
                      className="mono"
                      style={{ fontSize: 11, letterSpacing: "0.1em", color: "var(--brand)", fontWeight: 700 }}
                    >
                      Slice {String(i + 1).padStart(2, "0")}
                    </span>
                    <button
                      type="button"
                      className="mono"
                      style={{
                        fontSize: 10,
                        letterSpacing: "0.1em",
                        textTransform: "uppercase",
                        color: rows.length > 1 ? "var(--status-red)" : "var(--text-3)",
                        background: "none",
                        border: "none",
                        cursor: rows.length > 1 ? "pointer" : "not-allowed",
                        padding: 0,
                      }}
                      disabled={rows.length <= 1}
                      onClick={() => {
                        setRowsTouched(true);
                        setRows((p) => p.filter((_, j) => j !== i));
                      }}
                    >
                      Remove
                    </button>
                  </div>

                  <div className="row gap-3" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div className="field" style={{ flex: "2 1 170px" }}>
                      <label className="field__label" htmlFor={`ms-title-${i}`}>
                        Title
                      </label>
                      <input
                        id={`ms-title-${i}`}
                        className="field__input"
                        placeholder="e.g. Wireframes"
                        maxLength={96}
                        value={r.title}
                        onChange={(ev) =>
                          setRows((p) => p.map((row, j) => (j === i ? { ...row, title: ev.target.value } : row)))
                        }
                        autoComplete="off"
                      />
                    </div>
                    <div className="field" style={{ flex: "1 1 110px" }}>
                      <label className="field__label" htmlFor={`ms-amount-${i}`}>
                        Amount
                      </label>
                      <input
                        id={`ms-amount-${i}`}
                        inputMode="decimal"
                        className={`field__input tnum ${rowError(i) ? "field__input--invalid" : ""}`}
                        placeholder="100.00"
                        value={r.amount}
                        onChange={(ev) => {
                          setRowsTouched(true);
                          setRows((p) => p.map((row, j) => (j === i ? { ...row, amount: ev.target.value } : row)));
                        }}
                        autoComplete="off"
                      />
                    </div>
                    <div className="field" style={{ flex: "1 1 90px" }}>
                      <label className="field__label" htmlFor={`ms-due-${i}`}>
                        Due (days)
                      </label>
                      <input
                        id={`ms-due-${i}`}
                        inputMode="numeric"
                        className="field__input tnum"
                        placeholder="optional"
                        value={r.dueDays}
                        onChange={(ev) =>
                          setRows((p) => p.map((row, j) => (j === i ? { ...row, dueDays: ev.target.value } : row)))
                        }
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  {rowError(i) && <span className="field__error">{rowError(i)}</span>}
                </div>
              ))}

              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <button
                  type="button"
                  className="mono preset"
                  disabled={rows.length >= MAX_MILESTONES}
                  style={{
                    fontSize: 11,
                    letterSpacing: "0.06em",
                    padding: "8px 12px",
                    cursor: rows.length >= MAX_MILESTONES ? "not-allowed" : "pointer",
                    opacity: rows.length >= MAX_MILESTONES ? 0.5 : 1,
                  }}
                  onClick={() => {
                    setRowsTouched(true);
                    setRows((p) => (p.length >= MAX_MILESTONES ? p : [...p, { ...EMPTY_ROW }]));
                  }}
                >
                  Add milestone
                </button>
                <span className="field__hint">Due dates are targets — the escrow deadline still governs the timeout.</span>
              </div>
            </div>
          )}
          {/* E04: shortfall shown with the exact missing amount */}
          {shortfall > 0n && (
            <AlertBox
              variant="error"
              title="Insufficient USDC balance"
              description={
                <>
                  You are <strong className="tnum">{formatUsdc(shortfall)} USDC</strong> short. Top up your
                  wallet or lower the amount.
                </>
              }
            />
          )}

          <div className="field">
            <label className="field__label" htmlFor="desc">
              Description <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              id="desc"
              className={`field__input ${show("description") ? "field__input--invalid" : ""}`}
              placeholder="What is this payment for? e.g. Logo design for acme.co"
              value={values.description}
              onChange={set("description")}
              onBlur={() => setTouched((p) => ({ ...p, description: true }))}
            />
            <div className="row" style={{ justifyContent: "space-between" }}>
              {show("description") ? (
                <span className="field__error">{errors.description}</span>
              ) : (
                <span />
              )}
              <span className={`field__hint tnum ${values.description.length > 256 ? "field__error" : ""}`}>
                {values.description.length}/256
              </span>
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="arbiter">
              Arbiter address
            </label>
            <input
              id="arbiter"
              className={`field__input ${show("arbiter") ? "field__input--invalid" : ""}`}
              placeholder="0x… neutral third party who resolves disputes"
              value={values.arbiter}
              onChange={set("arbiter")}
              onBlur={() => setTouched((p) => ({ ...p, arbiter: true }))}
              spellCheck={false}
              autoComplete="off"
            />
            {show("arbiter") ? (
              <span className="field__error">{errors.arbiter}</span>
            ) : (
              <span className="field__hint">Must differ from the payee. Can be an EOA or a multisig.</span>
            )}
          </div>

          <TxButton
            label="Create escrow link"
            busyLabel="Creating…"
            state={tx}
            onClick={submit}
            block
            disabled={!contract || hasErrors}
          />
        </div>

        {/* ── Side column: status + protocol notes ────────── */}
        <div className="stack gap-4" style={{ flex: "1 1 330px", minWidth: 0 }}>
          <TxStatusCard
            state={tx}
            chainId={chainId}
            onReset={() => setTx(IDLE_TX)}
            successTitle="Escrow created"
            successDescription="Your escrow link is ready to share."
          />

          <div className="card card--tick" id="how">
            <div className="section-head">
              <span className="index">§ 2.0</span>
              <h3>Lifecycle</h3>
              <span className="section-head__rule" />
            </div>

            <ol className="stack" style={{ margin: 0, padding: 0, listStyle: "none", gap: 0 }}>
              {[
                { n: "01", t: "Create", d: "Set the amount, payee, deadline and arbiter." },
                { n: "02", t: "Fund", d: "The payer approves USDC and locks it in the contract." },
                { n: "03", t: "Deliver", d: "The payee completes the work." },
                { n: "04", t: "Release", d: "Payer confirms — funds minus the 0.5% fee go to the payee." },
              ].map((s, i, arr) => (
                <li
                  key={s.n}
                  className="row"
                  style={{
                    gap: 16,
                    alignItems: "flex-start",
                    padding: "14px 0",
                    borderTop: i === 0 ? "1px solid var(--border)" : "none",
                    borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none",
                  }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "var(--brand)", letterSpacing: "0.08em", paddingTop: 2 }}
                  >
                    {s.n}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ fontWeight: 640, fontSize: "var(--text-sm)" }}>{s.t}</span>
                    <span className="small muted" style={{ display: "block", lineHeight: 1.55, marginTop: 2 }}>
                      {s.d}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            <div
              className="small muted"
              style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)", lineHeight: 1.6 }}
            >
              Disputes go to the arbiter, who gets a published 7-day window to rule. If a funded escrow sits
              past the deadline plus a 48 hour grace, its timeout opens — anyone can execute it and the money
              only ever returns to the payer.
            </div>
          </div>

          <div className="card card--ink">
            <span className="eyebrow" style={{ color: "var(--plate-muted-dim)" }}>
              Custody model
            </span>
            <p style={{ marginTop: 12, fontSize: "var(--text-sm)", lineHeight: 1.7, color: "var(--plate-copy)" }}>
              Funds sit in the open-source{" "}
              <span className="mono" style={{ color: "var(--on-plate)" }}>EscrowLink</span>{" "}
              contract. No admin, no bank, no intermediary can move escrowed principal — only the protocol fee
              is collected, and only on completion.
            </p>
            <div className="row gap-2" style={{ marginTop: 18, flexWrap: "wrap" }}>
              <span
                className="mono"
                style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--plate-muted-chip)", border: "1px solid var(--plate-rule-3)", padding: "6px 10px" }}
              >
                Non-custodial
              </span>
              <span
                className="mono"
                style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--plate-muted-chip)", border: "1px solid var(--plate-rule-3)", padding: "6px 10px" }}
              >
                Immutable fee cap
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One line of quick-fill chips. Purely a convenience — every value can
 * still be typed by hand, and the chip only writes to its own field.
 */
function PresetRow({
  label,
  options,
  active,
  onPick,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  active: string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span
        className="mono"
        style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)" }}
      >
        {label}
      </span>
      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {options.map((o) => {
          const isActive = active === o.value;
          return (
            <button
              key={o.value}
              type="button"
              className={`mono tnum ${isActive ? "preset preset--on" : "preset"}`}
              aria-pressed={isActive}
              onClick={() => onPick(o.value)}
              style={{ fontSize: 11, letterSpacing: "0.06em" }}
            >
              {o.label}
            </button>
          );
        })}
      </span>
    </div>
  );
}

/** One row of the architectural spec table. */
function SpecRow({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <div
      className="row"
      style={{
        justifyContent: "space-between",
        gap: 16,
        padding: "10px 14px",
        borderBottom: last ? "none" : "1px solid var(--border)",
      }}
    >
      <span className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-3)" }}>
        {k}
      </span>
      <span className="mono tnum" style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-1)" }}>
        {v}
      </span>
    </div>
  );
}

