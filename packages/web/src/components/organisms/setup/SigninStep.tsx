import { clearSetupGateCache } from "@/components/templates/SetupGate";
import { authClient } from "@/lib/auth-client";

/**
 * Sign-in step: terminal screen that launches the GitHub OAuth flow so
 * the first user becomes the instance owner. Owns no values; the
 * round-trip to github.com completes setup on return.
 */
export function SigninStep() {
  return (
    <div className="p-8 text-center">
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-green-100 text-green-600">
        <svg
          className="h-8 w-8"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h2 className="text-[22px] font-semibold tracking-tight text-neutral-900">
        Create your owner account
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">
        Sign in with GitHub now to become the instance owner. Everyone you invite later can sign in
        with just their email.
      </p>
      {/* GitHub brand-compliant sign-in button, follows GitHub's
          published guidance: solid #24292F bg, white text, official
          octocat mark. Do not restyle or recolor the mark. */}
      <button
        type="button"
        onClick={() => {
          // Clear SetupGate's cached status so when the user returns
          // from the GitHub OAuth round-trip the dashboard route
          // refetches /api/setup/status and sees the new owner
          // without bouncing through /setup a second time.
          clearSetupGateCache();
          authClient.signIn.social({
            provider: "github",
            callbackURL: `${window.location.origin}/dashboard`,
          });
        }}
        className="mx-auto mt-8 flex h-11 w-full max-w-[280px] items-center justify-center gap-2.5 rounded-md bg-[#24292F] px-4 text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-[#32383F]"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.575.105.785-.25.785-.555 0-.275-.01-1-.015-1.965-3.2.695-3.875-1.54-3.875-1.54-.525-1.33-1.28-1.685-1.28-1.685-1.045-.715.08-.7.08-.7 1.155.08 1.765 1.185 1.765 1.185 1.03 1.765 2.7 1.255 3.36.96.105-.745.4-1.255.73-1.545-2.555-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.185-3.095-.12-.29-.515-1.465.11-3.055 0 0 .965-.31 3.165 1.18a10.98 10.98 0 0 1 2.88-.385c.98.005 1.97.13 2.88.385 2.195-1.49 3.16-1.18 3.16-1.18.625 1.59.23 2.765.115 3.055.735.805 1.18 1.835 1.18 3.095 0 4.43-2.69 5.405-5.255 5.69.41.355.78 1.055.78 2.125 0 1.535-.015 2.77-.015 3.15 0 .31.205.665.79.555A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
        </svg>
        Sign in with GitHub
      </button>
      <p className="mt-5 text-[11px] leading-snug text-neutral-400">
        GitHub is only required for you, the owner. You'll be able to push to your repos from
        Quillra right after this.
      </p>
    </div>
  );
}
