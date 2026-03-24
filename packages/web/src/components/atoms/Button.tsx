import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "outline";
};

export function Button({ className, variant = "primary", disabled, ...props }: Props) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40",
        variant === "primary" &&
          "bg-neutral-900 text-white hover:bg-neutral-800 disabled:hover:bg-neutral-900",
        variant === "ghost" && "bg-transparent text-neutral-800 hover:bg-neutral-100",
        variant === "outline" && "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-50",
        className,
      )}
      {...props}
    />
  );
}
