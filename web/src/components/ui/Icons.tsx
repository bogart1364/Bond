import type { CSSProperties, SVGProps } from "react";

/**
 * Press-kit icons — drawn for the "criminal press" theme.
 *
 * Engraving geometry: a 48-unit grid, square caps, mitred joins — no rounded
 * "app icon" softness. Each glyph is meant to sit on an ink or brand plate
 * (the landing runs them at 32px inside a 56px block) or to render small
 * (12–30px) inline, where callers should pass a heavier strokeWidth.
 *
 * Shapes that must hide what sits behind them (a sheet stacked in front of
 * another, the magnifier lens over a page) fill with `--icon-bg`, which the
 * plate defines to match its own background — so the same glyph reads
 * correctly on Base blue and on black ink.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/** Occluding shapes: paint the plate's own colour over whatever is behind. */
const PLATE_FILL: CSSProperties = { fill: "var(--icon-bg, #16130f)" };

function Glyph({ size = 48, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Filed records: two ruled sheets stacked in the archive. */
export function IconLedger(props: IconProps) {
  return (
    <Glyph {...props}>
      {/* the sheet filed behind */}
      <path d="M6 14 H34 V44 H6 Z" />
      {/* front sheet — filled with the plate so the back sheet reads as behind */}
      <path d="M14 6 H42 V38 H14 Z" style={PLATE_FILL} />
      {/* ruled entries */}
      <path d="M20 14 H36 M20 21 H36 M20 28 H30" />
    </Glyph>
  );
}

/** Timeline: a spine with filed events, each with its entry line. */
export function IconTimeline(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M11 8 V40" />
      <path d="M20 8 H41 M20 24 H41 M20 40 H31" />
      <rect x="8" y="5" width="6" height="6" fill="currentColor" stroke="none" />
      <rect x="8" y="21" width="6" height="6" fill="currentColor" stroke="none" />
      <rect x="8" y="37" width="6" height="6" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Verification: read the source under a glass. */
export function IconInspect(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 5 H30 V35 H6 Z" style={PLATE_FILL} />
      <path d="M11 13 H25 M11 20 H21" />
      <circle cx="33" cy="33" r="9" style={PLATE_FILL} />
      <path d="M40 40 L46 46" />
    </Glyph>
  );
}

/** Timeout: sand running out — the 48-hour escape hatch. */
export function IconHourglass(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 6 H36 M12 42 H36" />
      <path d="M15 6 C15 16 24 20 24 24 C24 28 33 32 33 42" />
      <path d="M33 6 C33 16 24 20 24 24 C24 28 15 32 15 42" />
      <path d="M17 10 H31 L24 17 Z" fill="currentColor" stroke="none" />
      <path d="M19 40 H29 L24 31 Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/**
 * Not found: press crop marks framing an empty, dashed footprint —
 * the record that should be here isn't.
 */
export function IconMissingRecord(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 18 V6 H18 M30 6 H42 V18 M42 30 V42 H30 M18 42 H6 V30" />
      <path d="M17 17 H31 V31 H17 Z" strokeDasharray="3 3.5" strokeLinecap="butt" />
    </Glyph>
  );
}

/* ── Interface glyphs ──────────────────────────────────────
   The same engraving grid, used small (12–30px) for buttons,
   toasts, timeline marks and empty states. At these sizes pass
   a heavier `strokeWidth` (3–4) so the rule survives. */

/** Struck check — confirmation, success, "copied". */
export function IconCheck(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M7 25 L19 37 L41 11" />
    </Glyph>
  );
}

/** Crossed out — close, cancel, error. */
export function IconCross(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 10 L38 38 M38 10 L10 38" />
    </Glyph>
  );
}

/** Padlock — funds locked in the contract. */
export function IconLock(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 21 H38 V43 H10 Z" />
      <path d="M16 21 V15 C16 8 32 8 32 15 V21" />
      <circle cx="24" cy="29" r="2.5" fill="currentColor" stroke="none" />
      <path d="M24 32 V37" />
    </Glyph>
  );
}

/** U-turn arrow — funds returned to the payer. */
export function IconRefund(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M36 41 V27 C36 19 30 14 22 14 H10" />
      <path d="M18 6 L10 14 L18 22" />
    </Glyph>
  );
}

/** Stamped triangle — notice, dispute opened, something needs eyes. */
export function IconWarning(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M24 7 L44 42 H4 Z" />
      <path d="M24 20 V30" />
      <rect x="22" y="34" width="4" height="5" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Scales — the arbiter's ruling. */
export function IconScales(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="24" cy="7" r="2.5" fill="currentColor" stroke="none" />
      <path d="M24 10 V41 M15 41 H33 M7 16 H41" />
      <path d="M11 16 V21 M37 16 V21" />
      <path d="M4 21 L11 32 L18 21 M30 21 L37 32 L44 21" />
    </Glyph>
  );
}

