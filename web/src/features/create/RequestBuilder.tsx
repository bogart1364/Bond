import { useMemo, useState, type ChangeEvent } from "react";
import qrcode from "qrcode-generator";
import { isAddress, parseUnits, zeroAddress } from "viem";
import { AlertBox } from "../../components/ui/AlertBox";
import { IconCopy, IconExternal, IconShare } from "../../components/ui/Icons";
import { useToast } from "../../components/ui/toast-context";
import { FEE_BPS, USDC_DECIMALS } from "../../lib/contracts";
import { FORM_INVALID } from "../../lib/errors";
import { shortAddress } from "../../lib/format";
import { buildRequestLink, type RequestDraft } from "../../lib/requestLink";
import { PresetRow, SpecRow } from "./CreateBits";

/**
 * Payment request — the invoice that is just a URL.
 *
 * A payee fills in what they are owed, and Bond issues a link plus its QR
 * code. Opening either lands on the create form with every field already
 * typed in, so the payer only has to review and sign; there is no account,
 * no stored invoice and nothing to chase. The request is issued only when
 * all of it validates, because a half-written link would only walk the
 * payer into a form full of red.
 */

const EMPTY: RequestDraft = { payee: "", amount: "", days: "7", description: "", arbiter: "" };

/** Preset amounts in USDC — sized for typical freelance settlements. */
const AMOUNT_PRESETS = ["50", "100", "500", "2500"] as const;

/** Preset durations in days, matching the lifecycle copy elsewhere. */
const DAY_PRESETS = [3, 7, 14, 30] as const;

const MAX_DESCRIPTION = 256;

type Errors = Partial<Record<keyof RequestDraft, string>>;

/** Layer 1 — the exact rules `CreateEscrowView` re-checks before signing. */
function validate(d: RequestDraft): Errors {
  const e: Errors = {};

  if (!d.payee.trim()) e.payee = "Enter the payee address.";
  else if (!isAddress(d.payee.trim())) e.payee = "That is not a valid 0x address.";
  else if (d.payee.trim().toLowerCase() === zeroAddress) e.payee = "The zero address cannot receive funds.";

  if (!d.amount.trim()) e.amount = "Enter an amount.";
  else {
    try {
      if (parseUnits(d.amount.trim(), USDC_DECIMALS) <= 0n) e.amount = "Amount must be greater than zero.";
    } catch {
      e.amount = "Enter a valid number, up to 6 decimals.";
    }
  }

  const days = Number(d.days);
  if (!Number.isFinite(days) || days <= 0) e.days = "Enter a number of days.";
  else if (days * 24 * 60 < 10) e.days = "Minimum duration is 10 minutes.";
  else if (days > 365) e.days = "Maximum duration is 365 days.";

  if (d.description.length > MAX_DESCRIPTION) {
    e.description = `Keep the description under ${MAX_DESCRIPTION} characters.`;
  }

  if (!d.arbiter.trim()) e.arbiter = "Enter an arbiter address for disputes.";
  else if (!isAddress(d.arbiter.trim())) e.arbiter = "That is not a valid 0x address.";
  else if (!e.payee && d.arbiter.trim().toLowerCase() === d.payee.trim().toLowerCase()) {
    e.arbiter = "The arbiter must be a different address than the payee.";
  }

  return e;
}

