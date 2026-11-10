import { useState } from "react";
import { keccak256, toHex } from "viem";
import { TxButton } from "../../components/ui/TxButton";
import { AlertBox } from "../../components/ui/AlertBox";
import { useToast } from "../../components/ui/toast-context";
import type { TxState } from "../../lib/tx";

/**
 * Evidence anchoring — hash a file HERE, in the browser, and put only the
 * digest on chain. The artifact itself never leaves the device: the event
 * carries `keccak256(file)` plus a short note. Anyone holding the same file
 * can hash it later and match the log — proof it existed at that moment,
 * with zero server storage.
 *
 * Open to the payer, payee or arbiter, in ANY state: the record outlives
 * the deal (the contract enforces the party rule, not this UI).
 */

const MAX_NOTE_BYTES = 256;

export function EvidenceAnchorCard({
  id,
  role,
  watchOnly,
  tx,
  act,
}: {
  id: bigint;
  role: "payer" | "payee" | "arbiter" | "observer";
  watchOnly: boolean;
  tx: TxState;
  act: (fn: string, args: unknown[], opts?: { label?: string; success?: string }) => Promise<void>;
}) {
  const toast = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [hashing, setHashing] = useState(false);

  const isParty = role === "payer" || role === "payee" || role === "arbiter";
  const noteBytes = new TextEncoder().encode(note).length;

  async function onPick(f: File | null) {
    setFile(f);
    setHash(null);
    if (!f) return;
    if (f.size === 0) {
      toast.warning("Empty file", "There is nothing to hash — pick a file with content.");
      setFile(null);
      return;
    }
    setHashing(true);
    try {
      const buf = await f.arrayBuffer();
      setHash(keccak256(toHex(new Uint8Array(buf))));
    } catch (e) {
      setFile(null);
      toast.error("Could not read that file", e instanceof Error ? e.message : String(e));
    } finally {
      setHashing(false);
    }
  }

  async function anchor() {
    if (!hash) return;
    await act("submitEvidence", [id, hash, note], {
      success: "Evidence anchored on-chain",
    });
    // The act() helper already refreshed the timeline; clear the local
    // draft so a second anchor starts from a clean file pick.
    setFile(null);
    setHash(null);
    setNote("");
  }

  if (!isParty) {
    return (
      <div className="card card--flat">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <h3>Evidence</h3>
          <span className="eyebrow">anchored by hash</span>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          The payer, payee and arbiter can anchor evidence to this escrow — file hashes and notes that stay on
          chain forever, in any state. Anchored evidence shows up in the timeline below.
        </p>
      </div>
    );
  }

  return (
    <div className="card card--flat">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h3>Anchor evidence</h3>
        <span className="eyebrow">hash only, file stays yours</span>
      </div>
      <p className="small muted" style={{ marginBottom: 16 }}>
        The browser hashes the file with keccak256 and the contract records only the digest and a note — the
        artifact itself never touches the chain or any server. Later, hashing the same file reproduces the same
        digest and matches the log: proof it existed at this moment.
      </p>

      {watchOnly ? (
        <AlertBox
          variant="info"
          title="Watch-only mode"
          description="Exit watch-only mode to anchor evidence from this device."
          action={{ label: "Exit watch-only", onClick: () => window.location.assign(`?escrow=${id.toString()}`) }}
        />
      ) : (
        <div className="stack gap-4">
          <div className="field">
            <label className="field__label" htmlFor="evidence-file">
              File
            </label>
            <input
              id="evidence-file"
              type="file"
              className="field__input"
              onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
              style={{ padding: "9px 12px" }}
            />
            <span className="field__hint">
              {file ? `${file.name} · ${Math.ceil(file.size / 1024)} KB` : "Delivery receipt, message log, screenshot — anything provable by hash."}
            </span>
          </div>

          {hash && (
            <div className="stack gap-2">
              <span className="field__label" style={{ margin: 0 }}>
                keccak256 digest
              </span>
              <span
                className="mono"
                style={{ fontSize: 11, wordBreak: "break-all", color: "var(--text-2)", lineHeight: 1.6 }}
                title={hash}
              >
                {hash}
              </span>
            </div>
          )}

          <div className="field">
            <label className="field__label" htmlFor="evidence-note">
              Note <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              id="evidence-note"
              className={`field__input ${noteBytes > MAX_NOTE_BYTES ? "field__input--invalid" : ""}`}
              placeholder="e.g. Final delivery receipt from acme.co"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX_NOTE_BYTES}
            />
            <span className={`field__hint tnum ${noteBytes > MAX_NOTE_BYTES ? "field__error" : ""}`}>
              {noteBytes}/{MAX_NOTE_BYTES} bytes
            </span>
          </div>

          <div>
            <TxButton
              label={hashing ? "Hashing…" : "Anchor evidence on-chain"}
              busyLabel="Anchoring…"
              state={tx}
              disabled={!hash || hashing || noteBytes > MAX_NOTE_BYTES}
              onClick={() => void anchor()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
