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
import { useNavigate } from "react-router-dom";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Input } from "@/components/atoms/Input";
import { LogoMark } from "@/components/atoms/LogoMark";

type StatusResponse = {
  needsSetup: boolean;
  missing: string[];
  values: Record<string, { set: boolean; source: "db" | "env" | "none"; value?: string }>;
};

type Step = "welcome" | "anthropic" | "github" | "email" | "organization" | "done";

const STEPS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "anthropic", label: "Anthropic" },
  { id: "github", label: "GitHub" },
  { id: "email", label: "Email" },
  { id: "organization", label: "Organisation" },
  { id: "done", label: "Done" },
];

export function SetupPage() {
  const nav = useNavigate();
  const [step, setStep] = useState<Step>("welcome");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [githubToken, setGithubToken] = useState("");
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
      setStep("github");
    } catch { /* stay on step */ }
  }

  async function handleGithubNext() {
    // GitHub token is optional — can be added later via settings
    try {
      await saveValues({ GITHUB_TOKEN: githubToken.trim() || null });
      setStep("email");
    } catch { /* stay on step */ }
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
      setStep("done");
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

          {step === "github" && (
            <div className="p-8">
              <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">GitHub access</h2>
              <p className="mt-2 text-sm text-neutral-500">
                Paste a token with the{" "}
                <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">repo</code> scope so Quillra can
                clone and push.{" "}
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=Quillra"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand underline-offset-2 hover:underline"
                >
                  Create one
                </a>
                .
              </p>
              <div className="mt-5">
                <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                  Personal access token (optional)
                </label>
                <Input
                  type="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_…"
                />
                <p className="mt-2 text-xs text-neutral-500">
                  You can skip this if each user's own GitHub OAuth session will cover access.
                </p>
              </div>
              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
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
                  onClick={handleGithubNext}
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
                  onClick={() => setStep("github")}
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

          {step === "done" && (
            <div className="p-8 text-center">
              <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-green-100 text-green-600">
                <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-[22px] font-semibold tracking-tight text-neutral-900">You're ready</h2>
              <p className="mt-2 text-sm text-neutral-500">
                Quillra is configured. Sign in with GitHub to create your first project.
              </p>
              <button
                type="button"
                onClick={() => nav("/login", { replace: true })}
                className="mt-8 inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-brand px-6 text-[15px] font-semibold text-white shadow-sm hover:bg-brand/90"
              >
                Continue to sign in
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