export function RequestBuilder() {
  const toast = useToast();

  const [draft, setDraft] = useState<RequestDraft>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof RequestDraft, boolean>>>({});
  const [copied, setCopied] = useState(false);

  const errors = useMemo(() => validate(draft), [draft]);
  const valid = Object.keys(errors).length === 0;
  const anyTouched = Object.values(touched).some(Boolean);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const set = (k: keyof RequestDraft) => (ev: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setDraft((p) => ({ ...p, [k]: ev.target.value }));
    setTouched((p) => ({ ...p, [k]: true }));
  };
  const blur = (k: keyof RequestDraft) => () => setTouched((p) => ({ ...p, [k]: true }));
  const show = (k: keyof RequestDraft) => touched[k] && errors[k];

  const link = useMemo(() => buildRequestLink(window.location.origin, draft), [draft]);

  // ── QR: the request, rendered as engraving ──────────────────
  // Only built once every term is valid — the placeholder below must not
  // hand out a QR code that decodes into an unusable form.
  const qr = useMemo(() => {
    if (!valid) return null;
    const code = qrcode(0, "M");
    code.addData(link);
    code.make();
    const count = code.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (code.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { d, count };
  }, [link, valid]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard API needs a secure context; fall back to the old way
      // rather than failing on plain http.
      try {
        const ta = document.createElement("textarea");
        ta.value = link;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        toast.warning("Copy failed", "Select the link and copy it manually.");
        return;
      }
    }
    setCopied(true);
    toast.success("Request link copied", "Send it to the payer — they open the form already filled in.");
    window.setTimeout(() => setCopied(false), 2500);
  }

  function share() {
    if (canShare) void navigator.share({ title: "Bond payment request", url: link }).catch(() => undefined);
    else void copyLink();
  }

  const actionIcon = { size: 13, strokeWidth: 4 } as const;

  return (
    <div className="stack gap-8">
      {/* ── Hero: front page ─────────────────────────────── */}
      <div style={{ borderBottom: "4px double var(--border-ink)", paddingBottom: 36 }}>
        <div
          className="row"
          style={{ justifyContent: "space-between", gap: 24, flexWrap: "wrap", paddingBottom: 10 }}
        >
          <span className="eyebrow" style={{ color: "var(--brand)" }}>
            02 — Payment request
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
              Name your terms.
              <br />
              <em style={{ fontStyle: "italic", color: "var(--brand)" }}>The payer signs them.</em>
            </h1>
            <div style={{ height: 3, background: "var(--border-ink)", margin: "22px 0 18px", maxWidth: 620 }} />
            <p
              className="dropcap"
              style={{ fontSize: "var(--text-md)", lineHeight: 1.7, maxWidth: 640, color: "var(--text-2)" }}
            >
              Say what you are owed and by when. Bond turns it into a link and a QR code that opens the create
              form already filled in — no account, no invoice kept on a server, and nothing signed until the
              payer has read it.
            </p>
            <p className="small muted" style={{ marginTop: 16, maxWidth: 640, lineHeight: 1.7 }}>
              Already the payer? <a href="?view=create">Open the blank create form</a> instead.
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
            <SpecRow k="Carried by" v="Link + QR" />
            <SpecRow k="Kept server-side" v="Nothing" />
            <SpecRow k="Who signs" v="The payer" last />
          </div>
        </div>
      </div>

      {/* ── Incomplete terms: E01, never a broken link ───── */}
      {anyTouched && !valid && (
        <AlertBox
          variant="warning"
          code={FORM_INVALID.code}
          title={FORM_INVALID.title}
          description="A request is issued only once every term is valid. Fix the marked fields below — nothing has been sent anywhere."
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
            <h2 style={{ fontSize: "var(--text-lg)" }}>Request terms</h2>
            <span className="section-head__rule" />
            <span className="badge badge--brand">Fee {FEE_BPS / 100}%</span>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="req-payee">
              Payee address
            </label>
            <input
              id="req-payee"
              className={`field__input ${show("payee") ? "field__input--invalid" : ""}`}
              placeholder="0x… who receives the funds"
              value={draft.payee}
              onChange={set("payee")}
              onBlur={blur("payee")}
              spellCheck={false}
              autoComplete="off"
            />
            {show("payee") ? (
              <span className="field__error">{errors.payee}</span>
            ) : (
              <span className="field__hint">Usually your own address — the payee never signs anything.</span>
            )}
          </div>

          <div className="row gap-4" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
            <div className="field" style={{ flex: "1 1 180px" }}>
              <label className="field__label" htmlFor="req-amount">
                Amount (USDC)
              </label>
              <input
                id="req-amount"
                inputMode="decimal"
                className={`field__input tnum ${show("amount") ? "field__input--invalid" : ""}`}
                placeholder="500.00"
                value={draft.amount}
                onChange={set("amount")}
                onBlur={blur("amount")}
                autoComplete="off"
              />
              {show("amount") ? (
                <span className="field__error">{errors.amount}</span>
              ) : (
                <span className="field__hint">Held by the contract until the payer confirms.</span>
              )}
            </div>
            <div className="field" style={{ flex: "1 1 150px" }}>
              <label className="field__label" htmlFor="req-days">
                Deadline (days)
              </label>
              <input
                id="req-days"
                inputMode="numeric"
                className={`field__input tnum ${show("days") ? "field__input--invalid" : ""}`}
                value={draft.days}
                onChange={set("days")}
                onBlur={blur("days")}
                autoComplete="off"
              />
              {show("days") ? (
                <span className="field__error">{errors.days}</span>
              ) : (
                <span className="field__hint">10 minutes – 365 days</span>
              )}
            </div>
          </div>

          {/* ── Presets: one click fills a field, typing still wins ── */}
          <div className="stack gap-2">
            <PresetRow
              label="Common amounts"
              options={AMOUNT_PRESETS.map((a) => ({ value: a, label: `${a} USDC` }))}
              active={draft.amount}
              onPick={(v) => {
                setDraft((p) => ({ ...p, amount: v }));
                setTouched((p) => ({ ...p, amount: true }));
              }}
            />
            <PresetRow
              label="Standard deadlines"
              options={DAY_PRESETS.map((d) => ({ value: String(d), label: `${d} days` }))}
              active={draft.days}
              onPick={(v) => {
                setDraft((p) => ({ ...p, days: v }));
                setTouched((p) => ({ ...p, days: true }));
              }}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="req-desc">
              Description <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              id="req-desc"
              className={`field__input ${show("description") ? "field__input--invalid" : ""}`}
              placeholder="What is this payment for? e.g. Logo design for acme.co"
              value={draft.description}
              onChange={set("description")}
              onBlur={blur("description")}
            />
            <div className="row" style={{ justifyContent: "space-between" }}>
              {show("description") ? (
                <span className="field__error">{errors.description}</span>
              ) : (
                <span />
              )}
              <span className={`field__hint tnum ${draft.description.length > MAX_DESCRIPTION ? "field__error" : ""}`}>
                {draft.description.length}/{MAX_DESCRIPTION}
              </span>
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="req-arbiter">
              Arbiter address
            </label>
            <input
              id="req-arbiter"
              className={`field__input ${show("arbiter") ? "field__input--invalid" : ""}`}
              placeholder="0x… neutral third party who resolves disputes"
              value={draft.arbiter}
              onChange={set("arbiter")}
              onBlur={blur("arbiter")}
              spellCheck={false}
              autoComplete="off"
            />
            {show("arbiter") ? (
              <span className="field__error">{errors.arbiter}</span>
            ) : (
              <span className="field__hint">Must differ from the payee. Can be an EOA or a multisig.</span>
            )}
          </div>
        </div>

        {/* ── Side column: the issued request ────────────── */}
        <div
          className="card card--tick"
          style={{ flex: "1 1 360px", minWidth: 0, display: "flex", flexDirection: "column", gap: 20 }}
        >
          <div className="section-head" style={{ marginBottom: 0 }}>
            <span className="index">§ 2.0</span>
            <h2 style={{ fontSize: "var(--text-lg)" }}>Issued request</h2>
            <span className="section-head__rule" />
            <span className={`badge ${valid ? "badge--success" : "badge--neutral"}`}>
              {valid ? "Ready" : "Draft"}
            </span>
          </div>

          {!valid || !qr ? (
            <div
              style={{
                border: "1px dashed var(--border-strong)",
                background: "var(--bg-inset)",
                padding: "30px 24px",
                textAlign: "center",
              }}
            >
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                Not issued yet
              </div>
              <p className="small muted" style={{ lineHeight: 1.7, margin: 0 }}>
                The payee, amount, duration and arbiter all have to be valid before a request exists. A
                half-written one would only walk the payer into a form full of red.
              </p>
            </div>
          ) : (
            <div className="stack gap-4">
              <div className="row" style={{ gap: 26, alignItems: "flex-start", flexWrap: "wrap" }}>
                {/* ── QR plate ──────────────────────────────── */}
                <div style={{ flex: "0 0 auto", textAlign: "center" }}>
                  <div
                    style={{
                      width: 168,
                      height: 168,
                      padding: 11,
                      background: "#f7f2ec",
                      border: "1px solid var(--border-strong)",
                    }}
                  >
                    <svg
                      viewBox={`-4 -4 ${qr.count + 8} ${qr.count + 8}`}
                      style={{ width: "100%", height: "100%", display: "block" }}
                      role="img"
                      aria-label="QR code for this payment request"
                    >
                      <path d={qr.d} fill="#16130f" shapeRendering="crispEdges" />
                    </svg>
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      color: "var(--text-3)",
                      marginTop: 7,
                    }}
                  >
                    Scan to open
                  </div>
                </div>

                {/* ── Actions ─────────────────────────────── */}
                <div className="stack gap-3" style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <code
                    className="mono truncate"
                    style={{
                      display: "block",
                      fontSize: 12.5,
                      color: "var(--text-1)",
                      background: "var(--bg-inset)",
                      border: "1px dashed var(--border-strong)",
                      padding: "10px 12px",
                      wordBreak: "break-all",
                    }}
                  >
                    {link}
                  </code>

                  <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm row gap-2"
                      onClick={() => void copyLink()}
                    >
                      {copied ? "Copied" : "Copy link"}
                      <IconCopy {...actionIcon} />
                    </button>

                    {canShare && (
                      <button type="button" className="btn btn--secondary btn--sm row gap-2" onClick={share}>
                        Share
                        <IconShare {...actionIcon} />
                      </button>
                    )}

                    <button
                      type="button"
                      className="btn btn--secondary btn--sm row gap-2"
                      onClick={() => (window.location.href = link)}
                      title="Read the request exactly as the payer would open it"
                    >
                      Open it
                      <IconExternal {...actionIcon} />
                    </button>
                  </div>

                  <span className="small muted" style={{ lineHeight: 1.6 }}>
                    The payer opens this link, finds the terms already typed in, and signs the create transaction
                    themselves. Nothing here is kept anywhere — the link is the whole request.
                  </span>
                </div>
              </div>

              <div
                className="row small mono muted"
                style={{ gap: 14, paddingTop: 12, borderTop: "1px solid var(--border)", flexWrap: "wrap" }}
              >
                <span>payee {shortAddress(draft.payee)}</span>
                <span>{draft.amount} USDC</span>
                <span>{draft.days} days</span>
                <span>arbiter {shortAddress(draft.arbiter)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
