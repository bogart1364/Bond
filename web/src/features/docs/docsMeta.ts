/**
 * Document metadata, kept out of DocsView so the view file exports only
 * its component (fast refresh) — and so the app shell can recognise a
 * `?doc=` value without pulling in the whole document renderer.
 */

export type DocSlug =
  | "docs"
  | "about"
  | "terms"
  | "privacy"
  | "status"
  | "contact"
  | "arbitration";

const SLUGS: readonly string[] = [
  "docs",
  "about",
  "terms",
  "privacy",
  "status",
  "contact",
  "arbitration",
];

/** Type guard for the `?doc=` query parameter. */
export function isDocSlug(v: string | null | undefined): v is DocSlug {
  return v !== null && v !== undefined && SLUGS.includes(v);
}

/** Short page heading per document slug. */
export const DOC_TITLES: Record<DocSlug, string> = {
  docs: "Documentation",
  about: "About Bond",
  terms: "Terms of service",
  privacy: "Privacy policy",
  status: "System status",
  contact: "Contact",
  arbitration: "Dispute & arbitration",
};

/**
 * One-line folio per document — printed in the strip footer under the
 * title so every document page says what it is without the link farm.
 * Condensed from each document's own deck; keep them truthful.
 */
export const DOC_FOLIO: Record<DocSlug, string> = {
  docs: "Routes, contract, events and the error matrix",
  about: "One contract, one bearer link, one arbiter — no server",
  terms: "Plain English, because the contract is public",
  privacy: "No account, no server, no analytics",
  status: "Live figures — the contract answers for itself",
  contact: "No support inbox — parties, an arbiter, a public record",
  arbitration: "One arbiter per escrow, rules enforced by code",
};
