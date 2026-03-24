import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Heading({
  as: Tag = "h1",
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { as?: "h1" | "h2" | "h3" }) {
  return (
    <Tag
      className={cn(
        "font-semibold tracking-tight text-neutral-900",
        Tag === "h1" && "text-2xl",
        Tag === "h2" && "text-xl",
        Tag === "h3" && "text-lg",
        className,
      )}
      {...props}
    />
  );
}
