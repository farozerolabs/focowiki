import { useEffect, useState } from "react";

export type AdminToast = {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
};

export type AdminToastInput = Omit<AdminToast, "id">;

const TOAST_LIMIT = 5;
const TOAST_REMOVE_DELAY_MS = 5_000;
let toastCounter = 0;
let toasts: AdminToast[] = [];
const listeners = new Set<(items: AdminToast[]) => void>();

export function showAdminToast(input: AdminToastInput): string {
  const id = `toast-${Date.now()}-${toastCounter++}`;
  toasts = [{ id, ...input }, ...toasts].slice(0, TOAST_LIMIT);
  emit();
  window.setTimeout(() => dismissAdminToast(id), TOAST_REMOVE_DELAY_MS);
  return id;
}

export function dismissAdminToast(id: string): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function useAdminToast() {
  const [items, setItems] = useState<AdminToast[]>(toasts);

  useEffect(() => {
    listeners.add(setItems);
    return () => {
      listeners.delete(setItems);
    };
  }, []);

  return {
    toasts: items,
    toast: showAdminToast,
    dismiss: dismissAdminToast
  };
}

function emit(): void {
  for (const listener of listeners) {
    listener(toasts);
  }
}
