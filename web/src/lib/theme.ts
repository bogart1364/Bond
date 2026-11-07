import { useEffect, useState } from "react";

/**
 * Edition switch: the day print run or Shabnameh, the night press.
 *
 * The choice is stored in localStorage and applied to <html data-theme>
 * by an inline script in index.html BEFORE first paint, so the paper never
 * flashes the wrong color. With no stored choice the system preference
 * wins; live system changes are followed until the reader picks an edition
 * themselves. Every tab stays in sync through the storage and custom events.
 */

export type Theme = "light" | "dark";

const STORAGE_KEY = "bond-theme";
const CHANGE_EVENT = "bond:theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/** The reader's stored choice, or null when they never picked one. */
export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

/** Which edition the page should show right now. */
export function resolveTheme(): Theme {
  const stored = storedTheme();
  if (stored) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply an edition to the document (no persistence). */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Persist the reader's choice, apply it, notify every listener. */
export function writeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* Storage blocked (private mode): the session still switches. */
  }
  applyTheme(theme);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Flip between editions and persist the result. */
export function flipTheme(current: Theme): Theme {
  const next: Theme = current === "dark" ? "light" : "dark";
  writeTheme(next);
  return next;
}

/** Live theme state for the header switch. */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  // The inline head script already set data-theme before React mounts.
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );

  useEffect(() => {
    const sync = () => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) sync();
    };
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => {
      // Follow the OS only while the reader has no explicit choice.
      if (storedTheme() === null) sync();
    };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    media.addEventListener("change", onMedia);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
      media.removeEventListener("change", onMedia);
    };
  }, []);

  return {
    theme,
    toggleTheme: () => {
      setTheme(flipTheme(theme));
    },
  };
}
