/**
 * First-run instance setup wizard.
 *
 * Walks a fresh install through the values Quillra needs to actually
 * function: Anthropic key, GitHub token, and optional email delivery.
 *
 * Routes-level guard: any time /api/setup/status says needsSetup is
 * true, the rest of the app bounces users here (see App.tsx).
 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiJson } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { Input } from "@/components/atoms/Input";
import { LogoMark } from "@/components/atoms/LogoMark";
import { clearSetupGateCache } from "@/components/templates/SetupGate";

type StatusResponse = {
  needsSetup: boolean;
  needsOwner: boolean;
  missing: string[];
  values: Record<string, { set: boolean; source: "db" | "env" | "none"; value?: string }>;
};

type Step = "welcome" | "anthropic" | "githubApp" | "email" | "organization" | "signin";

const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "anthropic", label: "Anthropic" },
  { id: "githubApp", label: "GitHub App" },
  { id: "email", label: "Email" },
  { id: "organization", label: "Organisation" },
  { id: "signin", label: "Sign in" },
];

export function SetupPage() {
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<Step>("welcome");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [emailProvider, setEmailProvider] = useState<"none" | "resend" | "smtp">("none");
  const [emailFrom, setEmailFrom] = useState("Quillra <hello@quillra.com>");
  const [resendKey, setResendKey] = useState("");
  const [smtp, setSmtp] = useState({ host: "", port: "587", user: "", password: "", secure: "false" });
  const [org, setOrg] = useState({
    instanceName: "Quillra",
    operatorName: "",
    company: "",
    email: "",
    address: "",
    website: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Honor deep links from the GitHub App manifest callback. When the
  // backend persists the credentials it redirects to
  //   /setup?step=githubApp&created=1&installUrl=...
  // and the installation page on github.com redirects back here with
  //   /setup?step=githubApp&installed=1&installation_id=...
  // In both cases we jump straight to the GitHub App step instead of
  // starting over at "welcome".
  useEffect(() => {
    const deepStep = searchParams.get("step");
    if (deepStep === "githubApp") setStep("githubApp");
  }, [searchParams]);

  // Load status on mount
  useEffect(() => {
    (async () => {
      try {
        const s = await apiJson<StatusResponse>("/api/setup/status");
        setStatus(s);
        if (!s.needsSetup) {
          // Already configured — nothing to do here
          nav("/dashboard", { replace: true });
        }
      } catch { /* ignore */ }
    })();
  }, [nav]);

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  async function saveValues(values: Record<string, string | null>) {
    setSaving(true);
    setError(null);
    try {
      await apiJson("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({ values }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
      throw e;
    } finally {
      setSaving(false);
    }
  }

  async function handleAnthropicNext() {
    if (!anthropicKey.trim()) return;
    try {
      await saveValues({ ANTHROPIC_API_KEY: anthropicKey.trim() });
      setStep("githubApp");
    } catch { /* stay on step */ }
  }

  // The GitHub App step has no "next" handler that saves fields — the
  // creation flow hands off to GitHub and back, persisting credentials
  // server-side. This button just advances past the step.
  function handleGithubAppNext() {
    setStep("email");
  }

  async function handleEmailNext() {
    const values: Record<string, string | null> = {
      EMAIL_PROVIDER: emailProvider,
      EMAIL_FROM: emailFrom.trim() || null,
    };
    if (emailProvider === "resend") {
      values.RESEND_API_KEY = resendKey.trim() || null;
    } else if (emailProvider === "smtp") {
      values.SMTP_HOST = smtp.host.trim() || null;
      values.SMTP_PORT = smtp.port.trim() || null;
      values.SMTP_USER = smtp.user.trim() || null;
      values.SMTP_PASSWORD = smtp.password.trim() || null;
      values.SMTP_SECURE = smtp.secure;
    } else {
      values.RESEND_API_KEY = null;
      values.SMTP_HOST = null;
    }
    try {
      await saveValues(values);
      setStep("organization");
    } catch { /* stay on step */ }
  }

  async function handleOrganizationNext() {
    const values: Record<string, string | null> = {
      INSTANCE_NAME: org.instanceName.trim() || null,
      INSTANCE_OPERATOR_NAME: org.operatorName.trim() || null,
      INSTANCE_OPERATOR_COMPANY: org.company.trim() || null,
      INSTANCE_OPERATOR_EMAIL: org.email.trim() || null,
      INSTANCE_OPERATOR_ADDRESS: org.address.trim() || null,
      INSTANCE_OPERATOR_WEBSITE: org.website.trim() || null,
    };
    try {
      await saveValues(values);
      setStep("signin");
    } catch { /* stay on step */ }
  }

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-neutral-50 to-neutral-100">
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-14">
        <div className="mb-10 flex items-center gap-3">
          <LogoMark size={28} />
          <span className="font-brand text-xl font-bold tracking-tight">Quillra</span>
          <span className="ml-auto text-[11px] font-medium uppercase tracking-wider text-neutral-400">Setup</span>
        </div>

        {/* Step indicator */}
        <div className="mb-8 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex flex-1 items-center gap-2">
              <div
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
                  i < stepIndex
                    ? "bg-green-500 text-white"
                    : i === stepIndex
                      ? "bg-neutral-900 text-white"
                      : "bg-neutral-100 text-neutral-400",
                )}
              >
                {i < stepIndex ? (
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  i + 1
                )}
              </div>
              {i < STEPS.length - 1 && <div className={cn("h-px flex-1", i < stepIndex ? "bg-green-400" : "bg-neutral-200")} />}
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-3xl border border-neutral-200/80 bg-white shadow-sm">
          {step === "welcome" && (
            <div className="p-8">
              <h1 className="text-[22px] font-semibold tracking-tight text-neutral-900">Welcome to Quillra</h1>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                Let's get this instance configured. You'll need an Anthropic API key for the AI editor and a
                GitHub token so Quillra can clone and push to your repositories. Email delivery is optional.
              </p>
              <div className="mt-6 space-y-3 text-sm text-neutral-600">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-[10px] font-bold text-brand">1</div>
                  <span>Anthropic API key — powers the chat-based editor</span>
                </div>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-[10px] font-bold text-brand">2</div>
                  <span>GitHub access token — clone, read, and push to your repos</span>
                </div>
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand/10 text-[10px] font-bold text-brand">3</div>
                  <span>Email delivery (optional) — send real invite emails</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setStep("anthropic")}
                className="mt-8 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 text-[15px] font-semibold text-white shadow-sm transition-all hover:bg-neutral-800"
              >
                Get started
              </button>
            </div>
          )}

          {step === "anthropic" && (
            <div className="p-8">
              <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">Anthropic API key</h2>
              <p className="mt-2 text-sm text-neutral-500">
                Quillra uses Claude to edit your site. Paste your API key below —
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 text-brand underline-offset-2 hover:underline"
                >
                  get one here
                </a>
                .
              </p>
              <div className="mt-5">
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">API key</label>
                <Input
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder="sk-ant-api03-…"
                  autoFocus
                />
                {status.values.ANTHROPIC_API_KEY.set && status.values.ANTHROPIC_API_KEY.source === "env" && (
                  <p className="mt-2 text-xs text-neutral-500">
                    A key is already set in the environment. You can leave this blank to keep it.
                  </p>
                )}
              </div>
              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
              <div className="mt-6 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep("welcome")}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleAnthropicNext}
                  disabled={saving || !anthropicKey.trim()}
                  className={cn(
                    "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm",
                    saving || !anthropicKey.trim() ? "cursor-not-allowed opacity-50" : "hover:bg-brand/90",
                  )}
                >
                  {saving ? "Saving…" : "Continue"}
                </button>
              </div>
            </div>
          )}

          {step === "githubApp" && (() => {
            const appConfigured = Boolean(
              status?.values.GITHUB_APP_ID?.set && status?.values.GITHUB_APP_PRIVATE_KEY?.set,
            );
            const appName = status?.values.GITHUB_APP_NAME?.value;
            // `installed=1` arrives from /api/setup/github-app/installed
            // after github.com bounces the user back from the install
            // screen. `installation_id` is the numeric id GitHub sends.
            const justInstalled = searchParams.get("installed") === "1";
            const installationId = searchParams.get("installation_id");
            return (
              <div className="p-8">
                <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">GitHub App</h2>
                <p className="mt-2 text-sm leading-relaxed text-neutral-500">
                  Quillra pushes commits through its own GitHub App — no personal access
                  tokens, installation tokens rotate automatically every hour, and you can
                  revoke everything in one click from github.com.
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
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.575.105.785-.25.785-.555 0-.275-.01-1-.015-1.965-3.2.695-3.875-1.54-3.875-1.54-.525-1.33-1.28-1.685-1.28-1.685-1.045-.715.08-.7.08-.7 1.155.08 1.765 1.185 1.765 1.185 1.03 1.765 2.7 1.255 3.36.96.105-.745.4-1.255.73-1.545-2.555-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.29 1.185-3.095-.12-.29-.515-1.465.11-3.055 0 0 .965-.31 3.165 1.18a10.98 10.98 0 0 1 2.88-.385c.98.005 1.97.13 2.88.385 2.195-1.49 3.16-1.18 3.16-1.18.625 1.59.23 2.765.115 3.055.735.805 1.18 1.835 1.18 3.095 0 4.43-2.69 5.405-5.255 5.69.41.355.78 1.055.78 2.125 0 1.535-.015 2.77-.015 3.15 0 .31.205.665.79.555A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
                      </svg>
                      Create &amp; install GitHub App
                    </a>
                    <p className="mt-4 text-[11px] leading-snug text-neutral-400">
                      Already have an App? Set <code className="rounded bg-neutral-100 px-1 font-mono">GITHUB_APP_ID</code> and{" "}
                      <code className="rounded bg-neutral-100 px-1 font-mono">GITHUB_APP_PRIVATE_KEY</code> as environment variables and skip this step.
                    </p>
                    <div className="mt-6">
                      <button
                        type="button"
                        onClick={() => setStep("anthropic")}
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
                        <svg className="mt-0.5 h-5 w-5 shrink-0 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        <div>
                          <p className="text-sm font-semibold text-green-900">
                            {justInstalled ? "App installed." : "App configured."}
                          </p>
                          <p className="mt-0.5 text-[12px] leading-snug text-green-800">
                            {appName ? <><span className="font-mono">{appName}</span>{" "}</> : null}
                            {installationId ? (
                              <>Installation <span className="font-mono">#{installationId}</span> is active.</>
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
                        onClick={() => setStep("anthropic")}
                        className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={handleGithubAppNext}
                        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm hover:bg-brand/90"
                      >
                        Continue
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {step === "email" && (
            <div className="p-8">
              <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">Email delivery</h2>
              <p className="mt-2 text-sm text-neutral-500">
                Real emails for invites and client logins. You can change this later in settings.
              </p>
              <div className="mt-5 grid gap-2">
                {(["none", "resend", "smtp"] as const).map((p) => (
                  <label
                    key={p}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
                      emailProvider === p
                        ? "border-brand bg-brand/5"
                        : "border-neutral-200 bg-white hover:bg-neutral-50",
                    )}
                  >
                    <input
                      type="radio"
                      checked={emailProvider === p}
                      onChange={() => setEmailProvider(p)}
                      className="mt-1 accent-brand"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-neutral-900">
                        {p === "none" ? "Disabled" : p === "resend" ? "Resend" : "SMTP"}
                      </p>
                      <p className="mt-0.5 text-[12px] leading-snug text-neutral-500">
                        {p === "none"
                          ? "Skip for now. Invites become shareable links you copy and send yourself."
                          : p === "resend"
                            ? "Cloud email via Resend. Paste an API key from resend.com."
                            : "Universal SMTP. Works with Gmail, Postfix, SendGrid SMTP, AWS SES, Postmark, etc."}
                      </p>
                    </div>
                  </label>
                ))}
              </div>

              {emailProvider !== "none" && (
                <div className="mt-5 space-y-3">
                  <div>
                    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                      From address
                    </label>
                    <Input
                      value={emailFrom}
                      onChange={(e) => setEmailFrom(e.target.value)}
                      placeholder="Your Name <you@example.com>"
                    />
                  </div>
                  {emailProvider === "resend" && (
                    <div>
                      <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                        Resend API key
                      </label>
                      <Input
                        type="password"
                        value={resendKey}
                        onChange={(e) => setResendKey(e.target.value)}
                        placeholder="re_…"
                      />
                    </div>
                  )}
                  {emailProvider === "smtp" && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                          Host
                        </label>
                        <Input
                          value={smtp.host}
                          onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
                          placeholder="smtp.example.com"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                          Port
                        </label>
                        <Input
                          value={smtp.port}
                          onChange={(e) => setSmtp({ ...smtp, port: e.target.value })}
                          placeholder="587"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                          Secure (TLS)
                        </label>
                        <select
                          className="block h-[42px] w-full rounded-md border border-neutral-300 bg-white px-3 text-sm"
                          value={smtp.secure}
                          onChange={(e) => setSmtp({ ...smtp, secure: e.target.value })}
                        >
                          <option value="false">STARTTLS (587)</option>
                          <option value="true">SSL/TLS (465)</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                          User
                        </label>
                        <Input
                          value={smtp.user}
                          onChange={(e) => setSmtp({ ...smtp, user: e.target.value })}
                          placeholder="apikey or username"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                          Password
                        </label>
                        <Input
                          type="password"
                          value={smtp.password}
                          onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
                          placeholder="••••••••"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
              <div className="mt-6 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep("githubApp")}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleEmailNext}
                  disabled={saving}
                  className={cn(
                    "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm",
                    saving ? "cursor-not-allowed opacity-50" : "hover:bg-brand/90",
                  )}
                >
                  {saving ? "Saving…" : "Continue"}
                </button>
              </div>
            </div>
          )}

          {step === "organization" && (
            <div className="p-8">
              <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">Who's running this instance?</h2>
              <p className="mt-2 text-sm text-neutral-500">
                Contact details for whoever operates this Quillra install. Used in email footers, the
                branded client login page, and the public <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">/impressum</code> page.
              </p>
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-[12px] leading-relaxed text-amber-800">
                <strong className="font-semibold">Publicly visible.</strong> These values appear at the bottom of every email Quillra sends and on the
                public <code className="rounded bg-amber-100 px-1 font-mono">/impressum</code> page of this instance. In Germany and Austria a commercial website operator is
                required by law to provide these details, and modern spam filters (Gmail, Outlook) expect a real
                sender identity to deliver email to the inbox.
              </div>

              <div className="mt-5 space-y-4">
                <div>
                  <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                    Instance name
                  </label>
                  <Input
                    value={org.instanceName}
                    onChange={(e) => setOrg({ ...org, instanceName: e.target.value })}
                    placeholder="Quillra"
                  />
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Shown under "Powered by" on the client login page and in email footers. Defaults to "Quillra".
                  </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                      Your name <span className="text-red-500">*</span>
                    </label>
                    <Input
                      value={org.operatorName}
                      onChange={(e) => setOrg({ ...org, operatorName: e.target.value })}
                      placeholder="Jane Doe"
                    />
                  </div>
                  <div>
                    <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                      Company
                    </label>
                    <Input
                      value={org.company}
                      onChange={(e) => setOrg({ ...org, company: e.target.value })}
                      placeholder="Acme Studio GmbH"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                    Contact email
                  </label>
                  <Input
                    type="email"
                    value={org.email}
                    onChange={(e) => setOrg({ ...org, email: e.target.value })}
                    placeholder="hello@yourdomain.com"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                    Postal address
                  </label>
                  <textarea
                    rows={3}
                    value={org.address}
                    onChange={(e) => setOrg({ ...org, address: e.target.value })}
                    placeholder={"Musterstraße 1\n1010 Vienna\nAustria"}
                    className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                    Website
                  </label>
                  <Input
                    type="url"
                    value={org.website}
                    onChange={(e) => setOrg({ ...org, website: e.target.value })}
                    placeholder="https://yourdomain.com"
                  />
                </div>
              </div>

              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

              <div className="mt-6 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep("email")}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={handleOrganizationNext}
                  disabled={saving}
                  className={cn(
                    "inline-flex h-10 items-center gap-1.5 rounded-lg bg-neutral-900 px-5 text-[13px] font-semibold text-white shadow-sm",
                    saving ? "cursor-not-allowed opacity-50" : "hover:bg-neutral-800",
                  )}
                >
                  {saving ? "Saving…" : "Continue"}
                </button>
              </div>
            </div>
          )}

          {step === "signin" && (
            <div className="p-8 text-center">
              <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-green-100 text-green-600">
                <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-[22px] font-semibold tracking-tight text-neutral-900">Create your owner account</h2>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">
                Sign in with GitHub now to become the instance owner. Everyone you invite
                later can sign in with just their email.
              </p>
              {/* GitHub brand-compliant sign-in button — follows GitHub's
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
                GitHub is only required for you, the owner. You'll be able to push to your
                repos from Quillra right after this.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
