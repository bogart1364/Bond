import { createConfig, fallback, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";

/**
 * RPC strategy: a primary endpoint per chain with automatic failover.
 *
 * publicnode is first because the official Base endpoints cap `eth_getLogs`
 * at 200 blocks, which breaks the activity layer's bounded scans; publicnode
 * serves 50,000. Failover exists because a single public endpoint occasionally
 * answers `eth_call` with an internal error instead of a revert — viem then
 * reports a phantom "contract rejection" and the action dies. Order matters:
 * the most permissive log range first, the strictest last (`chunkedScan`
 * splits on any range error, so every hop stays usable for reads).
 *
 * Set VITE_RPC_URL_MAINNET / VITE_RPC_URL_SEPOLIA to pin a dedicated provider
 * (Alchemy, QuickNode) before production traffic — an explicit URL disables
 * the fallback chain.
 */
const mainnetRpc = import.meta.env.VITE_RPC_URL_MAINNET as string | undefined;
const sepoliaRpc = import.meta.env.VITE_RPC_URL_SEPOLIA as string | undefined;

const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;

export const connectors = [
  injected(),
  coinbaseWallet({ appName: "Bond" }),
  ...(wcProjectId ? [walletConnect({ projectId: wcProjectId, showQrModal: true })] : []),
];

/**
 * Failover policy for the fallback transport (viem's `shouldThrow`).
 *
 * - A contract verdict (`execution reverted …`) is final: every endpoint
 *   would repeat it, and failing over hides the payload viem decodes.
 * - A span limit (publicnode's `exceed maximum block range: 50000`,
 *   HTTP 413, -32614, -32701) is final too: `chunkedScan` splits on that
 *   message and parses the limit OUT of it. Letting it fail over replaced
 *   publicnode's "50000" with sepolia.base.org's "200 range", turning a
 *   4-request scan into ~600 sequential ones — the My Records hang.
 * - Everything else (node-side "Unexpected error", 429, timeouts, dead
 *   endpoints) still fails over — the whole point of the chain.
 */
const REVERT_LIKE = /execution reverted|gas required exceeds allowance/;
// Text forms only — never a bare "413": request bodies carry address hex,
// and a random "413" inside an address must not kill failover.
const SPAN_TEXT_LIKE = /block range|limited to a \d+ range|ranges over \d+|status: 413/i;

function shouldThrow(err: unknown): boolean {
  const e = err as { message?: string; code?: unknown } | undefined;
  const msg = String(e?.message ?? "");
  if (REVERT_LIKE.test(msg) || SPAN_TEXT_LIKE.test(msg)) return true;
  const code = Number(e?.code);
  return (
    code === -32003 || // transaction rejected (final everywhere)
    code === 4001 || // user rejected
    code === 5000 || // walletconnect session settled
    code === -32614 || // eth_getLogs span limit (official Base)
    code === -32701 // eth_getLogs span limit (publicnode)
  );
}

const mainnetTransport = mainnetRpc
  ? http(mainnetRpc)
  : fallback(
      [http("https://base-rpc.publicnode.com"), http("https://mainnet.base.org")],
      { shouldThrow },
    );

const sepoliaTransport = sepoliaRpc
  ? http(sepoliaRpc)
  : fallback(
      [
        http("https://base-sepolia-rpc.publicnode.com"),
        http("https://base-sepolia.drpc.org"),
        http("https://sepolia.base.org"),
      ],
      { shouldThrow },
    );

/** Exported for tests and for building standalone clients with the same RPC policy. */
export const transports = {
  [base.id]: mainnetTransport,
  [baseSepolia.id]: sepoliaTransport,
};

export const wagmiConfig = createConfig({
  chains: [base, baseSepolia],
  connectors,
  transports,
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
