/**
 * Bond error matrix — E01 … E12.
 *
 * Layer 1  form validation        (caught in the form, before any wallet call)
 * Layer 2  pre-flight simulation  (viem simulateContract — most reverts land here)
 * Layer 3  signing & broadcast    (wallet / network)
 * Layer 4  read path              (RPC, stale data, indexing)
 *
 * Contract custom errors are decoded with viem and mapped to the same shape
 * so every failure in the app renders through <AlertBox />.
 */

export type ErrorLayer = 1 | 2 | 3 | 4;

export type AlertKind = "error" | "warning" | "success" | "info";

export interface UserError {
  /** Matrix id, e.g. "E06". */
  code: string;
  layer: ErrorLayer;
  kind: AlertKind;
  title: string;
  description: string;
  /** Optional concrete next step shown as the primary action label. */
  actionLabel?: string;
  /** Technical payload for the collapsible "What happened?" section. */
  details?: string;
  /** True when retrying makes sense (RPC hiccups, dropped txs). */
  retryable?: boolean;
}

/**
 * Contract revert copy, keyed by **error name**.
 *
 * viem decodes revert data against `abi.json` and yields `errorName` + `args`,
 * so the name is the stable key. (The previous table was keyed by selectors
 * that had drifted from the deployed ABI — every entry was wrong — which
 * silently downgraded all real reverts to the generic branch.)
 *
 * Covers every `error` in the deployed ABI: all of EscrowLink.sol's custom
 * errors (v1/v2/v3) plus the OZ ones reachable through its dependencies.
 */
