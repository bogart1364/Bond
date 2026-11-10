import { useMemo, useState } from "react";
import { useReadContract, useWalletClient } from "wagmi";
import { TxButton } from "../../components/ui/TxButton";
import { AlertBox } from "../../components/ui/AlertBox";
import { useToast } from "../../components/ui/toast-context";
import { IconCopy } from "../../components/ui/Icons";
import { ESCROW_ABI } from "../../lib/contracts";
import { asChainId } from "../../lib/chains";
import { formatUsdc } from "../../lib/format";
import type { TxState } from "../../lib/tx";
import type { MilestoneSlice } from "./MilestonesCard";

/**
 * Gasless release — the payer signs the EIP-712 typed data off-chain, and
 * ANY connected account may file it on-chain, paying the gas. The payee is
 * the usual filer: they are the one waiting on the money, and the payer
 * may be asleep, on another device, or out of gas.
 *
 * The typed data mirrors the contract byte for byte (same domain name and
 * version, same struct fields, the escrow's current per-slot nonce), so the
 * digest the wallet signs IS `releaseAllDigest(id)` / `releaseDigest(id, i)`
 * on chain. One signature files once — the nonce moves on use.
 */

/** type(uint256).max — the contract's dedicated ReleaseAll nonce slot. */
const RELEASE_ALL_SLOT = 2n ** 256n - 1n;

const DOMAIN_NAME = "Bond EscrowLink";
const DOMAIN_VERSION = "1";

