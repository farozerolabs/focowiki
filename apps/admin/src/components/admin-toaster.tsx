import { useAdminToast } from "@/hooks/use-admin-toast";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport
} from "@/components/ui/toast";

export function AdminToaster() {
  const { dismiss, toasts } = useAdminToast();

  return (
    <ToastProvider>
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          {...(toast.variant ? { variant: toast.variant } : {})}
          onOpenChange={(open) => {
            if (!open) {
              dismiss(toast.id);
            }
          }}
        >
          <div className="grid gap-1">
            <ToastTitle>{toast.title}</ToastTitle>
            {toast.description ? (
              <ToastDescription>{toast.description}</ToastDescription>
            ) : null}
          </div>
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