const CONTRACT_ERRORS: Record<string, (args: readonly unknown[]) => Partial<UserError>> = {
  // ── EscrowLink.sol ──────────────────────────────────────
  // EscrowNotFound(uint256 id)
  EscrowNotFound: (a) => ({
    title: "This escrow does not exist",
    description: `Escrow #${String(a[0])} was not found on this contract. The link may be wrong or from another network.`,
    actionLabel: "Create a new link",
  }),
  // InvalidState(uint8 expected, uint8 actual)
  InvalidState: (a) => {
    const expected = stateName(a[0]);
    const actual = stateName(a[1]);
    return {
      title: `This link is ${actual} — expected ${expected}`,
      description: STATE_COPY[actual] ?? `Current state: ${actual}.`,
      actionLabel: "Reload escrow",
    };
  },
  NotPayer: () => ({ title: "Only the payer can do that", description: "This action is restricted to the address that created the escrow." }),
  NotPayee: () => ({ title: "Only the payee can do that", description: "This action is restricted to the recipient of the funds." }),
  NotArbiter: () => ({ title: "Only the arbiter can do that", description: "The arbiter address on this escrow must resolve the dispute." }),
  NotParty: () => ({ title: "You are not part of this escrow", description: "Only the payer or the payee can open a dispute." }),
  ZeroAddress: () => ({ title: "Address cannot be zero", description: "One of the addresses entered is the zero address." }),
  ZeroAmount: () => ({ title: "Amount must be greater than zero", description: "Enter an amount to escrow." }),
  SelfReference: () => ({ title: "Parties must be different addresses", description: "The payer, payee and arbiter must all be distinct." }),
  DeadlineTooSoon: () => ({ title: "Deadline is too soon", description: "Give the payee at least 10 minutes to deliver." }),
  DeadlineTooFar: () => ({ title: "Deadline is too far", description: "The maximum escrow duration is 365 days." }),
  DescriptionTooLong: () => ({ title: "Description is too long", description: "Keep the description under 256 bytes." }),
  FeeExceedsMaximum: () => ({ title: "Fee exceeds the maximum", description: "The protocol fee cap is 10%." }),
  InvalidBps: () => ({ title: "Invalid basis points", description: "The split must be between 0 and 10000." }),
  NothingToWithdraw: () => ({
    title: "Nothing to withdraw",
    description: "There is no balance waiting for you — no accrued fees, and no share that had to be credited instead of paid out.",
  }),
  TimeoutNotReached: () => ({
    title: "Timeout window not reached",
    description: "The timeout opens only after the deadline plus a 48 hour grace period, so the payee still has time to deliver or dispute.",
  }),
  // ArbiterWindowOpen(uint256 availableAt)
  ArbiterWindowOpen: (a) => ({
    title: "The arbiter's window is still open",
    description: `A dispute is under review until ${formatUnix(Number(a[0]))}. After that, if no ruling was made, anyone may execute the timeout instead.`,
    actionLabel: "Reload escrow",
  }),
  InvalidHandshakeSignature: () => ({
    title: "A consent signature did not match",
    description:
      "The payee's or arbiter's signature does not cover these exact terms on this network. Ask both to re-sign the current terms — nothing was created and no funds moved.",
  }),
  // UnexpectedTransfer(uint256 received, uint256 expected)
  UnexpectedTransfer: (a) => ({
    title: "Received amount does not match",
    description: `The token delivered ${String(a[0])} instead of ${String(a[1])}. This token is not supported for escrow.`,
  }),
  RenounceDisabled: () => ({ title: "Ownership cannot be renounced", description: "Use the two-step transfer to hand ownership to a multisig." }),

  // ── v3: milestones ──────────────────────────────────────
  MilestonesMismatch: () => ({
    title: "Milestone fields do not line up",
    description: "Amounts, due dates and titles must be entered for every milestone — one of the three lists is shorter.",
  }),
  NoMilestones: () => ({ title: "Add at least one milestone", description: "A milestone escrow needs between 1 and 12 slices." }),
  // TooManyMilestones(uint256 count)
  TooManyMilestones: (a) => ({
    title: "Too many milestones",
    description: `You entered ${String(a[0])} milestones; the maximum per escrow is 12. Merge some steps and try again.`,
  }),
  // MilestoneAmountZero(uint256 index)
  MilestoneAmountZero: (a) => ({
    title: "A milestone amount is zero",
    description: `Milestone ${Number(a[0]) + 1} has no amount. Every slice must be greater than zero.`,
  }),
  // MilestoneNotFound(uint256 id, uint256 index)
  MilestoneNotFound: (a) => ({
    title: "That milestone does not exist",
    description: `Escrow #${String(a[0])} has no milestone ${Number(a[1]) + 1}. The link or the index may be stale.`,
    actionLabel: "Reload escrow",
  }),
  // MilestoneAlreadySettled(uint256 id, uint256 index)
  MilestoneAlreadySettled: (a) => ({
    title: "Milestone already released",
    description: `Milestone ${Number(a[1]) + 1} of escrow #${String(a[0])} was already paid out — nothing to release again.`,
    actionLabel: "Reload escrow",
  }),
  // MilestoneDueAfterDeadline(uint256 index)
  MilestoneDueAfterDeadline: (a) => ({
    title: "A milestone is due after the deadline",
    description: `Milestone ${Number(a[0]) + 1} targets a date past the escrow deadline. Move it earlier or extend the deadline.`,
  }),
  // MilestoneTitleTooLong(uint256 index)
  MilestoneTitleTooLong: (a) => ({
    title: "A milestone title is too long",
    description: `Milestone ${Number(a[0]) + 1} has a title over 96 bytes. Shorten it so the record stays readable.`,
  }),

  // ── v3: evidence ────────────────────────────────────────
  NotEscrowParty: () => ({
    title: "Only a party may file evidence",
    description: "Evidence can be anchored by the payer, the payee or the arbiter of this escrow.",
  }),
  EmptyEvidenceHash: () => ({
    title: "Evidence hash is empty",
    description: "Hash the file first (keccak256) and submit the digest — a zero hash would anchor nothing.",
  }),

  // ── v3: gasless release ─────────────────────────────────
  InvalidReleaseSignature: () => ({
    title: "The release signature did not match",
    description:
      "The payer's signature does not cover this exact release on this network — it may be for another milestone, already used, or signed by a different address. Ask the payer to re-sign; no funds moved.",
  }),

  // ── OpenZeppelin (reachable through the contract) ───────
  EnforcedPause: () => ({ ...CONTRACT_PAUSED, details: "EnforcedPause()" }),
  ExpectedPause: () => ({ title: "The contract is not paused", description: "This guard only fires while the contract is paused." }),
  OwnableUnauthorizedAccount: () => ({ title: "Only the contract operator can do that", description: "This administrative action is restricted to the platform owner." }),
  OwnableInvalidOwner: () => ({ title: "Invalid owner address", description: "The proposed owner address is not usable." }),
  ReentrancyGuardReentrantCall: () => ({ title: "Re-entrant call blocked", description: "The contract stopped a nested call into itself. Nothing was changed — try again." }),
  SafeERC20FailedOperation: () => ({
    title: "The USDC transfer was rejected",
    description: "The token refused the transfer, so the escrow state is unchanged. Check the amount and your balance, then retry.",
  }),
};

