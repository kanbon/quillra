/**
 * Public legal disclosure ("Impressum") page.
 *
 * Shows whoever is operating this Quillra instance — required by law in
 * DE/AT for commercial websites, expected as a baseline by most EU hosts,
 * and referenced from the email footer. Completely static, fetches the
 * org info via the unauthenticated /api/instance/organization endpoint.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LogoMark } from "@/components/atoms/LogoMark";
import { apiJson } from "@/lib/api";

type Organization = {
  instanceName: string;
  operatorName: string | null;
  company: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
};

export function ImpressumPage() {
  const [org, setOrg] = useState<Organization | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const o = await apiJson<Organization>("/api/instance/organization");
        setOrg(o);
      } catch {
        setOrg({
          instanceName: "Quillra",
          operatorName: null,
          company: null,
          email: null,
          address: null,
          website: null,
        });
      }
    })();
  }, []);

  if (!org) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
      </div>
    );
  }

  const nothingSet =
    !org.operatorName && !org.company && !org.email && !org.address && !org.website;

  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-50 to-neutral-100">
      <header className="flex h-14 shrink-0 items-center border-b border-neutral-200 bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-6">
          <Link to="/" className="flex items-center gap-2 no-underline">
            <LogoMark size={22} />
            <span className="font-brand text-lg font-bold text-neutral-900">{org.instanceName}</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="mb-2 text-3xl font-semibold tracking-tight text-neutral-900">Impressum</h1>
        <p className="mb-10 text-sm text-neutral-500">
          Legal information about whoever operates this instance.
        </p>

        {nothingSet ? (
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-center">
            <p className="text-sm text-neutral-500">
              The operator of this Quillra instance hasn't set up their contact details yet.
            </p>
            <p className="mt-2 text-xs text-neutral-400">
              If you're the admin, visit{" "}
              <Link to="/admin" className="text-neutral-700 underline-offset-2 hover:underline">
                Instance Settings → Organisation
              </Link>{" "}
              to fill them in.
            </p>
          </div>
        ) : (
          <div className="space-y-6 rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
            {(org.company || org.operatorName) && (
              <section>
                <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Operator
                </h2>
                {org.company && (
                  <p className="text-[15px] font-semibold text-neutral-900">{org.company}</p>
                )}
                {org.operatorName && (
                  <p className="text-[14px] text-neutral-700">{org.operatorName}</p>
                )}
              </section>
            )}

            {org.address && (
              <section>
                <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Address
                </h2>
                <p className="whitespace-pre-line text-[14px] leading-relaxed text-neutral-700">{org.address}</p>
              </section>
            )}

            {(org.email || org.website) && (
              <section>
                <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Contact
                </h2>
                {org.email && (
                  <p className="text-[14px]">
                    <a
                      href={`mailto:${org.email}`}
                      className="text-neutral-700 underline-offset-2 hover:underline"
                    >
                      {org.email}
                    </a>
                  </p>
                )}
                {org.website && (
                  <p className="text-[14px]">
                    <a
                      href={org.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-neutral-700 underline-offset-2 hover:underline"
                    >
                      {org.website.replace(/^https?:\/\//, "")}
                    </a>
                  </p>
                )}
              </section>
            )}

            <section className="border-t border-neutral-100 pt-4">
              <p className="text-[11px] text-neutral-400">
                Hosted with <Link to="/" className="underline-offset-2 hover:underline">Quillra</Link> — a
                GitHub-native CMS for client-ready websites.
              </p>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