const RELEASE_ALL_TYPES = {
  ReleaseAll: [
    { name: "id", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const RELEASE_TYPES = {
  Release: [
    { name: "id", type: "uint256" },
    { name: "index", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** EOA signatures are 65 bytes; anything shorter cannot verify. */
const SIG_SHAPE = /^0x[0-9a-fA-F]{130,}$/;

type Target = "all" | number;

export function GaslessReleaseCard({
  id,
  chainId,
  contract,
  role,
  tx,
  act,
}: {
  id: bigint;
  chainId: number;
  contract?: `0x${string}`;
  role: "payer" | "payee" | "arbiter" | "observer";
  tx: TxState;
  act: (fn: string, args: unknown[], opts?: { label?: string; success?: string }) => Promise<void>;
}) {
  const toast = useToast();
  const { data: walletClient } = useWalletClient();

  const [target, setTarget] = useState<Target>("all");
  const [sig, setSig] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [signing, setSigning] = useState(false);

  // Milestone escrows may sign for ONE slice; plain escrows only ReleaseAll.
  const slicesQuery = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "getMilestones",
    args: [id],
    chainId: asChainId(chainId),
    query: { enabled: !!contract, retry: 2 },
  });
  const sliceData = slicesQuery.data as MilestoneSlice[] | undefined;
  const openSlices = useMemo(
    () => (sliceData ?? []).map((s, i) => ({ s, i })).filter(({ s }) => !s.settled),
    [sliceData],
  );

  // The nonce is part of the digest: read it fresh right before signing,
  // so a signature can never be built against a spent value.
  const slot = target === "all" ? RELEASE_ALL_SLOT : BigInt(target);
  const nonceQuery = useReadContract({
    address: contract,
    abi: ESCROW_ABI,
    functionName: "releaseNonces",
    args: [id, slot],
    chainId: asChainId(chainId),
    query: { enabled: !!contract, retry: 2 },
  });
  const nonce = nonceQuery.data as bigint | undefined;

  const pasteValid = SIG_SHAPE.test(paste.trim());

  async function sign() {
    if (!walletClient || !contract || nonce === undefined) return;
    setSigning(true);
    try {
      const domain = {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId: asChainId(chainId),
        verifyingContract: contract,
      } as const;
      const signed =
        target === "all"
          ? await walletClient.signTypedData({
              domain,
              types: RELEASE_ALL_TYPES,
              primaryType: "ReleaseAll",
              message: { id, nonce },
            })
          : await walletClient.signTypedData({
              domain,
              types: RELEASE_TYPES,
              primaryType: "Release",
              message: { id, index: BigInt(target), nonce },
            });
      setSig(signed);
      toast.success("Release signed", "No transaction was sent — copy the bytes or file them yourself.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/user rejected|denied|rejected the request/i.test(msg)) {
        toast.neutral("Signature declined", "Nothing was signed.");
      } else {
        toast.error("Signing failed", msg);
      }
    } finally {
      setSigning(false);
    }
  }

  async function file(signature: string) {
    const s = signature.trim();
    if (target === "all") {
      await act("confirmWithSig", [id, s], { success: "Release filed — funds are moving" });
    } else {
      await act("confirmMilestoneWithSig", [id, BigInt(target), s], {
        success: `Milestone ${target + 1} released`,
      });
    }
    setSig(null);
    setPaste("");
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h3>Gasless release</h3>
        <span className="eyebrow">EIP-712</span>
      </div>
      <p className="small muted" style={{ marginBottom: 16 }}>
        The payer signs a typed message off-chain — no gas, no transaction — and anybody can file it on-chain.
        The payee is the usual filer. The signature covers this escrow, this chain and the current nonce, so it
        works exactly once.
      </p>

      {/* ── What should the signature release? ─────────────── */}
      {openSlices.length > 0 && (
        <div className="stack gap-2" style={{ marginBottom: 16 }}>
          <span className="field__label">Release target</span>
          <label className="row gap-3" style={{ alignItems: "center", cursor: "pointer" }}>
            <input
              type="radio"
              name="release-target"
              checked={target === "all"}
              onChange={() => {
                setTarget("all");
                setSig(null);
              }}
              style={{ accentColor: "var(--brand)" }}
            />
            <span className="small" style={{ fontWeight: 570 }}>
              Everything remaining ({openSlices.length} open {openSlices.length === 1 ? "slice" : "slices"})
            </span>
          </label>
          {openSlices.map(({ s, i }) => (
            <label key={i} className="row gap-3" style={{ alignItems: "center", cursor: "pointer" }}>
              <input
                type="radio"
                name="release-target"
                checked={target === i}
                onChange={() => {
                  setTarget(i);
                  setSig(null);
                }}
                style={{ accentColor: "var(--brand)" }}
              />
              <span className="small" style={{ fontWeight: 570 }}>
                Slice {String(i + 1).padStart(2, "0")}
                {s.title ? ` — ${s.title}` : ""} ({formatUsdc(s.amount)} USDC)
              </span>
            </label>
          ))}
        </div>
      )}

      {/* ── Payer: sign ────────────────────────────────────── */}
      {role === "payer" && (
        <div className="stack gap-3" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
          <AlertBox
            variant="info"
            title="You are the payer — sign once"
            description="Signing sends nothing and costs nothing. The resulting bytes can be filed by the payee (or anyone) who then pays the gas."
          />
          <div className="row gap-3" style={{ flexWrap: "wrap", alignItems: "center" }}>
            <TxButton
              label={sig ? "Sign again (refresh nonce)" : "Sign release"}
              busyLabel="Waiting for signature…"
              state={signing ? { ...tx, phase: "signing" } : tx}
              onClick={() => void sign()}
            />
            {nonce !== undefined && (
              <span className="small muted tnum" title="Nonce bound into the typed data">
                nonce {nonce.toString()}
              </span>
            )}
          </div>

          {sig && (
            <div className="stack gap-2">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <span className="field__label" style={{ margin: 0 }}>
                  Signature bytes
                </span>
                <button
                  type="button"
                  className="mono row"
                  style={{
                    gap: 6,
                    alignItems: "center",
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    background: "none",
                    border: "1px solid var(--border)",
                    color: "var(--text-2)",
                    padding: "6px 10px",
                    cursor: "pointer",
                  }}
                  onClick={() => {
                    void navigator.clipboard.writeText(sig).then(
                      () => toast.success("Copied", "Send these bytes to whoever is filing."),
                      () => toast.warning("Copy blocked", "Select the text and copy it manually."),
                    );
                  }}
                >
                  <IconCopy size={12} strokeWidth={3} />
                  Copy
                </button>
              </div>
              <textarea
                className="field__input mono"
                readOnly
                value={sig}
                rows={3}
                style={{ fontSize: 11, wordBreak: "break-all", resize: "vertical" }}
              />
              <div>
                <TxButton
                  label="File it myself"
                  busyLabel="Filing…"
                  state={tx}
                  onClick={() => void file(sig)}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Anyone: file a received signature ──────────────── */}
      <div
        className="stack gap-3"
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: 16,
          marginTop: role === "payer" ? 16 : 0,
        }}
      >
        {role !== "payer" && (
          <AlertBox
            variant="info"
            title="Have the payer's signature?"
            description="Ask the payer to sign a release from their device, then paste the bytes here. You submit the transaction and pay the gas — the signature itself is not secret and cannot be altered."
          />
        )}
        <div className="field">
          <label className="field__label" htmlFor="release-sig">
            Payer signature (0x…)
          </label>
          <textarea
            id="release-sig"
            className="field__input mono"
            placeholder="0x… signed ReleaseAll or Release bytes from the payer"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={3}
            spellCheck={false}
            style={{ fontSize: 11, wordBreak: "break-all", resize: "vertical" }}
          />
          <span className="field__hint">
            {paste.trim().length === 0
              ? "Paste the full 0x-prefixed signature."
              : pasteValid
                ? "Shape looks right — submitting simulates it first."
                : "Too short: an EOA signature is 65 bytes (130 hex characters after 0x)."}
          </span>
        </div>
        <div>
          <TxButton
            label="File release on-chain"
            busyLabel="Filing…"
            state={tx}
            disabled={!pasteValid}
            onClick={() => void file(paste)}
          />
        </div>
      </div>
    </div>
  );
}