/**
 * Selector -> error name, for reverts viem could not decode against the ABI.
 *
 * Every value verified with `cast keccak "<signature>"` against the deployed
 * ABI (`cast sig "NotArbiter()"` -> 0xccb665a6, and so on).
 */
const SELECTOR_INDEX: Record<string, string> = {
  "0x0b668f2e": "EscrowNotFound",
  "0x77e5c5f2": "InvalidState",
  "0x1435e357": "NotPayer",
  "0x56cab67b": "NotPayee",
  "0xccb665a6": "NotArbiter",
  "0xc8ee2d1d": "NotParty",
  "0xd92e233d": "ZeroAddress",
  "0x1f2a2005": "ZeroAmount",
  "0xd656f448": "SelfReference",
  "0x96a18df4": "DeadlineTooSoon",
  "0x48f0fae6": "DeadlineTooFar",
  "0xd7cfc590": "DescriptionTooLong",
  "0xaf9c21dc": "FeeExceedsMaximum",
  "0xc6cc5d7f": "InvalidBps",
  "0xd0d04f60": "NothingToWithdraw",
  "0x9b0056ac": "TimeoutNotReached",
  "0xa6761ddf": "ArbiterWindowOpen",
  "0x0fd4680a": "InvalidHandshakeSignature",
  "0x05b9bb8f": "UnexpectedTransfer",
  "0x89051165": "RenounceDisabled",
  "0xbd9910b4": "MilestonesMismatch",
  "0x5c4a81cc": "NoMilestones",
  "0x7e5bd33d": "TooManyMilestones",
  "0xabed7544": "MilestoneAmountZero",
  "0x0fcd92b0": "MilestoneNotFound",
  "0x01530ab6": "MilestoneAlreadySettled",
  "0x9bbcb5c7": "MilestoneDueAfterDeadline",
  "0x584ea0a5": "MilestoneTitleTooLong",
  "0xd5abedff": "NotEscrowParty",
  "0x5d15a983": "EmptyEvidenceHash",
  "0xcda44837": "InvalidReleaseSignature",
  "0xd93c0665": "EnforcedPause",
  "0x8dfc202b": "ExpectedPause",
  "0x118cdaa7": "OwnableUnauthorizedAccount",
  "0x1e4fbdf7": "OwnableInvalidOwner",
  "0x3ee5aeb5": "ReentrancyGuardReentrantCall",
  "0x5274afe7": "SafeERC20FailedOperation",
};

/** Solidity `Panic(uint256)` reasons — see the Solidity docs, Appendix A. */
const PANIC_COPY: Record<string, string> = {
  "0x01": "An assert failed inside the contract.",
  "0x11": "An arithmetic operation overflowed or underflowed.",
  "0x12": "A division or modulo by zero happened.",
  "0x32": "An array was accessed outside its bounds.",
  "0x41": "The contract ran out of memory or allocated too much.",
  "0x51": "A call was made into a contract that is not payable.",
};

/** Human copy per escrow state — used by the InvalidState error. */
const STATE_COPY: Record<string, string> = {
  None: "This escrow does not exist.",
  Created: "The payer has not funded this link yet. Fund it to lock the amount.",
  Funded: "Funds are locked. The payer can confirm delivery, or either party can open a dispute.",
  Disputed: "The arbiter is reviewing this escrow. Settlement is paused until they resolve it.",
  Completed: "This escrow has already been settled.",
  Cancelled: "This escrow was cancelled before funding.",
  Refunded: "The funds have already been returned to the payer.",
};

const STATE_NAMES = ["None", "Created", "Funded", "Disputed", "Completed", "Cancelled", "Refunded"] as const;

function stateName(v: unknown): string {
  const i = Number(v);
  return STATE_NAMES[i] ?? `Unknown(${String(v)})`;
}

/** Unix seconds -> a locale string, for error copy about a future deadline. */
function formatUnix(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "an unknown time";
  return new Date(unixSeconds * 1000).toLocaleString();
}

/* ── Layer 1: form validation ───────────────────────────── */

