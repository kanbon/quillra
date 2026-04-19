import { Input } from "@/components/atoms/Input";
import { cn } from "@/lib/cn";

/**
 * Organisation step: collects the operator's name, company, contact
 * email, postal address, website, and the instance display name. These
 * populate email footers, the branded client login, and the public
 * /impressum page required by AT/DE law for commercial operators.
 */

export type OrgFields = {
  instanceName: string;
  operatorName: string;
  company: string;
  email: string;
  address: string;
  website: string;
};

export function OrganizationStep({
  org,
  onOrgChange,
  onBack,
  onNext,
  saving,
  error,
}: {
  org: OrgFields;
  onOrgChange: (o: OrgFields) => void;
  onBack: () => void;
  onNext: () => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <div className="p-8">
      <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">
        Who's running this instance?
      </h2>
      <p className="mt-2 text-sm text-neutral-500">
        Contact details for whoever operates this Quillra install. Used in email footers,
        the branded client login page, and the public{" "}
        <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">
          /impressum
        </code>{" "}
        page.
      </p>
      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-[12px] leading-relaxed text-amber-800">
        <strong className="font-semibold">Publicly visible.</strong> These values appear at
        the bottom of every email Quillra sends and on the public{" "}
        <code className="rounded bg-amber-100 px-1 font-mono">/impressum</code> page of this
        instance. In Germany and Austria a commercial website operator is required by law to
        provide these details, and modern spam filters (Gmail, Outlook) expect a real sender
        identity to deliver email to the inbox.
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
            Instance name
          </label>
          <Input
            value={org.instanceName}
            onChange={(e) => onOrgChange({ ...org, instanceName: e.target.value })}
            placeholder="Quillra"
          />
          <p className="mt-1 text-[11px] text-neutral-500">
            Shown under "Powered by" on the client login page and in email footers. Defaults
            to "Quillra".
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
              Your name <span className="text-red-500">*</span>
            </label>
            <Input
              value={org.operatorName}
              onChange={(e) => onOrgChange({ ...org, operatorName: e.target.value })}
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
              Company
            </label>
            <Input
              value={org.company}
              onChange={(e) => onOrgChange({ ...org, company: e.target.value })}
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
            onChange={(e) => onOrgChange({ ...org, email: e.target.value })}
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
            onChange={(e) => onOrgChange({ ...org, address: e.target.value })}
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
            onChange={(e) => onOrgChange({ ...org, website: e.target.value })}
            placeholder="https://yourdomain.com"
          />
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

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
  );
}
