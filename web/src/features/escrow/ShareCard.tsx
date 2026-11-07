import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { IconCalendar, IconCopy, IconInspect, IconShare } from "../../components/ui/Icons";
import { useToast } from "../../components/ui/toast-context";

interface Props {
  id: bigint;
  chainId: number;
  /** Unix seconds — the deadline the calendar reminder points at. */
  deadline: number;
  /** Already-formatted figure, e.g. "125.00 USDC". */
  amountLabel: string;
  /** The escrow's own description, quoted into the calendar entry. */
  terms: string;
  /** True when the page is already open in watch-only mode. */
  watchOnly: boolean;
}

/**
 * The share rail: link, QR, watch-only variant and a calendar reminder.
 *
 * Everything here is derived from the URL — the record itself is public, so
 * the QR encodes nothing more than the address bar. The watch-only variant
 * is the same record with every action hidden, for opening on a machine
 * where you do not intend to sign anything.
 */
export function ShareCard({ id, chainId, deadline, amountLabel, terms, watchOnly }: Props) {
  const toast = useToast();
  const [copied, setCopied] = useState<"link" | "watch" | null>(null);

  const escrowId = id.toString();
  const link = `${window.location.origin}/?escrow=${escrowId}`;
  const watchLink = `${link}&watch=1`;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  // ── QR: the link, rendered as engraving ────────────────────
  const qr = useMemo(() => {
    const code = qrcode(0, "M");
    code.addData(link);
    code.make();
    const count = code.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (code.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { d, count };
  }, [link]);

  async function copyText(text: string, which: "link" | "watch") {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; fall back to the old way
      // rather than failing on plain http.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        toast.warning("Copy failed", "Select the link and copy it manually.");
        return;
      }
    }
    setCopied(which);
    toast.success(which === "watch" ? "Watch-only link copied" : "Link copied");
    window.setTimeout(() => setCopied(null), 2500);
  }

  function share() {
    if (canShare) {
      void navigator.share({ title: `Bond escrow #${escrowId}`, url: link }).catch(() => undefined);
    } else {
      void copyText(link, "link");
    }
  }

  // ── Calendar file: deadline, then the 48-hour grace window ──
  function downloadIcs() {
    const stamp = (unix: number) => new Date(unix * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const escapeText = (s: string) =>
      s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

    const summary = `Bond escrow ${escrowId} - deadline`;
    const headline = terms.trim() ? `${amountLabel} - ${terms.trim()}. ` : `${amountLabel} is due at this deadline. `;
    const description = escapeText(
      `${headline}If nobody confirms or disputes, ` +
        `the timeout opens 48 hours later and anyone may return the funds to the payer. ` +
        `Record: ${link}`,
    );

    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Bond//EscrowLink//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:escrow-${escrowId}-${chainId}@bond`,
      `DTSTAMP:${stamp(Math.floor(Date.now() / 1000))}`,
      `DTSTART:${stamp(deadline)}`,
      "DURATION:PT48H",
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${description}`,
      `URL:${link}`,
      "BEGIN:VALARM",
      "TRIGGER:-P1D",
      "ACTION:DISPLAY",
      "DESCRIPTION:Escrow deadline in 24 hours",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ];

    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bond-escrow-${escrowId}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Calendar file downloaded", "Open it to get a reminder 24 hours before the deadline.");
  }

  const actionBtn =
    "btn btn--secondary btn--sm row gap-2";
  const actionIcon = { size: 13, strokeWidth: 4 } as const;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", marginBottom: 6 }}>
        <h3>Share this record</h3>
        <span className="eyebrow">circulation desk</span>
      </div>
      <p className="small muted" style={{ marginBottom: 18 }}>
        The link is the record. Whoever holds it sees exactly what you see — there is nothing private in it to leak.
      </p>

      <div className="row" style={{ gap: 26, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* ── QR plate ──────────────────────────────────── */}
        <div style={{ flex: "0 0 auto", textAlign: "center" }}>
          <div
            style={{
              width: 136,
              height: 136,
              padding: 9,
              background: "#f7f2ec",
              border: "1px solid var(--border-strong)",
            }}
          >
            <svg
              viewBox={`-4 -4 ${qr.count + 8} ${qr.count + 8}`}
              style={{ width: "100%", height: "100%", display: "block" }}
              role="img"
              aria-label={`QR code for escrow ${escrowId}`}
            >
              <path d={qr.d} fill="#16130f" shapeRendering="crispEdges" />
            </svg>
          </div>
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--text-3)",
              marginTop: 7,
            }}
          >
            Scan to open
          </div>
        </div>

        {/* ── Actions ───────────────────────────────────── */}
        <div className="stack gap-3" style={{ flex: "1 1 250px", minWidth: 0 }}>
          <code
            className="mono truncate"
            style={{
              display: "block",
              fontSize: 12.5,
              color: "var(--text-1)",
              background: "var(--bg-inset)",
              border: "1px dashed var(--border-strong)",
              padding: "10px 12px",
              wordBreak: "break-all",
            }}
          >
            {link}
          </code>

          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            <button type="button" className="btn btn--primary btn--sm row gap-2" onClick={() => void copyText(link, "link")}>
              {copied === "link" ? "Copied" : "Copy link"}
              <IconCopy {...actionIcon} />
            </button>

            {canShare && (
              <button type="button" className={actionBtn} onClick={share}>
                Share
                <IconShare {...actionIcon} />
              </button>
            )}

            <button
              type="button"
              className={actionBtn}
              onClick={() => void copyText(watchLink, "watch")}
              title="Open the record with every action hidden"
            >
              {copied === "watch" ? "Copied" : "Watch-only link"}
              <IconInspect {...actionIcon} />
            </button>

            <button type="button" className={actionBtn} onClick={downloadIcs}>
              Calendar
              <IconCalendar {...actionIcon} />
            </button>
          </div>

          <p className="small muted" style={{ lineHeight: 1.65 }}>
            {watchOnly
              ? "You are reading the watch-only version: every action button is hidden, so nothing can be signed from this view."
              : "The watch-only link opens the same record with every action hidden — the right way to read an escrow on a machine where you do not intend to sign."}
            {" Calendar adds one reminder, 24 hours before the deadline."}
          </p>
        </div>
      </div>
    </div>
  );
}
