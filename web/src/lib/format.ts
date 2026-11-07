import { USDC_DECIMALS } from "./contracts";

/** Format a 6-decimal USDC bigint for display, trimming trailing zeros. */
export function formatUsdc(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${out}` : out;
}

/** Compact address: 0x1234…abcd */
export function shortAddress(addr: string, chars = 4): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-chars)}`;
}

/** "in 3 days", "2 hours ago" — for deadlines. */
export function relativeTime(unixSeconds: number, nowMs = Date.now()): string {
  const diff = unixSeconds * 1000 - nowMs;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);

  const fmt = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

  let text: string;
  if (mins < 60) text = fmt(mins, "minute");
  else if (mins < 60 * 24) text = fmt(Math.round(mins / 60), "hour");
  else if (mins < 60 * 24 * 30) text = fmt(Math.round(mins / (60 * 24)), "day");
  else text = fmt(Math.round(mins / (60 * 24 * 30)), "month");

  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** Countdown label that turns warning-coloured near the deadline. */
export function deadlineLabel(deadline: number): { text: string; urgent: boolean } {
  const diffMs = deadline * 1000 - Date.now();
  const days = diffMs / 86_400_000;
  return {
    text: diffMs <= 0 ? "Deadline passed" : `Deadline ${relativeTime(deadline)}`,
    urgent: diffMs <= 0 || days < 1,
  };
}
