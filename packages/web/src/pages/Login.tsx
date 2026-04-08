import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { LogoMark } from "@/components/atoms/LogoMark";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/i18n";

export function LoginPage() {
  const { t } = useT();
  const nav = useNavigate();
  const { data, isPending } = authClient.useSession();

  useEffect(() => {
    if (data?.user) nav("/dashboard", { replace: true });
  }, [data?.user, nav]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200/80 bg-white p-8 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <LogoMark size={32} />
          <Heading as="h1" className="font-brand text-2xl font-bold">
            {t("login.appName")}
          </Heading>
        </div>
        <p className="mb-6 text-sm leading-relaxed text-neutral-600">
          {t("login.intro")}
        </p>
        <Button
          className="w-full"
          disabled={isPending}
          type="button"
          onClick={() =>
            authClient.signIn.social({
              provider: "github",
              callbackURL: `${window.location.origin}/dashboard`,
            })
          }
        >
          {t("login.continueWithGithub")}
        </Button>
      </div>
    </div>
  );
}
