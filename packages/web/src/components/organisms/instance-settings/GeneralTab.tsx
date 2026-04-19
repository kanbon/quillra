/**
 * Organization / Impressum identity, the publicly visible fields.
 * Mirror of the Setup wizard's "organization" step, but designed for
 * post-install rotation: one Save button, dirty tracking, loading state.
 */

import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StatusResponse } from "./types";

type OrgForm = {
  instanceName: string;
  operatorName: string;
  company: string;
  email: string;
  address: string;
  website: string;
};

function formFromStatus(status: StatusResponse | null): OrgForm {
  const v = status?.values;
  return {
    instanceName: v?.INSTANCE_NAME?.value ?? "Quillra",
    operatorName: v?.INSTANCE_OPERATOR_NAME?.value ?? "",
    company: v?.INSTANCE_OPERATOR_COMPANY?.value ?? "",
    email: v?.INSTANCE_OPERATOR_EMAIL?.value ?? "",
    address: v?.INSTANCE_OPERATOR_ADDRESS?.value ?? "",
    website: v?.INSTANCE_OPERATOR_WEBSITE?.value ?? "",
  };
}

type Props = {
  status: StatusResponse | null;
  onSaved: () => void;
};

export function GeneralTab({ status, onSaved }: Props) {
  const { t } = useT();
  const [form, setForm] = useState<OrgForm>(() => formFromStatus(status));
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Re-sync the form when the parent refetches status (e.g. after a save
  // elsewhere on the page, or on first load).
  useEffect(() => {
    if (status) setForm(formFromStatus(status));
  }, [status]);

  async function save() {
    setSaving(true);
    setFlash(null);
    try {
      await apiJson("/api/setup/save", {
        method: "POST",
        body: JSON.stringify({
          values: {
            INSTANCE_NAME: form.instanceName.trim() || null,
            INSTANCE_OPERATOR_NAME: form.operatorName.trim() || null,
            INSTANCE_OPERATOR_COMPANY: form.company.trim() || null,
            INSTANCE_OPERATOR_EMAIL: form.email.trim() || null,
            INSTANCE_OPERATOR_ADDRESS: form.address.trim() || null,
            INSTANCE_OPERATOR_WEBSITE: form.website.trim() || null,
          },
        }),
      });
      setFlash(t("instanceSettings.savedFlash"));
      onSaved();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
        {t("instanceSettings.tabGeneral")}
      </h2>

      <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-[12px] leading-relaxed text-amber-800">
        <strong className="font-semibold">{t("instanceSettings.publiclyVisible")}</strong>{" "}
        {t("instanceSettings.publiclyVisibleBody")}{" "}
        <Link to="/impressum" className="underline-offset-2 hover:underline">
          /impressum
        </Link>
      </div>

      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
            {t("instanceSettings.instanceNameLabel")}
          </label>
          <Input
            value={form.instanceName}
            onChange={(e) => setForm({ ...form, instanceName: e.target.value })}
            placeholder="Quillra"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
              {t("instanceSettings.operatorNameLabel")}
            </label>
            <Input
              value={form.operatorName}
              onChange={(e) => setForm({ ...form, operatorName: e.target.value })}
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
              {t("instanceSettings.companyLabel")}
            </label>
            <Input
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
              placeholder="Acme Studio GmbH"
            />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
            {t("instanceSettings.contactEmailLabel")}
          </label>
          <Input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="hello@yourdomain.com"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
            {t("instanceSettings.postalAddressLabel")}
          </label>
          <textarea
            rows={3}
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            placeholder={"Musterstraße 1\n1010 Vienna\nAustria"}
            className="block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-600">
            {t("instanceSettings.websiteLabel")}
          </label>
          <Input
            type="url"
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
            placeholder="https://yourdomain.com"
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Button type="button" onClick={save} disabled={saving}>
          {saving ? t("instanceSettings.saving") : t("instanceSettings.saveChanges")}
        </Button>
        {flash && <p className="text-sm text-neutral-500">{flash}</p>}
      </div>
    </div>
  );
}
