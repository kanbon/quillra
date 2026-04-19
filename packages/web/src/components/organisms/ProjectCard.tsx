import { useT } from "@/i18n/i18n";
import { Link } from "react-router-dom";

type Props = {
  id: string;
  name: string;
  repo: string;
  role: string;
  updatedAt?: number;
};

function formatUpdated(ts?: number) {
  if (!ts) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(ts);
  } catch {
    return "";
  }
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "·"
  );
}

export function ProjectCard({ id, name, repo, role, updatedAt }: Props) {
  const { t } = useT();
  return (
    <Link
      to={`/p/${id}`}
      className="group flex flex-col rounded-2xl border border-neutral-200/80 bg-white p-5 no-underline shadow-sm transition-all hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-md"
    >
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand/10 to-brand/5 text-[13px] font-semibold text-brand ring-1 ring-brand/20">
          {initialsOf(name)}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-neutral-900">
            {name}
          </h3>
          <p className="truncate font-mono text-[11px] text-neutral-400">{repo}</p>
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between text-[11px]">
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium uppercase tracking-wide text-neutral-500 group-hover:bg-neutral-200">
          {role}
        </span>
        {updatedAt ? (
          <span className="text-neutral-400">
            {t("dashboard.updated", { date: formatUpdated(updatedAt) })}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
