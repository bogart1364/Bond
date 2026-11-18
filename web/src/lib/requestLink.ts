import { isAddress, parseUnits, zeroAddress } from "viem";
import { USDC_DECIMALS } from "./contracts";

/**
 * Payment-request link — an escrow's terms carried in the URL.
 *
 * Bond has no backend to file an invoice against, so a payment request is
 * not a record stored anywhere: it IS the link. The payee types the terms
 * once, and the resulting URL (or its QR) opens the create form with every
 * field already filled in. The payer still reviews and signs — nothing in
 * the link is trusted, and the create form re-validates all of it before a
 * single byte reaches the chain.
 *
 * Only the four terms the form knows are carried, and only readable ones:
 * a mangled or hand-edited parameter is dropped here rather than pasted
 * into a field as garbage, and `dropped` lets the caller say so out loud.
 */

/** Raw strings exactly as typed into the request builder. */
export interface RequestDraft {
  payee: string;
  amount: string;
  days: string;
  description: string;
  arbiter: string;
}

/** The subset of `FormValues` a request can pre-fill, plus what it refused. */
export interface RequestPrefill {
  payee?: string;
  amount?: string;
  deadlineDays?: string;
  description?: string;
  arbiter?: string;
  /** Parameter names present in the link but unreadable — quote them back. */
  dropped: string[];
}

/** Query parameter names a payment request understands. */
export const REQUEST_PARAMS = ["payee", "amount", "days", "desc", "arbiter"] as const;

/** True when the string parses as a positive USDC amount (6 decimals). */
function isPositiveAmount(raw: string): boolean {
  const v = raw.trim();
  if (!v) return false;
  try {
    return parseUnits(v, USDC_DECIMALS) > 0n;
  } catch {
    return false;
  }
}

/** Mirrors `validate()`'s duration rule: 10 minutes to 365 days. */
function isDuration(raw: string): boolean {
  const d = Number(raw.trim());
  return Number.isFinite(d) && d > 0 && d * 24 * 60 >= 10 && d <= 365;
}

/**
 * Build the shareable request link for a draft.
 *
 * Fields are included verbatim when present and left out when empty, so an
 * incomplete draft still produces a link that opens the create form with
 * whatever was answered. The builder itself only offers the link once
 * every required term validates — this function does not gate on that.
 */
export function buildRequestLink(origin: string, draft: RequestDraft): string {
  const p = new URLSearchParams();
  p.set("view", "create");
  if (draft.payee.trim()) p.set("payee", draft.payee.trim());
  if (draft.amount.trim()) p.set("amount", draft.amount.trim());
  if (draft.days.trim()) p.set("days", draft.days.trim());
  if (draft.description.trim()) p.set("desc", draft.description.trim());
  if (draft.arbiter.trim()) p.set("arbiter", draft.arbiter.trim());
  return `${origin.replace(/\/+$/, "")}/?${p.toString()}`;
}

/**
 * Read a request link back into create-form values.
 *
 * Returns `null` when the URL carries no request parameter at all — the
 * plain "create an escrow" visit must not look like a loaded request.
 * Every field is checked independently: one bad parameter never poisons
 * the rest of the link.
 */
export function parseRequestPrefill(search: string): RequestPrefill | null {
  const p = new URLSearchParams(search);
  const out: RequestPrefill = { dropped: [] };
  let seen = 0;

  const payee = p.get("payee");
  if (payee !== null) {
    seen++;
    if (isAddress(payee) && payee.trim().toLowerCase() !== zeroAddress) out.payee = payee.trim();
    else out.dropped.push("payee");
  }

  const amount = p.get("amount");
  if (amount !== null) {
    seen++;
    if (isPositiveAmount(amount)) out.amount = amount.trim();
    else out.dropped.push("amount");
  }

  const days = p.get("days");
  if (days !== null) {
    seen++;
    if (isDuration(days)) out.deadlineDays = days.trim();
    else out.dropped.push("duration");
  }

  const desc = p.get("desc");
  if (desc !== null) {
    seen++;
    if (desc.length <= 256) out.description = desc;
    else out.dropped.push("description");
  }

  const arbiter = p.get("arbiter");
  if (arbiter !== null) {
    seen++;
    if (isAddress(arbiter) && arbiter.trim().toLowerCase() !== zeroAddress) out.arbiter = arbiter.trim();
    else out.dropped.push("arbiter");
  }

  return seen === 0 ? null : out;
}