/**
 * E01 — the form itself is invalid. Layer 1 runs entirely in the browser:
 * no RPC, no wallet popup, nothing sent. Previously this code existed in
 * the docs but was never emitted, so the classified bar showed "BOND".
 */
export const FORM_INVALID: UserError = {
  code: "E01",
  layer: 1,
  kind: "warning",
  title: "Check the highlighted fields",
  description:
    "The form has one or more problems. Fix the marked fields and submit again — nothing was sent to the network.",
  retryable: true,
};

/**
 * E07 — a write needs a wallet that is not connected. Distinct from E02
 * (connected, wrong network): here there is no account to switch from.
 */
export const WALLET_REQUIRED: UserError = {
  code: "E07",
  layer: 3,
  kind: "warning",
  title: "Wallet not connected",
  description:
    "Connect a wallet in the header to continue. Bond never asks for an account, an email or a password.",
  actionLabel: "Connect wallet",
};

/* ── Layer 3: wallet / network ──────────────────────────── */

const CODE_MAP: Record<number, () => UserError> = {
  4001: () => ({
    code: "E03",
    layer: 3,
    kind: "warning",
    title: "Signature request declined",
    description: "You rejected the request in your wallet — nothing was sent and nothing changed.",
    retryable: true,
  }),
  4902: () => ({
    code: "E02",
    layer: 3,
    kind: "warning",
    title: "Base is not added to your wallet",
    description: "Add the Base network to continue.",
    actionLabel: "Switch to Base",
  }),
  "-32000": () => ({
    code: "E10",
    layer: 3,
    kind: "warning",
    title: "Transaction was dropped or replaced",
    description: "The network did not include this transaction. It is safe to send it again.",
    actionLabel: "Send again",
    retryable: true,
  }),
  "-32603": () => ({
    code: "E06",
    layer: 3,
    kind: "error",
    title: "The node rejected the transaction",
    description: "The simulation passed but the RPC refused the send. Try again or switch RPC.",
    retryable: true,
  }),
};

/* ── Layer 4: read path ─────────────────────────────────── */

export const RPC_ERROR: UserError = {
  code: "E08",
  layer: 4,
  kind: "warning",
  title: "Could not reach the network",
  description: "We could not read on-chain data. Check your connection and try again.",
  actionLabel: "Try again",
  retryable: true,
};

export const PAUSED_BANNER: UserError = {
  code: "E11",
  layer: 4,
  kind: "error",
  title: "Bond is temporarily paused",
  description: "New escrows cannot be created or funded right now. All funds already locked remain safe and can still be settled.",
};

export const CONTRACT_PAUSED: UserError = {
  code: "E11",
  layer: 2,
  kind: "error",
  title: "Bond is temporarily paused",
  description: "Creation and funding of new escrows are paused by the operator. Existing escrows keep settling normally.",
  actionLabel: "Check escrow status",
};

/* ── Main decoder ───────────────────────────────────────── */

interface ViemLikeError {
  name?: string;
  message?: string;
  shortMessage?: string;
  data?: unknown;
  cause?: { data?: unknown; message?: string };
  walk?: () => Iterable<unknown>;
  code?: number | string;
}

/**
 * True for revert payloads: `0x`-hex at revert length, never an address
 * (`0x` + 40) or a tx hash (`0x` + 64). viem's call summary quotes the
 * contract address, and slicing its first 4 bytes produced a fake selector
 * (it showed up in details as `0x2fAFbED9` — the contract, not the error).
 */
function isRevertHex(s: string): boolean {
  return /^0x[0-9a-fA-F]{8,}$/.test(s) && s.length !== 42 && s.length !== 66;
}

function extractSelector(err: unknown): string | null {
  const e = err as ViemLikeError;
  const candidates = [e?.data, e?.cause?.data];

  // viem puts the raw revert data under `data` in several shapes
  for (const c of candidates) {
    if (typeof c === "string" && isRevertHex(c)) return c.slice(0, 10);
    if (c && typeof c === "object" && "data" in (c as Record<string, unknown>)) {
      const d = (c as Record<string, unknown>).data;
      if (typeof d === "string" && isRevertHex(d)) return d.slice(0, 10);
    }
  }

  // Last resort: raw hex quoted in the message (same address/hash filter —
  // matchAll scans every candidate instead of stopping at the first, which
  // is always the address viem prints in the call summary).
  const msg = `${e?.message ?? ""}${e?.shortMessage ?? ""}`;
  for (const m of msg.matchAll(/0x[0-9a-fA-F]+/g)) {
    if (isRevertHex(m[0])) return m[0].slice(0, 10);
  }
  return null;
}

