import { useSearchParams } from "react-router-dom";

/**
 * GitHub App step: either kicks off the App manifest creation flow
 * (when no App is configured yet) or confirms the existing install and
 * lets the user continue. Reads `installed` and `installation_id` from
 * the URL to show "just installed" copy on the post-install bounce.
 *
 * Owns no mutable values; credentials are persisted server-side by the
 * manifest callback, not from this component.
 */
export function GithubAppStep({
  appConfigured,
  appName,
  onBack,
  onNext,
}: {
  appConfigured: boolean;
  appName: string | undefined;
  onBack: () => void;
  onNext: () => void;
}) {
  const [searchParams] = useSearchParams();
  // `installed=1` arrives from /api/setup/github-app/installed
  // after github.com bounces the user back from the install
  // screen. `installation_id` is the numeric id GitHub sends.
  const justInstalled = searchParams.get("installed") === "1";
  const installationId = searchParams.get("installation_id");

  return (
    <div className="p-8">
      <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">
        GitHub App
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        Quillra pushes commits through its own GitHub App. No personal access tokens.
        Installation tokens rotate automatically every hour, and you can revoke
        everything in one click from github.com.
      </p>

      {!appConfigured ? (
        <>
          <div className="mt-6 rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-[13px] leading-relaxed text-neutral-600">
            <p className="font-semibold text-neutral-900">What happens next:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>You click the button below</li>
              <li>GitHub asks you to approve creating the App (one click)</li>
              <li>GitHub asks you which repos to install it on (second click)</li>
              <li>You come back here, ready to go</li>
            </ol>
          </div>
          <a
            href="/api/setup/github-app/start"
            className="mt-5 flex h-11 w-full items-center justify-center gap-2.5 rounded-md bg-[#24292F] px-4 text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-[#32383F]"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.575.105.785-.25.785-.555 0-.275-.01-1-.015-1.965-3.2.695-3.875-1.54-3.875-1.54-.525-1.33-1.28-1.685-1.28-1.685-1.045-.715.08-.7.08-.7 1.155.08 1.765 1.185 1.765 1.185 1.03 1.765 2.7 1.255 3.36.96.105-.745.4-1.255.73-1.545-2.555-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.185-3.095-.12-.29-.515-1.465.11-3.055 0 0 .965-.31 3.165 1.18a10.98 10.98 0 0 1 2.88-.385c.98.005 1.97.13 2.88.385 2.195-1.49 3.16-1.18 3.16-1.18.625 1.59.23 2.765.115 3.055.735.805 1.18 1.835 1.18 3.095 0 4.43-2.69 5.405-5.255 5.69.41.355.78 1.055.78 2.125 0 1.535-.015 2.77-.015 3.15 0 .31.205.665.79.555A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
            </svg>
            Create &amp; install GitHub App
          </a>
          <p className="mt-4 text-[11px] leading-snug text-neutral-400">
            Already have an App? Set{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono">GITHUB_APP_ID</code>{" "}
            and{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono">
              GITHUB_APP_PRIVATE_KEY
            </code>{" "}
            as environment variables and skip this step.
          </p>
          <div className="mt-6">
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900"
            >
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="mt-6 rounded-xl border border-green-200 bg-green-50/80 p-4">
            <div className="flex items-start gap-2.5">
              <svg
                className="mt-0.5 h-5 w-5 shrink-0 text-green-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-green-900">
                  {justInstalled ? "App installed." : "App configured."}
                </p>
                <p className="mt-0.5 text-[12px] leading-snug text-green-800">
                  {appName ? (
                    <>
                      <span className="font-mono">{appName}</span>{" "}
                    </>
                  ) : null}
                  {installationId ? (
                    <>
                      Installation <span className="font-mono">#{installationId}</span>{" "}
                      is active.
                    </>
                  ) : (
                    "Ready to push to the repos you selected."
                  )}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900"
            >
              Back
            </button>
            <button
              type="button"
              onClick={onNext}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm hover:bg-brand/90"
            >
              Continue
            </button>
          </div>
        </>
      )}
    </div>
  );
}
