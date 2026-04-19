import type { PresenceUser } from "@/hooks/useProjectPresence";
/**
 * Stack of small circular avatars for the users currently viewing a
 * project, displayed in the ProjectHeader next to the version-history
 * clock. Renders nothing when the list is empty — presence UI is only
 * visible when someone *else* is actually here.
 *
 * Each avatar has a green ring as a "live" indicator, matching the Slack
 * / Google Docs / Figma convention. Hover reveals a tiny tooltip with the
 * viewer's name, email, and role (team / client).
 */
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  users: PresenceUser[];
};

const MAX_VISIBLE = 3;

function initialsOf(name: string, email: string): string {
  const src = name?.trim() || email || "?";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function AvatarBadge({ user }: { user: PresenceUser }) {
  const { t } = useT();
  return (
    <div className="group relative">
      <div className="h-7 w-7 overflow-hidden rounded-full bg-white ring-2 ring-green-400 ring-offset-2 ring-offset-white">
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.image}
            alt={user.name}
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-neutral-200 to-neutral-300 text-[10px] font-semibold text-neutral-700">
            {initialsOf(user.name, user.email)}
          </div>
        )}
      </div>
      {/* Tooltip */}
      <div
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-50 mt-2 w-max max-w-[240px] -translate-y-1 rounded-lg bg-neutral-900 px-3 py-2 text-[11px] text-white opacity-0 shadow-lg transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100"
      >
        <p className="font-semibold leading-tight">{user.name || user.email}</p>
        {user.name && user.email && (
          <p className="mt-0.5 text-[10px] text-neutral-300">{user.email}</p>
        )}
        <p className="mt-1 text-[10px] uppercase tracking-wide text-green-300">
          {user.kind === "client" ? t("presence.clientViewing") : t("presence.viewing")}
        </p>
      </div>
    </div>
  );
}

export function PresenceAvatars({ users }: Props) {
  const { t } = useT();
  if (users.length === 0) return null;

  const visible = users.slice(0, MAX_VISIBLE);
  const hiddenCount = users.length - visible.length;

  return (
    <div
      className={cn("flex items-center")}
      aria-label={t("presence.peopleHere", { count: String(users.length) })}
    >
      {visible.map((u, i) => (
        <div key={u.userId} className={cn(i > 0 && "-ml-2")}>
          <AvatarBadge user={u} />
        </div>
      ))}
      {hiddenCount > 0 && (
        <div
          className="-ml-2 flex h-7 min-w-[1.75rem] items-center justify-center rounded-full bg-neutral-900 px-1.5 text-[10px] font-semibold text-white ring-2 ring-green-400 ring-offset-2 ring-offset-white"
          title={t("presence.moreViewers", { count: String(hiddenCount) })}
        >
          +{hiddenCount}
        </div>
      )}
    </div>
  );
}
