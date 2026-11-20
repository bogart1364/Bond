import { Attribution } from "ox/erc8021";

/**
 * Base Builder Code — ERC-8021 transaction attribution.
 *
 * This is NOT an HTML meta tag. The code is appended to the END of every
 * transaction's calldata as a data suffix; the contract ignores the trailing
 * bytes and Base's indexers read them to credit activity to this app.
 *
 * Get a code (format `bc_...`, e.g. `bc_b7k3p9da`) from Base Dashboard:
 * Settings -> Project Settings -> Builder Code, then set VITE_BUILDER_CODE
 * in web/.env (and in the Vercel project env) and rebuild.
 *
 * Unset or malformed: no suffix is appended and transactions are unchanged.
 * Every write funnels through lib/tx.ts, which reads DATA_SUFFIX from here.
 */
const code = (import.meta.env.VITE_BUILDER_CODE as string | undefined)?.trim();

/** Builder codes are 1-32 chars of lowercase letters, digits and underscores. */
const SHAPE = /^[a-z0-9_]{1,32}$/;

/** Hex suffix passed to viem as `dataSuffix`, or `undefined` to send none. */
export const DATA_SUFFIX = code && SHAPE.test(code) ? Attribution.toDataSuffix({ codes: [code] }) : undefined;
