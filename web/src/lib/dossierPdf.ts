import type { Address } from "viem";
import qrcode from "qrcode-generator";
import { eventLabel, type TimelineEntry } from "./activity";
import { chainLabel, explorerAddressUrl, explorerTxUrl } from "./chains";
import { formatUsdc } from "./format";
import playfair700Url from "../assets/fonts/playfair-700.ttf";
import playfair900Url from "../assets/fonts/playfair-900.ttf";

/**
 * Evidence dossier, typeset as a PDF packet.
 *
 * The plain-text dossier travels by email; this one is made to be printed
 * and handed across a desk — to an arbiter, a mediator, a small-claims
 * clerk. It is set in the platform's own press dress: a cover with the
 * nameplate and a rubber-stamp status, then parties, amounts, terms and
 * the full event log, every transaction hash a live link.
 *
 * Nothing here is fetched from Bond. The data is the same public timeline
 * the page already holds; the fonts are vendored so the document renders
 * identically offline; jsPDF is imported only when the button is pressed,
 * so none of this weighs on first paint.
 */

type RGB = [number, number, number];

/** A4 portrait, in points (jsPDF's unit here). */
const W = 595.28;
const H = 841.89;
const ML = 54;
const MR = 54;
const CW = W - ML - MR;
/** Body pages: content starts under the running head... */
const TOP = 96;
/** ...and stops above the footer rule. */
const BOT = H - 84;

/* ── Ink: the platform palette, sampled from design/tokens.css ── */
const INK: RGB = [22, 19, 15];
const INK2: RGB = [76, 70, 59];
const INK3: RGB = [124, 117, 102];
const CREAM: RGB = [244, 240, 230];
const LINE: RGB = [203, 196, 179];
const BLUE: RGB = [0, 82, 255];
const GREEN: RGB = [31, 107, 74];
const AMBER: RGB = [154, 107, 16];
const RED: RGB = [163, 34, 24];

/** Press-stamp copy per state — word and ink, matching the UI badge tones. */
const STAMP: Record<string, { word: string; color: RGB }> = {
  None: { word: "NOT FOUND", color: INK3 },
  Created: { word: "AWAITING FUNDING", color: AMBER },
  Funded: { word: "FUNDS LOCKED", color: BLUE },
  Disputed: { word: "IN DISPUTE", color: RED },
  Completed: { word: "COMPLETED", color: GREEN },
  Cancelled: { word: "CANCELLED", color: INK2 },
  Refunded: { word: "REFUNDED", color: INK2 },
};

/** The state explanation the page shows, restated for print. */
const STATE_NOTE: Record<string, string> = {
  None: "No escrow with this number exists on this chain.",
  Created: "The payer has not locked the funds yet. Nothing is at risk - this escrow can still be cancelled.",
  Funded: "The amount is locked in the contract. The payer can confirm delivery, or either party can open a dispute.",
  Disputed:
    "The arbiter is reviewing this escrow. Settlement is paused for a published 7-day window; if they stay silent, the plain timeout rule takes over again.",
  Completed: "Funds have been released to the payee. This escrow is final.",
  Cancelled: "This escrow was cancelled before funding. No money was ever locked.",
  Refunded: "The full amount was returned to the payer. This escrow is final.",
};

/** Everything the packet needs — assembled by the dossier card. */
export interface DossierData {
  id: bigint;
  chainId: number;
  contract: Address | undefined;
  payer: Address;
  payee: Address;
  arbiter: Address;
  amount: bigint;
  feeBps: number;
  /** Unix seconds. */
  deadline: number;
  /** Unix seconds. */
  createdAt: number;
  /** An ESCROW_STATE_NAMES entry, e.g. "Completed". */
  stateName: string;
  description: string;
  consented: boolean;
  /** Full lifecycle timeline, oldest first (the page's own timeline data). */
  rows: TimelineEntry[];
  /** Unix seconds — the moment this packet was composed. */
  generatedAt: number;
}

