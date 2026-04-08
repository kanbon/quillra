import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { Input } from "@/components/atoms/Input";
import { apiJson } from "@/lib/api";
import { useT } from "@/i18n/i18n";

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
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 p-8">
        <Heading as="h1" className="mb-2 text-xl">
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
          <Button type="submit" disabled={isSubmitting}>
            {t("acceptInvite.join")}
          </Button>
        </form>
      </div>
    </div>
  );
}