/** Reverse of SELECTOR_INDEX — error name -> its `cast keccak`-verified selector. */
function selectorForName(name: string): string | undefined {
  for (const [sel, errName] of Object.entries(SELECTOR_INDEX)) {
    if (errName === name) return sel;
  }
  return undefined;
}

function decodeArgs(err: unknown): readonly unknown[] {
  const e = err as ViemLikeError;
  const data =
    (typeof e?.data === "object" && e.data && "data" in e.data ? (e.data as Record<string, unknown>).data : e?.data) ??
    e?.cause?.data;
  if (typeof data === "string" && data.length >= 10) {
    const hex = data.slice(10);
    const out: unknown[] = [];
    for (let i = 0; i + 64 <= hex.length; i += 64) {
      out.push(BigInt(`0x${hex.slice(i, i + 64)}`));
    }
    return out;
  }
  return [];
}

/**
 * Pull viem's decoded revert payload out of the error chain.
 *
 * `simulateContract` wraps failures in ContractFunctionExecutionError; the
 * decoded `{ errorName, args }` sits on the ContractFunctionRevertedError
 * one or two levels down, and `walk()` covers the remaining shapes.
 */
interface DecodedRevert {
  /** viem's decoded error name: "NotArbiter", "Error", "Panic", … */
  name?: string;
  /** Decoded arguments — bigint for uint256, number for uint8. */
  args?: readonly unknown[];
}

function decodeRevert(err: unknown): DecodedRevert {
  const e = err as ViemLikeError;
  const payloads: unknown[] = [];

  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const d = (node as { data?: unknown }).data;
    if (d && typeof d === "object") payloads.push(d);
  };

  collect(e);
  collect(e?.cause);
  collect((e?.cause as { cause?: unknown } | undefined)?.cause);
  if (typeof e?.walk === "function") {
    try {
      for (const node of e.walk()) collect(node);
    } catch {
      /* walk() is best-effort — decoding below simply falls back */
    }
  }

  for (const p of payloads) {
    const d = p as { errorName?: unknown; args?: unknown };
    if (typeof d.errorName === "string" && d.errorName.length > 0) {
      return { name: d.errorName, args: Array.isArray(d.args) ? d.args : [] };
    }
  }
  return {};
}

/**
 * Turn any thrown value into a matrix entry. Always returns something
 * renderable — the UI never shows a raw error object.
 */
