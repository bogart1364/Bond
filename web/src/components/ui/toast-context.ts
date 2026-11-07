import { createContext, useContext } from "react";

/**
 * Toast contract — lives in its own module so Toast.tsx exports only its
 * component (fast refresh) while `useToast` stays importable everywhere.
 */

export type ToastTone = "neutral" | "success" | "warning" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

export interface ToastApi {
  push: (t: Omit<ToastItem, "id">) => void;
  success: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  /** For declined signatures and other non-failures. */
  neutral: (title: string, description?: string) => void;
}

export const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
