export function LogoMark({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <img
      src="/quillra-icon-48.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={className}
      style={{ objectFit: "contain" }}
    />
  );
}
