import { LogoMark } from "@/components/atoms/LogoMark";
import { Spinner } from "@/components/atoms/Spinner";
import { useT } from "@/i18n/i18n";

type Props =
  | { state: "loading" }
  | {
      state: "error";
      detail?: string;
      onRetry: () => void;
    };

/** Full-page setup status used before the wizard can safely render. */
export function SetupStatusScreen(props: Props) {
  const { t } = useT();
  const loading = props.state === "loading";

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <main className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5 px-1">
          <LogoMark size={28} />
          <span className="font-brand text-xl font-bold text-ink">Quillra</span>
          <span className="ml-auto text-[11px] font-semibold uppercase tracking-[0.14em] text-graphite">
            {t("setup.badge")}
          </span>
        </div>

        <section
          className="rounded-2xl border border-rule border-l-2 border-l-brand bg-paper p-6 shadow-sm sm:p-8"
          aria-live="polite"
          role={loading ? "status" : "alert"}
          aria-busy={loading}
        >
          {loading ? (
            <div className="flex items-start gap-3">
              <Spinner className="mt-0.5 size-5 shrink-0" />
              <div>
                <h1 className="text-lg font-semibold tracking-tight text-ink">
                  {t("setup.status.checkingTitle")}
                </h1>
                <p className="mt-1 text-sm leading-relaxed text-graphite">
                  {t("setup.status.checkingBody")}
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/10 text-sm font-bold text-brand"
                  aria-hidden="true"
                >
                  !
                </span>
                <div>
                  <h1 className="text-lg font-semibold tracking-tight text-ink">
                    {t("setup.status.errorTitle")}
                  </h1>
                  <p className="mt-1 text-sm leading-relaxed text-graphite">
                    {t("setup.status.errorBody")}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={props.onRetry}
                className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-ink px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-neutral-800"
              >
                {t("setup.status.retry")}
              </button>

              {props.detail && (
                <details className="mt-5 text-xs text-graphite">
                  <summary className="cursor-pointer font-medium hover:text-ink">
                    {t("setup.status.technicalDetails")}
                  </summary>
                  <p className="mt-2 break-words rounded-lg bg-canvas px-3 py-2 font-mono leading-relaxed">
                    {props.detail}
                  </p>
                </details>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
