import { Link } from "react-router-dom";
import { LogoMark } from "@/components/atoms/LogoMark";
import { AvatarDropdown } from "@/components/organisms/AvatarDropdown";
import { useT } from "@/i18n/i18n";

/**
 * Global header used on dashboard + instance-settings routes. Inside a
 * specific project we render {@link ProjectHeader} instead.
 *
 * Top-right settings surface: the user's avatar, which opens a dropdown
 * with language, organisation settings (owner-only), and sign-out. No
 * more modal, no more buried gear icon — same entry point pattern as
 * Vercel / Linear / GitHub.
 */
export function AppHeader() {
  const { t } = useT();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200/90 bg-white px-4">
      <Link to="/dashboard" className="flex items-center gap-2 no-underline hover:opacity-90">
        <LogoMark size={22} />
        <span className="font-brand text-lg font-bold text-neutral-900">{t("login.appName")}</span>
      </Link>
      <AvatarDropdown />
    </header>
  );
}
