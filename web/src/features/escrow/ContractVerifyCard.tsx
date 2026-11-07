import { useEffect, useState } from "react";
import { Badge, Skeleton } from "../../components/ui/Feedback";
import { IconExternal } from "../../components/ui/Icons";
import { ESCROW_ABI } from "../../lib/contracts";

/**
 * ContractVerifyCard — "how do I check this myself?"
 *
 * Pulls verification status straight from Sourcify (no API key, public
 * endpoint) and links out to the verified source. A user who does not trust
 * this UI can read the exact Solidity that runs on-chain — that is the whole
 * point of deploying a verifiable contract.
 */

const SOURCIFY_API = "https://sourcify.dev/server";
const CHAIN_EXPLORER: Record<number, string> = {
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
};

type VerifyState =
  | { status: "loading" }
  | { status: "exact"; files: string[] }
  | { status: "partial"; files: string[] }
  | { status: "unverified" }
  | { status: "unreachable"; message: string };

/**
 * The interface check: does the ABI this page signs with still equal the one
 * Sourcify verified? Key order and top-level ordering carry no meaning in an
 * ABI, so both sides are canonicalised before comparison — only functions,
 * events, errors and their parameter lists decide the result.
 */
type AbiCheck =
  | { status: "loading" }
  | { status: "match"; count: number }
  | { status: "drift"; localCount: number; remoteCount: number }
  | { status: "unavailable" };

function canonicalAbi(abi: readonly unknown[]): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
      return out;
    }
    return v;
  };
  const entries = (abi as unknown[]).map(sortKeys).map((e) => JSON.stringify(e));
  entries.sort();
  return `[${entries.join(",")}]`;
}

/** Request identity — a new chain, contract or retry derives a fresh "loading". */
function verifyKey(chainId: number, contract: string | undefined, attempt: number) {
  return `${chainId}:${contract ?? "none"}:${attempt}`;
}

