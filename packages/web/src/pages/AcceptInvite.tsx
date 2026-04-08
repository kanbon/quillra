import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

const schema = z.object({
  token: z.string().min(10),
});

type Form = z.infer<typeof schema>;

export function AcceptInvitePage() {
  const { t } = useT();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const defaultToken = params.get("token") ?? "";

  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { token: defaultToken },
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-neutral-50 to-neutral-100 px-4">
      <div className="w-full max-w-md rounded-3xl border border-neutral-200/80 bg-white p-8 shadow-xl shadow-neutral-200/50">
        <Heading as="h1" className="mb-2 text-xl font-semibold tracking-tight">
          {t("acceptInvite.title")}
        </Heading>
        <p className="mb-6 text-sm text-neutral-600">
          {t("acceptInvite.help")}
        </p>
        <form
          onSubmit={handleSubmit(async (v) => {
            const res = await apiJson<{ projectId: string }>("/api/team/invites/accept", {
              method: "POST",
              body: JSON.stringify({ token: v.token }),
            });
            nav(`/p/${res.projectId}`, { replace: true });
          })}
          className="flex flex-col gap-3"
        >
          <Input {...register("token")} placeholder={t("acceptInvite.tokenPlaceholder")} />
          <button
            type="submit"
            disabled={isSubmitting}
            className={cn(
              "mt-1 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-neutral-900 text-[15px] font-semibold text-white shadow-sm transition-all",
              isSubmitting
                ? "cursor-not-allowed opacity-50"
                : "hover:bg-neutral-800 hover:shadow",
            )}
          >
            {isSubmitting ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                {t("acceptInvite.join")}
              </>
            ) : (
              t("acceptInvite.join")
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
