/**
 * Welcome step: intro screen that lists what the wizard will collect
 * (Anthropic key, GitHub App, optional email delivery) and hands the
 * user off to the Anthropic step via a single CTA. Owns no values.
 */
export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="p-8">
      <h1 className="text-[22px] font-semibold tracking-tight text-neutral-900">
        Welcome to Quillra
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-600">
        A few short steps to get this instance running. You'll connect Claude for the AI
        editor and install a GitHub App so Quillra can push to your repos. Email delivery is
        optional.
      </p>
      <ul className="mt-6 divide-y divide-neutral-100 rounded-xl border border-neutral-200/70 bg-neutral-50/50">
        <li className="flex items-center gap-3 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-neutral-700 ring-1 ring-neutral-200">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 7a4 4 0 1 1-3.9 5H8v3H5v-3H3v-3h8.1A4 4 0 0 1 15 7Z" />
              <circle cx="15" cy="11" r="1" fill="currentColor" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-neutral-900">Anthropic API key</p>
            <p className="text-[12px] text-neutral-500">Powers the chat-based editor</p>
          </div>
        </li>
        <li className="flex items-center gap-3 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-neutral-700 ring-1 ring-neutral-200">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.575.105.785-.25.785-.555 0-.275-.01-1-.015-1.965-3.2.695-3.875-1.54-3.875-1.54-.525-1.33-1.28-1.685-1.28-1.685-1.045-.715.08-.7.08-.7 1.155.08 1.765 1.185 1.765 1.185 1.03 1.765 2.7 1.255 3.36.96.105-.745.4-1.255.73-1.545-2.555-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.185-3.095-.12-.29-.515-1.465.11-3.055 0 0 .965-.31 3.165 1.18a10.98 10.98 0 0 1 2.88-.385c.98.005 1.97.13 2.88.385 2.195-1.49 3.16-1.18 3.16-1.18.625 1.59.23 2.765.115 3.055.735.805 1.18 1.835 1.18 3.095 0 4.43-2.69 5.405-5.255 5.69.41.355.78 1.055.78 2.125 0 1.535-.015 2.77-.015 3.15 0 .31.205.665.79.555A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-neutral-900">GitHub App</p>
            <p className="text-[12px] text-neutral-500">
              Scoped access to the repos you pick. Revoke anytime.
            </p>
          </div>
        </li>
        <li className="flex items-center gap-3 px-4 py-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-neutral-700 ring-1 ring-neutral-200">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m3 7 9 6 9-6" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-neutral-900">
              Email delivery{" "}
              <span className="ml-1 font-normal text-neutral-400">· optional</span>
            </p>
            <p className="text-[12px] text-neutral-500">
              Send real invite emails instead of shareable links
            </p>
          </div>
        </li>
      </ul>
      <button
        type="button"
        onClick={onNext}
        className="mt-8 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-neutral-800"
      >
        Get started
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14M13 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}