export function toUserError(err: unknown): UserError {
  if (!err) {
    return {
      code: "E06",
      layer: 2,
      kind: "error",
      title: "Something went wrong",
      description: "An unknown error occurred. Please try again.",
      retryable: true,
    };
  }

  const e = err as ViemLikeError;
  const name = e?.name ?? "";

  // ── Layer 2: contract revert ────────────────────────────
  if (name === "ContractFunctionRevertedError" || name === "ContractFunctionExecutionError" || name === "CallExecutionError") {
    const decoded = decodeRevert(err);
    const raw = e.shortMessage ?? e.message ?? "";

    // Pausable guard (E11 keeps its own matrix entry and code).
    if (decoded.name === "EnforcedPause" || (!decoded.name && e.message?.includes("EnforcedPause"))) {
      return { ...CONTRACT_PAUSED, details: "EnforcedPause()" };
    }

    // require(false, "reason") — a plain string revert.
    if (decoded.name === "Error") {
      const reason = String(decoded.args?.[0] ?? "").trim();
      return {
        code: "E06",
        layer: 2,
        kind: "error",
        title: "The contract rejected this action",
        description: reason || "The simulated transaction would fail.",
        details: raw,
      };
    }

    // Solidity panic (overflow, bounds check, …).
    if (decoded.name === "Panic") {
      const panicCode = `0x${Number(decoded.args?.[0] ?? 0).toString(16).padStart(2, "0")}`;
      return {
        code: "E06",
        layer: 2,
        kind: "error",
        title: "The contract hit an internal check",
        description: PANIC_COPY[panicCode] ?? `Solidity panic ${panicCode}.`,
        details: `${panicCode} · ${raw}`.trim(),
      };
    }

    // Known custom error — decoded name first, verified selector as backup.
    const selector = extractSelector(err);
    const errorName =
      (decoded.name && CONTRACT_ERRORS[decoded.name] ? decoded.name : undefined) ??
      (selector && SELECTOR_INDEX[selector] && CONTRACT_ERRORS[SELECTOR_INDEX[selector]]
        ? SELECTOR_INDEX[selector]
        : undefined);

    if (errorName) {
      const base = CONTRACT_ERRORS[errorName](decoded.args?.length ? decoded.args : decodeArgs(err));
      return {
        code: "E06",
        layer: 2,
        kind: "error",
        title: base.title ?? "The contract rejected this action",
        description: base.description ?? "The simulated transaction would fail.",
        actionLabel: base.actionLabel,
        // Prefer the verified reverse lookup: when the name decoded, its
        // selector is known for certain; `extractSelector` is only a backup.
        details: [errorName, selectorForName(errorName) ?? selector, raw].filter(Boolean).join(" · "),
        retryable: base.retryable,
      };
    }

    // A selector we do not know: still a contract decision, just unmapped.
    if (selector) {
      return {
        code: "E06",
        layer: 2,
        kind: "error",
        title: "The contract rejected this action",
        description: "The simulation failed before your signature was requested, so no funds moved.",
        details: `${selector} · ${raw}`.trim(),
      };
    }

    // No revert payload at all: the node answered with an error of its own
    // (rate limit, internal error, dropped connection) instead of letting
    // the contract speak. That is not a contract decision — frame it as the
    // transient network problem it is and let the user retry.
    return {
      code: "E06",
      layer: 2,
      kind: "error",
      title: "The network could not verify this action",
      description:
        "The RPC replied with an error instead of a contract response. Nothing was signed and no funds moved — try again in a moment.",
      actionLabel: "Try again",
      details: raw,
      retryable: true,
    };
  }

  // ── Layer 3: wallet & network ───────────────────────────
  const code = typeof e?.code === "number" ? e.code : Number(e?.code);
  if (CODE_MAP[code]) return CODE_MAP[code]();

  const errName = name.toLowerCase();
  if (errName.includes("userreject") || errName.includes("userdenied")) return CODE_MAP[4001]();

  // Insufficient funds for gas (layer 3)
  if (errName.includes("insufficientfunds") || e.message?.includes("insufficient funds")) {
    return {
      code: "E04",
      layer: 3,
      kind: "error",
      title: "Not enough balance for gas",
      description: "Your wallet needs a small amount of ETH on Base to pay network fees.",
      actionLabel: "Get ETH on Base",
    };
  }

  // ── Layer 4: RPC / fetch ────────────────────────────────
  if (
    errName.includes("fetch" ) ||
    errName.includes("timeout") ||
    errName.includes("httprequestfailed") ||
    errName.includes("rpc") ||
    e.message?.includes("Failed to fetch")
  ) {
    return RPC_ERROR;
  }

  // ── Fallback ────────────────────────────────────────────
  return {
    code: "E06",
    layer: 2,
    kind: "error",
    title: "Something went wrong",
    description: "The action could not be completed. Nothing was signed — it is safe to try again.",
    details: e.shortMessage ?? e.message ?? String(err),
    retryable: true,
  };
}

/**
 * True when the failure carries **no contract verdict**: no decoded error
 * name, no selector, no reason string. Only an RPC can produce that shape —
 * a contract always speaks in selectors, `Error(string)` or `Panic`.
 *
 * `runTx` uses this to allow exactly one automatic re-simulation: a genuine
 * revert must surface to the user, a node hiccup must not kill the action.
 */
export function isNodeSideFailure(err: unknown): boolean {
  const e = err as ViemLikeError;
  const name = e?.name ?? "";

  if (name !== "ContractFunctionRevertedError" && name !== "ContractFunctionExecutionError" && name !== "CallExecutionError") {
    const n = name.toLowerCase();
    return (
      n.includes("http") ||
      n.includes("timeout") ||
      n.includes("fetch") ||
      n.includes("socket") ||
      Number(e?.code) === -32603
    );
  }

  if (decodeRevert(err).name) return false;
  return extractSelector(err) === null;
}