/** Pennant on a pole — a milestone slice, defined then released. */
export function IconFlag(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 6 V43" />
      <path d="M12 9 H38 L31 17 L38 25 H12" />
    </Glyph>
  );
}

/** Sealed page — evidence anchored to the record by its hash. */
export function IconSeal(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 5 H30 L38 13 V43 H12 Z" />
      <path d="M30 5 V13 H38" />
      <circle cx="25" cy="30" r="6" />
      <path d="M25 27 V33 M22 30 H28" />
    </Glyph>
  );
}

/** Registration diamond with a struck plus — a new record filed. */
export function IconCreated(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M24 5 L43 24 L24 43 L5 24 Z" />
      <path d="M24 15 V33 M15 24 H33" />
    </Glyph>
  );
}

/** Empty tray — nothing filed here (yet). */
export function IconInbox(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 26 H17 L20 32 H28 L31 26 H42 V42 H6 Z" />
      <path d="M6 26 L11 10 H37 L42 26" />
    </Glyph>
  );
}

/** Billfold with a card pocket — connect a wallet, this address. */
export function IconWallet(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 13 H42 V41 H6 Z" />
      <path d="M6 21 H42" />
      <path d="M30 26 H41 V36 H30 Z" />
      <circle cx="34" cy="31" r="2" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Circular arrow — rescan the chain. */
export function IconRefresh(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M46 8 V20 H34" />
      <path d="M40.98 30 A18 18 0 1 1 36.74 11.28 L46 20" />
    </Glyph>
  );
}

/** Arrow leaving its frame — opens an external page. */
export function IconExternal(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M36 26 V38 A4 4 0 0 1 32 42 H10 A4 4 0 0 1 6 38 V16 A4 4 0 0 1 10 12 H22" />
      <path d="M30 6 H42 V18" />
      <path d="M20 28 L42 6" />
    </Glyph>
  );
}

/** Solid round — the neutral, "not a failure" marker. */
/** Menu: three type-bars — the press's section rule. */
export function IconMenu(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 16h28M10 24h28M10 32h28" />
    </Glyph>
  );
}

export function IconDot(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="24" cy="24" r="7" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Two plain sheets, offset — the duplicate/copy mark. */
export function IconCopy(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 14 H30 V42 H6 Z" />
      <path d="M14 6 H42 V34 H14 Z" style={PLATE_FILL} />
    </Glyph>
  );
}

/** Finder patterns plus a module field — a QR code. */
export function IconQr(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 6 H20 V20 H6 Z" />
      <path d="M28 6 H42 V20 H28 Z" />
      <path d="M6 28 H20 V42 H6 Z" />
      <path d="M9 9 H17 V17 H9 Z" fill="currentColor" stroke="none" />
      <path d="M31 9 H39 V17 H31 Z" fill="currentColor" stroke="none" />
      <path d="M9 31 H17 V39 H9 Z" fill="currentColor" stroke="none" />
      <path d="M28 28 H34 V34 H28 Z" fill="currentColor" stroke="none" />
      <path d="M36 28 H42 V34 H36 Z" fill="currentColor" stroke="none" />
      <path d="M28 36 H34 V42 H28 Z" fill="currentColor" stroke="none" />
      <path d="M36 36 H42 V42 H36 Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Wall calendar — two hanging tabs over a ruled date grid. */
export function IconCalendar(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 12 H42 V42 H6 Z" />
      <path d="M6 21 H42" />
      <path d="M15 6 V15" />
      <path d="M33 6 V15" />
      <path d="M12 27 H17 V32 H12 Z" fill="currentColor" stroke="none" />
      <path d="M21 27 H26 V32 H21 Z" fill="currentColor" stroke="none" />
      <path d="M30 27 H35 V32 H30 Z" fill="currentColor" stroke="none" />
      <path d="M12 35 H17 V40 H12 Z" fill="currentColor" stroke="none" />
      <path d="M21 35 H26 V40 H21 Z" fill="currentColor" stroke="none" />
      <path d="M30 35 H35 V40 H30 Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/** Three filed nodes, linked — the distribution mark. */
export function IconShare(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 18 H18 V30 H6 Z" />
      <path d="M32 6 H44 V18 H32 Z" />
      <path d="M32 30 H44 V42 H32 Z" />
      <path d="M18 24 L32 12" />
      <path d="M18 24 L32 36" />
    </Glyph>
  );
}