interface Figure {
  label: string;
  value: string;
  strong?: boolean;
}

/**
 * The amount rows, state-aware: a dispute moves the split (the actuals
 * live in the ruling event), a refund pays nobody, and a cancelled
 * escrow locked nothing — the packet must never print the hypothetical.
 */
function amountFigures(d: DossierData, resolved: TimelineEntry | undefined): Figure[] {
  const amount = `${formatUsdc(d.amount)} USDC`;
  const feeLabel = `Protocol fee (${Number(d.feeBps) / 100}%)`;
  const nominal = (d.amount * BigInt(d.feeBps)) / 10_000n;

  if (d.stateName === "Completed" && resolved) {
    return [
      { label: "Amount", value: amount },
      { label: feeLabel, value: `${formatUsdc(resolved.fee ?? 0n)} USDC` },
      { label: "Returned to payer", value: `${formatUsdc(resolved.payerAmount ?? 0n)} USDC` },
      { label: "Payee receives", value: `${formatUsdc(resolved.payeeAmount ?? 0n)} USDC`, strong: true },
    ];
  }
  if (d.stateName === "Refunded") {
    return [
      { label: "Amount", value: amount },
      { label: feeLabel, value: "0 USDC" },
      { label: "Returned to payer", value: amount },
      { label: "Payee receives", value: "0 USDC", strong: true },
    ];
  }
  if (d.stateName === "Cancelled") {
    return [
      { label: "Amount", value: amount },
      { label: "Locked in contract", value: "0 USDC" },
      { label: "Payee receives", value: "0 USDC", strong: true },
    ];
  }
  if (d.stateName === "Disputed") {
    return [
      { label: "Amount locked", value: amount },
      { label: "Outcome", value: "Awaiting arbiter ruling", strong: true },
    ];
  }
  return [
    { label: "Amount", value: amount },
    { label: feeLabel, value: `${formatUsdc(nominal)} USDC` },
    { label: "Payee receives", value: `${formatUsdc(d.amount - nominal)} USDC`, strong: true },
  ];
}

/** Cover strapline for the record's disposition. */
function packetKind(stateName: string): string {
  switch (stateName) {
    case "Disputed":
      return "DISPUTE PACKET";
    case "Cancelled":
      return "CANCELLATION RECORD";
    case "Refunded":
      return "REFUND RECORD";
    case "Completed":
      return "SETTLEMENT RECORD";
    default:
      return "ESCROW RECORD";
  }
}

