import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { LogoMark } from "@/components/atoms/LogoMark";
import { useT } from "@/i18n/i18n";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";

type Props =
  | {
      mode: "token";
      working: boolean;
      error: string | null;
      onUnlock: (token: string) => Promise<void>;
    }
  | { mode: "owner" };

/** Fail-closed entry screen for first-run setup and interrupted upgrades. */
export function SetupAccessScreen(props: Props) {
  const { t } = useT();
  const [token, setToken] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.mode !== "token" || props.working || !token.trim()) return;
    void props.onUnlock(token.trim());
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <main className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5 px-1">
          <LogoMark size={28} />
          <span className="font-brand text-xl font-bold text-ink">Quillra</span>
          <span className="ml-auto text-[11px] font-semibold uppercase tracking-[0.14em] text-graphite">
            {t("setup.secureBadge")}
          </span>
        </div>

        <section className="overflow-hidden rounded-3xl border border-rule bg-paper shadow-sm">
          <div className="border-b border-rule bg-[linear-gradient(135deg,rgba(190,20,33,0.08),transparent_58%)] p-6 sm:p-8">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="size-6"
                aria-hidden="true"
              >
                <rect x="5" y="10" width="14" height="10" rx="2" />
                <path strokeLinecap="round" d="M8 10V7a4 4 0 0 1 8 0v3" />
              </svg>
            </div>
            <h1 className="mt-5 text-2xl font-semibold tracking-tight text-ink">
              {props.mode === "token"
                ? t("setup.access.confirmTitle")
                : t("setup.access.ownerTitle")}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-graphite">
              {props.mode === "token" ? t("setup.access.confirmBody") : t("setup.access.ownerBody")}
            </p>
          </div>

          <div className="p-6 sm:p-8">
            {props.mode === "token" ? (
              <form onSubmit={submit}>
                <label
                  htmlFor="setup-access-token"
                  className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600"
                >
                  {t("login.serverAccessLabel")}
                </label>
                <Input
                  id="setup-access-token"
                  type="password"
                  autoComplete="off"
                  autoFocus
                  required
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  disabled={props.working}
                  placeholder={t("login.serverAccessPlaceholder")}
                  className="h-11"
                />
                <p className="mt-2 text-xs leading-relaxed text-graphite">
                  {t("setup.access.hintBeforeToken")}{" "}
                  <code className="rounded bg-canvas px-1 py-0.5">QUILLRA_SETUP_TOKEN</code>
                  {t("setup.access.hintBetweenCommands")}{" "}
                  <code className="rounded bg-canvas px-1 py-0.5">docker compose logs cms</code>.
                </p>
                {props.error && (
                  <p className="mt-3 text-sm text-red-600" role="alert">
                    {props.error}
                  </p>
                )}
                <Button
                  type="submit"
                  variant="brand"
                  disabled={props.working || !token.trim()}
                  className="mt-5 h-11 w-full rounded-xl font-semibold"
                >
                  {props.working ? t("login.checkingAccess") : t("setup.access.continueSecurely")}
                </Button>
              </form>
            ) : (
              <Link
                to="/login"
                className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-neutral-900 px-4 text-sm font-semibold text-white transition-colors hover:bg-neutral-800"
              >
                {t("setup.access.signInAsOwner")}
              </Link>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
