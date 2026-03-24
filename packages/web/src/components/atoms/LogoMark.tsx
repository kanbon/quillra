export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={className}
      style={{ fontWeight: 600, letterSpacing: "-0.02em", color: "#c1121f" }}
      aria-hidden
    >
      ✎
    </span>
  );
}
