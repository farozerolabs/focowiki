import * as React from "react";
import { XIcon } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function ToastProvider({
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Provider>) {
  return <ToastPrimitive.Provider data-slot="toast-provider" {...props} />;
}

function ToastViewport({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      className={cn(
        "fixed top-0 right-0 z-100 flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:bottom-0 sm:top-auto sm:flex-col md:max-w-[420px]",
        className
      )}
      {...props}
    />
  );
}

function Toast({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root> & {
  variant?: "default" | "destructive";
}) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      data-variant={variant}
      className={cn(
        "group pointer-events-auto relative flex w-full items-start justify-between gap-3 overflow-hidden rounded-lg border bg-background p-4 pr-8 text-sm shadow-lg transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[state=closed]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:animate-in data-[state=open]:slide-in-from-top-full sm:data-[state=open]:slide-in-from-bottom-full",
        variant === "destructive" && "border-destructive/40 text-destructive",
        className
      )}
      {...props}
    />
  );
}

function ToastTitle({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn("font-medium", className)}
      {...props}
    />
  );
}

function ToastDescription({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

function ToastClose({
  className,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={cn(
        "absolute top-3 right-3 rounded-md p-1 text-muted-foreground opacity-80 transition-opacity hover:text-foreground focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring group-hover:opacity-100",
        className
      )}
      {...props}
    >
      <XIcon className="size-3" />
    </ToastPrimitive.Close>
  );
}

export {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport
};
