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
