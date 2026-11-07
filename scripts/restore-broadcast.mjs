/**
 * One-shot: rebuild broadcast/Deploy.s.sol/<chain>/run-latest.json from a
 * fetched transaction + receipt.
 *
 * The local anvil sandbox overwrote the real Base Sepolia deployment record
 * (forge always writes run-latest.json). This restores it from the chain
 * itself, so the provenance file matches what is actually deployed.
 *
 * Usage: node scripts/restore-broadcast.mjs <chainId> <txHash> <blockTsMs>
 * Env: REAL_TX, REAL_RECEIPT (cast --json output), REAL_ARGS (JSON array of
 *      constructor arguments), FOUNDRY_COMMIT (optional).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [chainId, txHash, blockTsMs] = process.argv.slice(2);
if (!chainId || !txHash || !blockTsMs) {
  console.error("usage: restore-broadcast.mjs <chainId> <txHash> <blockTsMs>   (REAL_ARGS, REAL_TX, REAL_RECEIPT in env)");
  process.exit(1);
}

/**
 * Read JSON that PowerShell may have written as UTF-16 (its `>` redirect
 * default): detect the BOM and decode accordingly, then strip any stray
 * leading whitespace or BOM before parsing.
 */
function readJson(path) {
  const buf = readFileSync(path);
  let text;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString("utf16le");
  else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.toString("utf8").slice(1);
  else text = buf.toString("utf8");
  return JSON.parse(text.replace(/^[\s\uFEFF]+/, ""));
}

const tx = readJson(process.env.REAL_TX);
const receipt = readJson(process.env.REAL_RECEIPT);
// Constructor args come through the environment: passing a JSON array as a
// command-line argument loses its quotes on the way through PowerShell.
const args = JSON.parse(process.env.REAL_ARGS ?? "[]");

// cast returns numbers as hex strings; forge writes them the same way, so
// the receipt can be carried over as-is apart from the field set forge emits.
const FIELDS = [
  "status",
  "cumulativeGasUsed",
  "logs",
  "logsBloom",
  "type",
  "transactionHash",
  "transactionIndex",
  "blockHash",
  "blockNumber",
  "gasUsed",
  "effectiveGasPrice",
  "blobGasPrice",
  "from",
  "to",
  "contractAddress",
  "size",
];
const out = {};
for (const f of FIELDS) if (receipt[f] !== undefined) out[f] = receipt[f];

const record = {
  transactions: [
    {
      hash: tx.hash,
      transactionType: "CREATE",
      contractName: "EscrowLink",
      contractAddress: receipt.contractAddress,
      function: null,
      arguments: args,
      transaction: {
        from: tx.from,
        gas: tx.gas,
        value: tx.value,
        input: tx.input,
        nonce: tx.nonce,
        chainId: tx.chainId,
      },
      additionalContracts: [],
      isFixedGasLimit: false,
    },
  ],
  receipts: [out],
  libraries: [],
  pending: {},
  returns: {
    escrow: {
      internal_type: "contract EscrowLink",
      value: receipt.contractAddress,
    },
  },
  // forge stamps the run wall-clock; the deploy block's time is the closest
  // honest proxy once the original file is gone.
  timestamp: Number(blockTsMs),
  chain: Number(chainId),
  commit: process.env.FOUNDRY_COMMIT ?? "",
};

const dest = resolve(root, "broadcast", "Deploy.s.sol", chainId, "run-latest.json");
writeFileSync(dest, `${JSON.stringify(record, null, 2)}\n`, "utf8");
console.log(`restored ${dest}`);
console.log(`  contract: ${receipt.contractAddress}`);
console.log(`  tx:       ${receipt.transactionHash}`);
console.log(`  block:    ${receipt.blockNumber}`);