export function ContractVerifyCard({ chainId, contract }: { chainId: number; contract?: `0x${string}` }) {
  const [result, setResult] = useState<{ key: string; state: VerifyState } | null>(null);
  // Bumped by the Retry button — Sourcify occasionally rate-limits or
  // goes down, and the user should be able to re-check without a reload.
  const [attempt, setAttempt] = useState(0);

  // Loading is not stored: it is what "no answer for this request yet" means,
  // so it derives during render instead of being assigned inside the effect.
  const key = verifyKey(chainId, contract, attempt);
  const state: VerifyState = result?.key === key ? result.state : { status: "loading" };

  useEffect(() => {
    if (!contract) return;
    const ac = new AbortController();
    const requestKey = verifyKey(chainId, contract, attempt);

    // `fields=sources` adds the file list (for the "16 files" detail) while
    // still returning `match` — the default payload omits `sources` entirely,
    // so the count would always read zero.
    fetch(`${SOURCIFY_API}/v2/contract/${chainId}/${contract}?fields=sources`)
      .then((r) => (r.status === 404 ? { notFound: true } : r.status >= 500 ? Promise.reject(new Error(`checker HTTP ${r.status}`)) : r.json()))
      .then((body: unknown) => {
        if (ac.signal.aborted) return;
        if (body && typeof body === "object" && "notFound" in body) {
          setResult({ key: requestKey, state: { status: "unverified" } });
          return;
        }
        const b = body as {
          match?: string;
          sources?: Record<string, unknown>;
        };
        const files = b.sources ? Object.keys(b.sources) : [];
        if (b.match === "exact_match") setResult({ key: requestKey, state: { status: "exact", files } });
        else if (b.match === "partial_match") setResult({ key: requestKey, state: { status: "partial", files } });
        else setResult({ key: requestKey, state: { status: "unverified" } });
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setResult({
          key: requestKey,
          state: {
            status: "unreachable",
            message: e instanceof Error ? e.message : "network error",
          },
        });
      });

    return () => ac.abort();
  }, [chainId, contract, attempt]);

  // ── Second opinion: the interface, not just the bytecode ──
  // Runs only once Sourcify says `exact_match` — comparing an ABI against an
  // unverified deployment would prove nothing. A drift here means the ABI
  // this page ships has diverged from the verified contract, which is
  // exactly the silent failure this check exists to catch.
  const [abiCheck, setAbiCheck] = useState<{ key: string; state: AbiCheck } | null>(null);
  const abiKey = `${key}:${state.status === "exact" ? "ready" : "skip"}`;

  useEffect(() => {
    if (!contract || state.status !== "exact") return;
    const ac = new AbortController();
    const requestKey = abiKey;

    fetch(`${SOURCIFY_API}/v2/contract/${chainId}/${contract}?fields=abi`)
      .then((r) => (r.status === 404 || r.status >= 500 ? Promise.reject(new Error(`ABI HTTP ${r.status}`)) : r.json()))
      .then((body: unknown) => {
        if (ac.signal.aborted) return;
        const remote = (body as { abi?: unknown[] }).abi;
        if (!Array.isArray(remote)) {
          setAbiCheck({ key: requestKey, state: { status: "unavailable" } });
          return;
        }
        const localCount = ESCROW_ABI.length;
        const same = canonicalAbi(remote) === canonicalAbi(ESCROW_ABI);
        setAbiCheck({
          key: requestKey,
          state: same
            ? { status: "match", count: localCount }
            : { status: "drift", localCount, remoteCount: remote.length },
        });
      })
      .catch(() => {
        // The interface check is a bonus, not the verification itself — a
        // refused query degrades to "could not compare", never to an error.
        if (!ac.signal.aborted) setAbiCheck({ key: requestKey, state: { status: "unavailable" } });
      });

    return () => ac.abort();
  }, [contract, chainId, state.status, abiKey]);

  // Derived in render: a stale answer for another chain/retry shows loading
  // rather than the previous chain's verdict.
  const abiState: AbiCheck = abiCheck?.key === abiKey ? abiCheck.state : { status: "loading" };

  const sourcifyUrl = contract
    ? `https://repo.sourcify.dev/contracts/full_match/${chainId}/${contract}/`
    : undefined;
  // Only build the explorer link when this chain is in the map — otherwise
  // the base would be "" and the href would become a broken relative URL.
  const explorerUrl =
    contract && CHAIN_EXPLORER[chainId] ? `${CHAIN_EXPLORER[chainId]}/address/${contract}` : undefined;
  const rawJsonUrl = contract
    ? `${SOURCIFY_API}/v2/contract/${chainId}/${contract}?fields=sources`
    : undefined;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
        <h3>Verify this contract</h3>
        <span className="eyebrow">independent check</span>
      </div>
      <p className="small muted" style={{ marginBottom: 14 }}>
        Do not trust this page — read the deployed source. The address below is what your wallet
        actually talks to.
      </p>

      <div className="stack gap-3">
        <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span className="small muted">Address</span>
          <span className="mono small verify-addr" style={{ textAlign: "right" }}>
            {contract ?? "not deployed on this chain"}
          </span>
        </div>

        <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span className="small muted">Verification</span>
          {state.status === "loading" && <Skeleton w={120} h={16} />}
          {state.status === "exact" && <Badge tone="success">Exact match · Sourcify</Badge>}
          {state.status === "partial" && <Badge tone="warning">Partial match · Sourcify</Badge>}
          {state.status === "unverified" && <Badge tone="danger">Not verified</Badge>}
          {state.status === "unreachable" && <Badge tone="neutral">Checker unreachable</Badge>}
        </div>

        {/* The interface half of the same question: does the ABI this page
            signs with still equal the verified one? */}
        {state.status === "exact" && (
          <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span className="small muted">Interface (ABI)</span>
            {abiState.status === "loading" && <Skeleton w={120} h={16} />}
            {abiState.status === "match" && (
              <span title="Compared entry by entry against the verified contract">
                <Badge tone="success">Matches · {abiState.count} entries</Badge>
              </span>
            )}
            {abiState.status === "drift" && (
              <span title="This page ships a different ABI than the verified contract">
                <Badge tone="danger">
                  Differs · {abiState.localCount} vs {abiState.remoteCount}
                </Badge>
              </span>
            )}
            {abiState.status === "unavailable" && <Badge tone="neutral">Could not compare</Badge>}
          </div>
        )}

        {state.status === "unreachable" && (
          <div className="small muted" style={{ lineHeight: 1.7 }}>
            The verification service did not answer (it rate-limits busy networks). Nothing is
            wrong with the contract — the links below still open the published source directly.
          </div>
        )}

        {state.status === "exact" && (
          <div className="small muted" style={{ lineHeight: 1.7 }}>
            Bytecode and source match the repository exactly — the compiled code on-chain is
            produced from this source, proven by independent re-compilation
            {state.files.length > 0 ? (
              <>
                {" "}
                across {state.files.length} file{state.files.length === 1 ? "" : "s"}, main:{" "}
                <span className="mono">src/EscrowLink.sol</span>
              </>
            ) : null}
            . Open the full Solidity on Sourcify — it is the exact code your wallet talks to.
          </div>
        )}

        <div className="row gap-3" style={{ flexWrap: "wrap", marginTop: 4 }}>
          {sourcifyUrl && state.status !== "unverified" && (
            <a className="btn btn--secondary btn--sm" href={sourcifyUrl} target="_blank" rel="noopener noreferrer">
              Read source on Sourcify <IconExternal size={13} strokeWidth={3} />
            </a>
          )}
          {explorerUrl && (
            <a className="btn btn--secondary btn--sm" href={explorerUrl} target="_blank" rel="noopener noreferrer">
              Open in explorer <IconExternal size={13} strokeWidth={3} />
            </a>
          )}
          {rawJsonUrl && (
            <a
              className="btn btn--secondary btn--sm"
              href={rawJsonUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Raw JSON <IconExternal size={13} strokeWidth={3} />
            </a>
          )}
          {state.status === "unreachable" && (
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setAttempt((a) => a + 1)}>
              Retry check
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