/** A vendored TTF as base64, for jsPDF's virtual file system. */
async function fontBase64(url: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let binary = "";
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

const when = (unix: number): string =>
  new Date(unix * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

const whenShort = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");

const shortHash = (tx: string): string => `${tx.slice(0, 8)}…${tx.slice(-4)}`;

const shortAddress = (a: Address): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Compose the packet and hand it to the browser as a download.
 *
 * The document is one pass per zone: cover first (it owns the full page),
 * then flowing body pages, then a chrome pass that stamps the running
 * head, the footer and the real page numbers once the count is known.
 */
export async function downloadDossierPdf(d: DossierData): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });

  // Playfair Display, vendored (latin subset, OFL). A failed fetch falls
  // back to Times — the packet must print even if the assets do not load.
  let displayFamily = "times";
  try {
    const [b700, b900] = await Promise.all([fontBase64(playfair700Url), fontBase64(playfair900Url)]);
    doc.addFileToVFS("playfair-700.ttf", b700);
    doc.addFont("playfair-700.ttf", "PF", "normal");
    doc.addFileToVFS("playfair-900.ttf", b900);
    doc.addFont("playfair-900.ttf", "PF", "bold");
    displayFamily = "PF";
  } catch {
    /* Times carries the nameplate instead. */
  }

  const origin = window.location.origin;
  const liveUrl = `${origin}/?escrow=${d.id.toString()}`;
  const sourcifyUrl = d.contract
    ? `https://repo.sourcify.dev/contracts/full_match/${d.chainId}/${d.contract}/`
    : "https://repo.sourcify.dev/";

  const resolved =
    d.stateName === "Completed" || d.stateName === "Refunded"
      ? (d.rows.find((e) => e.kind === "DisputeResolved") ?? undefined)
      : undefined;
  const figures = amountFigures(d, resolved);
  const stampInfo = STAMP[d.stateName] ?? STAMP.None;

  // ── Primitives ────────────────────────────────────────────────

  let y = TOP;

  const fill = (c: RGB): void => void doc.setFillColor(c[0], c[1], c[2]);
  const serif = (style: "normal" | "bold" | "italic", size: number, color: RGB): void => {
    doc.setFont("times", style);
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
  };
  const mono = (style: "normal" | "bold", size: number, color: RGB): void => {
    doc.setFont("courier", style);
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
  };
  const disp = (style: "normal" | "bold", size: number, color: RGB): void => {
    doc.setFont(displayFamily, style);
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
  };
  const rule = (x1: number, atY: number, x2: number, width: number, color: RGB): void => {
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(width);
    doc.line(x1, atY, x2, atY);
  };
  /** Uppercase typewriter micro-label — the platform's .eyebrow. */
  const eyebrow = (
    s: string,
    x: number,
    atY: number,
    opts: { size?: number; color?: RGB; cs?: number; align?: "left" | "center" | "right" } = {},
  ): void => {
    const cs = opts.cs ?? 1.1;
    mono("bold", opts.size ?? 7.5, opts.color ?? INK3);
    const inkWidth = doc.getTextWidth(s) + cs * Math.max(s.length - 1, 0);
    const x0 = opts.align === "center" ? x - inkWidth / 2 : opts.align === "right" ? x - inkWidth : x;
    doc.text(s, x0, atY, { charSpace: cs });
  };
  /** Reserve height, opening a new body page when the column runs out. */
  const ensure = (h: number): boolean => {
    if (y + h > BOT) {
      doc.addPage();
      y = TOP;
      return true;
    }
    return false;
  };
  const wrap = (s: string, width: number): string[] => doc.splitTextToSize(s, width) as string[];
  const writeWrapped = (s: string, width: number, size: number, color: RGB, style: "normal" | "italic"): void => {
    serif(style, size, color);
    for (const ln of wrap(s, width)) {
      ensure(size + 5);
      doc.text(ln, ML, y);
      y += size + 4.5;
    }
  };

  // ── Cover ─────────────────────────────────────────────────────

  const regMark = (cx: number, cy: number): void => {
    doc.setDrawColor(INK3[0], INK3[1], INK3[2]);
    doc.setLineWidth(0.5);
    doc.circle(cx, cy, 5.5);
    doc.line(cx - 9.5, cy, cx + 9.5, cy);
    doc.line(cx, cy - 9.5, cx, cy + 9.5);
  };

  /** Rubber-stamp: double-ruled box, tilted like it was pressed by hand. */
  const stamp = (cx: number, cy: number, word: string, color: RGB): void => {
    const ang = (7 * Math.PI) / 180;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const corner = (px: number, py: number): [number, number] => {
      const dx = px - cx;
      const dy = py - cy;
      return [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos];
    };
    const box = (x0: number, y0: number, x1: number, y1: number): void => {
      const pts: Array<[number, number]> = [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)];
      for (let i = 0; i < 4; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % 4];
        doc.line(a[0], a[1], b[0], b[1]);
      }
    };
    const cs = 2.2;
    mono("bold", 16, color);
    const textW = doc.getTextWidth(word) + cs * Math.max(word.length - 1, 0);
    const bw = textW + 44;
    const bh = 46;
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(2.2);
    box(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2);
    doc.setLineWidth(0.8);
    box(cx - bw / 2 + 5, cy - bh / 2 + 5, cx + bw / 2 - 5, cy + bh / 2 - 5);
    doc.setTextColor(color[0], color[1], color[2]);
    const t0 = corner(cx - textW / 2, cy + 5.8);
    doc.text(word, t0[0], t0[1], { charSpace: cs, angle: 7 });
  };

  const cover = (): void => {
    fill(CREAM);
    doc.rect(0, 0, W, H, "F");
    regMark(30, 30);
    regMark(W - 30, 30);
    regMark(30, H - 66);
    regMark(W - 30, H - 66);

    // Strapline over the double rule
    eyebrow(`NON-CUSTODIAL USDC ESCROW`, ML, 54, { size: 7.5, color: INK2 });
    eyebrow(`PRINTED ON ${chainLabel(d.chainId).toUpperCase()} · CHAIN ${d.chainId}`, W - MR, 54, {
      size: 7.5,
      color: INK3,
      align: "right",
    });
    rule(ML, 62, W - MR, 2.2, INK);
    rule(ML, 68, W - MR, 0.7, INK);

    // Nameplate
    disp("bold", 86, INK);
    const mcs = 7;
    const mw = doc.getTextWidth("BOND") + mcs * ("BOND".length - 1);
    doc.text("BOND", (W - mw) / 2, 152, { charSpace: mcs });
    rule(ML, 168, W - MR, 0.7, INK);
    eyebrow("THE RECORD IS THE CONTRACT", W / 2, 184, { size: 8, color: INK2, cs: 2.4, align: "center" });
    rule(ML, 196, W - MR, 0.7, INK);

    // Title and disposition
    disp("normal", 34, INK);
    doc.text("Evidence Dossier", W / 2, 234, { align: "center" });
    eyebrow(`ESCROW #${d.id.toString()} · ${packetKind(d.stateName)}`, W / 2, 256, {
      size: 8.5,
      color: INK2,
      cs: 2,
      align: "center",
    });
    stamp(W / 2, 302, stampInfo.word, stampInfo.color);

    // Parties
    rule(ML, 338, W - MR, 1.1, INK);
    eyebrow("THE PARTIES", ML, 352, { size: 7.5, color: INK3 });
    const trio: Array<[string, Address]> = [
      ["PAYER", d.payer],
      ["PAYEE", d.payee],
      ["ARBITER", d.arbiter],
    ];
    let partyY = 376;
    trio.forEach(([lab, addr], i) => {
      eyebrow(lab, ML, partyY, { size: 7.5, color: INK3 });
      mono("normal", 9.5, INK);
      doc.textWithLink(addr, ML + 78, partyY, { url: explorerAddressUrl(d.chainId, addr) });
      if (i < 2) rule(ML, partyY + 9, W - MR, 0.4, LINE);
      partyY += 26;
    });
    rule(ML, 448, W - MR, 1.1, INK);

    // Figures, two columns: the money left, the schedule right
    eyebrow("THE FIGURES", ML, 462, { size: 7.5, color: INK3 });
    const meta: Figure[] = [
      { label: "CREATED", value: whenShort(d.createdAt) },
      { label: "DEADLINE", value: whenShort(d.deadline) },
      { label: "EVENTS", value: `${d.rows.length} on-chain` },
    ];
    const colX = ML + 250;
    const cells = Math.max(figures.length, meta.length);
    let figureY = 486;
    for (let i = 0; i < cells; i++) {
      const f = figures[i];
      if (f) {
        eyebrow(f.label.toUpperCase(), ML, figureY, { size: 6.8, color: INK3, cs: 0.9 });
        serif(f.strong ? "bold" : "normal", f.strong ? 13 : 12, f.strong ? INK : INK2);
        doc.text(f.value, ML, figureY + 16);
      }
      const m = meta[i];
      if (m) {
        eyebrow(m.label, colX, figureY, { size: 6.8, color: INK3, cs: 0.9 });
        mono("normal", 10, INK2);
        doc.text(m.value, colX, figureY + 16);
      }
      figureY += 34;
    }
    rule(ML, 624, W - MR, 1.1, INK);

    // QR: the link, engraved
    const frame = { x: ML, y: 640, size: 112 };
    const code = qrcode(0, "M");
    code.addData(liveUrl);
    code.make();
    const n = code.getModuleCount();
    const quiet = 4;
    const cell = (frame.size - 16) / (n + quiet * 2);
    const x0 = frame.x + 8 + cell * quiet;
    const y0 = frame.y + 8 + cell * quiet;
    fill(INK);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (code.isDark(r, c)) doc.rect(x0 + c * cell, y0 + r * cell, cell + 0.03, cell + 0.03, "F");
      }
    }
    doc.setDrawColor(INK[0], INK[1], INK[2]);
    doc.setLineWidth(1);
    doc.rect(frame.x, frame.y, frame.size, frame.size);

    const qrTextX = ML + 134;
    eyebrow("SCAN TO OPEN THE LIVE RECORD", qrTextX, 656, { size: 7.5, color: INK2 });
    serif("italic", 11, INK2);
    const pitch =
      "The link is the record. Whoever holds it sees exactly what you see - there is nothing private in it to leak.";
    let pitchY = 676;
    for (const ln of wrap(pitch, W - MR - qrTextX)) {
      doc.text(ln, qrTextX, pitchY);
      pitchY += 14;
    }
    mono("normal", 8, BLUE);
    doc.textWithLink(liveUrl, qrTextX, pitchY + 8, { url: liveUrl });

    // Colophon over the band
    mono("normal", 6.5, INK3);
    doc.text(
      "This packet renders public on-chain data at generation time. It is not a legal instrument - the contract, its source and its event logs prevail.",
      ML,
      778,
    );

    // Base blue band
    fill(BLUE);
    doc.rect(0, H - 54, W, 54, "F");
    disp("bold", 15, CREAM);
    doc.text("BOND", ML, H - 26);
    eyebrow(`USDC ESCROW · ${chainLabel(d.chainId).toUpperCase()}`, ML + 64, H - 28, {
      size: 7,
      color: CREAM,
      cs: 1.4,
    });
    mono("normal", 8, CREAM);
    doc.text(`CONTRACT ${d.contract ? shortAddress(d.contract) : "not on this chain"}`, W - MR, H - 28, {
      align: "right",
    });
  };

  // ── Body sections ─────────────────────────────────────────────

  const sectionHead = (index: string, title: string): void => {
    ensure(54);
    mono("bold", 8, BLUE);
    doc.text(`${index} /`, ML, y);
    disp("bold", 15, INK);
    doc.text(title, ML + 40, y);
    y += 10;
    rule(ML, y, W - MR, 1.1, INK);
    y += 24;
  };

  const partyRow = (label: string, addr: Address): void => {
    ensure(30);
    eyebrow(label, ML, y, { size: 7.5, color: INK3 });
    mono("normal", 10, INK);
    doc.textWithLink(addr, ML + 78, y, { url: explorerAddressUrl(d.chainId, addr) });
    y += 9;
    rule(ML, y, W - MR, 0.4, LINE);
    y += 17;
  };

  const figureRow = (f: Figure): void => {
    ensure(f.strong ? 32 : 24);
    if (f.strong) rule(ML, y - 14, W - MR, 1.1, INK);
    serif(f.strong ? "bold" : "normal", 10.5, f.strong ? INK : INK2);
    doc.text(f.label, ML, y);
    mono("bold", f.strong ? 11 : 10, f.strong ? INK : INK2);
    doc.text(f.value, W - MR, y, { align: "right" });
    y += f.strong ? 28 : 23;
  };

  const scheduleRow = (label: string, value: string): void => {
    ensure(24);
    serif("normal", 10.5, INK2);
    doc.text(label, ML, y);
    mono("normal", 10, INK);
    doc.text(value, W - MR, y, { align: "right" });
    y += 8;
    rule(ML, y, W - MR, 0.4, LINE);
    y += 16;
  };

  const termsBlock = (): void => {
    const text = d.description.replace(/\s+/g, " ").trim() || "(no description was recorded)";
    serif("italic", 10.5, INK);
    const lines = wrap(text, CW - 40);
    ensure(Math.min(lines.length * 14 + 30, BOT - TOP - 40));
    rule(ML, y - 14, W - MR, 1.1, INK);
    y += 6;
    for (const ln of lines) {
      ensure(15);
      doc.text(ln, ML + 20, y);
      y += 14;
    }
    y += 4;
    rule(ML, y, W - MR, 1.1, INK);
    y += 18;
    eyebrow(`EIP-712 TERMS CO-SIGNED BY PAYEE AND ARBITER: ${d.consented ? "YES" : "NO"}`, ML, y, {
      size: 7.5,
      color: INK2,
    });
    y += 16;
  };

  const eventTableHead = (): void => {
    const at = y;
    eyebrow("DATE", ML, at, { size: 6.8, color: INK3, cs: 0.9 });
    eyebrow("EVENT", ML + 84, at, { size: 6.8, color: INK3, cs: 0.9 });
    eyebrow("TRANSACTION", ML + 306, at, { size: 6.8, color: INK3, cs: 0.9 });
    eyebrow("BLOCK", W - MR, at, { size: 6.8, color: INK3, cs: 0.9, align: "right" });
    y += 6;
    rule(ML, y, W - MR, 1, INK);
    y += 15;
  };

  const eventRow = (e: TimelineEntry): void => {
    const label = eventLabel(e);
    serif("normal", 8.5, INK);
    const lines = wrap(label, 206);
    const rowH = Math.max(lines.length * 11, 12) + 17;
    if (ensure(rowH)) eventTableHead();

    mono("normal", 7, INK2);
    doc.text(e.timestamp !== undefined ? whenShort(e.timestamp) : "unknown", ML, y);

    serif("normal", 8.5, INK);
    lines.forEach((ln, i) => doc.text(ln, ML + 84, y + i * 11));

    mono("normal", 7.5, BLUE);
    doc.textWithLink(shortHash(e.txHash), ML + 306, y, { url: explorerTxUrl(d.chainId, e.txHash) });

    mono("normal", 7, INK3);
    doc.text(`#${e.blockNumber.toString()}`, W - MR, y, { align: "right" });

    y += lines.length * 11 + 5;
    rule(ML, y, W - MR, 0.4, LINE);
    y += 12;
  };

  const numbered = (n: number, text: string, link?: { label: string; url: string }): void => {
    mono("bold", 8.5, BLUE);
    doc.text(`${n}.`, ML, y);
    serif("normal", 10, INK);
    const lines = wrap(text, CW - 34);
    for (const ln of lines) {
      ensure(14);
      doc.text(ln, ML + 24, y);
      y += 13;
    }
    if (link) {
      y += 3;
      mono("normal", 8, BLUE);
      for (const ln of wrap(link.label, CW - 34)) {
        ensure(13);
        doc.textWithLink(ln, ML + 24, y, { url: link.url });
        y += 11.5;
      }
    }
    y += 9;
  };

  const body = (): void => {
    sectionHead("01", "The parties");
    partyRow("PAYER", d.payer);
    partyRow("PAYEE", d.payee);
    partyRow("ARBITER", d.arbiter);
    y += 8;

    sectionHead("02", "Amounts and outcome");
    for (const f of figures) figureRow(f);
    y += 2;
    const note =
      d.stateName === "Completed" && resolved
        ? "The arbiter ruled on this dispute. The figures above are what actually moved, read from the ruling event."
        : (STATE_NOTE[d.stateName] ?? "");
    if (note) writeWrapped(note, CW - 30, 9.5, INK2, "italic");
    y += 12;

    sectionHead("03", "Schedule");
    scheduleRow("Created", when(d.createdAt));
    scheduleRow("Delivery deadline", when(d.deadline));
    scheduleRow("Timeout opens (+48h)", when(d.deadline + 48 * 60 * 60));
    y += 8;

    sectionHead("04", "Terms");
    termsBlock();

    sectionHead("05", "Event log");
    eventTableHead();
    if (d.rows.length === 0) {
      serif("italic", 9.5, INK2);
      doc.text("(no lifecycle events found yet)", ML, y);
      y += 20;
    } else {
      for (const e of d.rows) eventRow(e);
    }
    y += 6;
    mono("normal", 7, INK3);
    const caption = `${d.rows.length} event${d.rows.length === 1 ? "" : "s"}, read from public logs. Every hash above opens the matching transaction in the explorer. All times UTC.`;
    for (const ln of wrap(caption, CW)) {
      ensure(11);
      doc.text(ln, ML, y);
      y += 10;
    }
    y += 14;

    sectionHead("06", "How to verify");
    numbered(1, "Open the live record - the same data, freshly read from the chain:", {
      label: liveUrl,
      url: liveUrl,
    });
    numbered(2, "Click any transaction hash in the event log; the explorer shows the same event.");
    if (d.contract) {
      numbered(3, "Read the deployed source - Bond is source-verified on Sourcify:", {
        label: sourcifyUrl,
        url: sourcifyUrl,
      });
    } else {
      numbered(3, "The contract is not deployed on this chain.");
    }
    numbered(4, "Call escrowCount() and feeBps() yourself: every figure on this page comes from those calls and from event logs.");
    y += 4;

    ensure(56);
    eyebrow("CONTRACT ADDRESS", ML, y, { size: 7, color: INK3 });
    y += 16;
    if (d.contract) {
      mono("normal", 10, INK);
      doc.textWithLink(d.contract, ML, y, { url: explorerAddressUrl(d.chainId, d.contract) });
    } else {
      mono("normal", 10, INK3);
      doc.text("not deployed on this chain", ML, y);
    }
    y += 22;

    serif("italic", 9, INK3);
    const colophon =
      `Bond is open-source and source-verified, not audited. This packet renders public data; the contract and its logs prevail. ` +
      `© ${new Date(d.generatedAt * 1000).getUTCFullYear()} Bond · composed ${when(d.generatedAt)}.`;
    for (const ln of wrap(colophon, CW)) {
      ensure(13);
      doc.text(ln, ML, y);
      y += 12;
    }
  };

  // ── Compose ───────────────────────────────────────────────────

  cover();
  doc.addPage();
  y = TOP;
  body();

  // Running head and footer, stamped once the page count is known.
  const total = doc.getNumberOfPages();
  for (let p = 2; p <= total; p++) {
    doc.setPage(p);
    fill(BLUE);
    doc.rect(ML, 46, 7, 7, "F");
    eyebrow(`BOND — EVIDENCE DOSSIER · ESCROW #${d.id.toString()}`, ML + 15, 53, { size: 7.5, color: INK2 });
    eyebrow(`PAGE ${p} / ${total}`, W - MR, 53, { size: 7.5, color: INK3, align: "right" });
    rule(ML, 62, W - MR, 0.8, INK);

    rule(ML, H - 64, W - MR, 0.4, LINE);
    eyebrow(`GENERATED ${when(d.generatedAt)} · STATE ${d.stateName.toUpperCase()}`, ML, H - 52, {
      size: 6.8,
      color: INK3,
      cs: 0.8,
    });
    mono("normal", 7, INK3);
    doc.textWithLink(`${origin}/?escrow=${d.id.toString()}`, W - MR - doc.getTextWidth(`${origin}/?escrow=${d.id.toString()}`), H - 52, { url: liveUrl });
  }

  doc.setProperties({
    title: `Bond evidence dossier - escrow #${d.id.toString()}`,
    subject: `Escrow record on ${chainLabel(d.chainId)} - state ${d.stateName}`,
    author: "Bond",
    creator: "Bond",
    keywords: `bond, escrow, evidence, ${chainLabel(d.chainId).toLowerCase()}`,
  });

  doc.save(`bond-evidence-escrow-${d.id.toString()}.pdf`);
}
