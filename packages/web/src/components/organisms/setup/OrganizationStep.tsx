import { Input } from "@/components/atoms/Input";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

/**
 * Organization step: collects the operator's name, company, contact
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
  const { t } = useT();

  return (
    <form
      className="p-5 sm:p-8"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <h2
        id="setup-step-heading-organization"
        tabIndex={-1}
        className="text-[20px] font-semibold tracking-tight text-neutral-900 outline-none"
      >
        {t("setup.organization.title")}
      </h2>
      <p className="mt-2 text-sm text-neutral-500">
        {t("setup.organization.introBeforePath")}{" "}
        <code className="rounded bg-neutral-100 px-1 font-mono text-[11px]">/impressum</code>{" "}
        {t("setup.organization.introAfterPath")}
      </p>
      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-[12px] leading-relaxed text-amber-800">
        <strong className="font-semibold">{t("setup.organization.publicTitle")}</strong>{" "}
        {t("setup.organization.publicBodyBeforePath")}{" "}
        <code className="rounded bg-amber-100 px-1 font-mono">/impressum</code>{" "}
        {t("setup.organization.publicBodyAfterPath")}
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <label
            htmlFor="setup-instance-name"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("instanceSettings.instanceNameLabel")}
          </label>
          <Input
            id="setup-instance-name"
            value={org.instanceName}
            onChange={(e) => onOrgChange({ ...org, instanceName: e.target.value })}
            placeholder="Quillra"
            disabled={saving}
          />
          <p className="mt-1 text-[11px] text-neutral-500">
            {t("setup.organization.instanceNameHelp")}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="setup-operator-name"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
            >
              {t("instanceSettings.operatorNameLabel")} <span className="text-red-500">*</span>
            </label>
            <Input
              id="setup-operator-name"
              autoComplete="name"
              required
              value={org.operatorName}
              onChange={(e) => onOrgChange({ ...org, operatorName: e.target.value })}
              placeholder={t("setup.organization.operatorNamePlaceholder")}
              disabled={saving}
            />
          </div>
          <div>
            <label
              htmlFor="setup-operator-company"
              className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
            >
              {t("instanceSettings.companyLabel")}
            </label>
            <Input
              id="setup-operator-company"
              autoComplete="organization"
              value={org.company}
              onChange={(e) => onOrgChange({ ...org, company: e.target.value })}
              placeholder={t("setup.organization.companyPlaceholder")}
              disabled={saving}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="setup-operator-email"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("instanceSettings.contactEmailLabel")}
          </label>
          <Input
            id="setup-operator-email"
            type="email"
            autoComplete="email"
            value={org.email}
            onChange={(e) => onOrgChange({ ...org, email: e.target.value })}
            placeholder={t("setup.organization.contactEmailPlaceholder")}
            disabled={saving}
          />
        </div>

        <div>
          <label
            htmlFor="setup-operator-address"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("instanceSettings.postalAddressLabel")}
          </label>
          <textarea
            id="setup-operator-address"
            rows={3}
            autoComplete="street-address"
            value={org.address}
            onChange={(e) => onOrgChange({ ...org, address: e.target.value })}
            placeholder={t("setup.organization.addressPlaceholder")}
            disabled={saving}
            className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
          />
        </div>

        <div>
          <label
            htmlFor="setup-operator-website"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("instanceSettings.websiteLabel")}
          </label>
          <Input
            id="setup-operator-website"
            type="url"
            autoComplete="url"
            value={org.website}
            onChange={(e) => onOrgChange({ ...org, website: e.target.value })}
            placeholder={t("setup.organization.websitePlaceholder")}
            disabled={saving}
          />
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900 disabled:cursor-wait disabled:opacity-50"
        >
          {t("common.back")}
        </button>
        <button
          type="submit"
          disabled={saving || !org.operatorName.trim()}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-lg bg-neutral-900 px-5 text-[13px] font-semibold text-white shadow-sm",
            saving || !org.operatorName.trim()
              ? "cursor-not-allowed opacity-50"
              : "hover:bg-neutral-800",
          )}
        >
          {saving ? t("common.saving") : t("common.continue")}
        </button>
      </div>
    </form>
  );
}
