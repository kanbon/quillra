import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { Textarea } from "@/components/atoms/Textarea";
import { apiJson } from "@/lib/api";

const schema = z.object({
  name: z.string().min(1, "Name required"),
  githubRepoFullName: z
    .string()
    .min(3)
    .regex(/^[\w.-]+\/[\w.-]+$/, "Format: owner/repo"),
  defaultBranch: z.string().min(1),
  previewDevCommand: z.string().max(2000).optional(),
});

type Form = z.infer<typeof schema>;

type Props = { onCreated: () => void };

export function ConnectProjectForm({ onCreated }: Props) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", githubRepoFullName: "", defaultBranch: "main", previewDevCommand: "" },
  });

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={handleSubmit(async (values) => {
        await apiJson("/api/projects", {
          method: "POST",
          body: JSON.stringify({
            ...values,
            previewDevCommand: values.previewDevCommand?.trim() || null,
          }),
        });
        reset();
        onCreated();
      })}
    >
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs font-medium text-neutral-600">Project name</label>
        <Input placeholder="Client homepage" {...register("name")} />
        {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
      </div>
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs font-medium text-neutral-600">GitHub repository</label>
        <Input placeholder="acme/astro-site" {...register("githubRepoFullName")} />
        {errors.githubRepoFullName && (
          <p className="mt-1 text-xs text-red-600">{errors.githubRepoFullName.message}</p>
        )}
      </div>
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs font-medium text-neutral-600">Branch</label>
        <Input {...register("defaultBranch")} />
      </div>
      <div className="sm:col-span-2">
        <label className="mb-1 block text-xs font-medium text-neutral-600">
          Dev preview command (optional)
        </label>
        <Textarea
          rows={2}
          placeholder={`Leave empty to auto-detect (Astro, Next.js, Vite, or npm/yarn run dev).\nCustom example: npx vite --host 0.0.0.0 --port {port}`}
          className="font-mono text-xs"
          {...register("previewDevCommand")}
        />
        <p className="mt-1 text-xs text-neutral-500">
          Use <code className="rounded bg-neutral-100 px-1">{`{port}`}</code> where the server should listen.
        </p>
      </div>
      <div className="flex items-end sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Connecting…" : "Connect repository"}
        </Button>
      </div>
    </form>
  );
}
