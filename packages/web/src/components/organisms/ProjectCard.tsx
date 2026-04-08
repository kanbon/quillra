import { Link } from "react-router-dom";
import { Heading } from "@/components/atoms/Heading";
import { useT } from "@/i18n/i18n";

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
      timeStyle: "short",
    }).format(ts);
  } catch {
    return "";
  }
}

export function ProjectCard({ id, name, repo, role, updatedAt }: Props) {
  const { t } = useT();
  return (
    <Link
      to={`/p/${id}`}
      className="flex flex-col rounded-xl border border-neutral-200 bg-white p-5 transition-colors hover:border-neutral-400"
    >
      <Heading as="h3" className="mb-1 text-lg">
        {name}
      </Heading>
      <p className="font-mono text-xs text-neutral-500">{repo}</p>
      <div className="mt-4 flex items-center justify-between text-xs text-neutral-400">
        <span className="uppercase tracking-wide">{role}</span>
        {updatedAt ? <span>{t("dashboard.updated", { date: formatUpdated(updatedAt) })}</span> : null}
      </div>
    </Link>
  );
}
