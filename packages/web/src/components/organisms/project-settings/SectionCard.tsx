/**
 * Card shell used by every non-danger section on the Project
 * Settings page: a rounded white container with a muted header
 * (title + optional description) above the content slot.
 */

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-sm">
      <header className="border-b border-neutral-200/80 bg-neutral-50/50 px-6 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-neutral-900">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-neutral-500">{description}</p>}
      </header>
      <div className="p-6">{children}</div>
    </section>
  );
}
