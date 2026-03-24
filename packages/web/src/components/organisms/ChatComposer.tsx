import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/atoms/Button";
import { Textarea } from "@/components/atoms/Textarea";

const schema = z.object({
  content: z.string().min(1, "Message required"),
});

type Form = z.infer<typeof schema>;

type Props = {
  onSend: (text: string) => void;
  disabled?: boolean;
};

export function ChatComposer({ onSend, disabled }: Props) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { content: "" } });

  return (
    <form
      className="flex flex-col gap-2 border-t border-neutral-200 bg-white p-3"
      onSubmit={handleSubmit((v) => {
        onSend(v.content.trim());
        reset();
      })}
    >
      <Textarea
        {...register("content")}
        placeholder="Ask Quillra to edit your site…"
        disabled={disabled}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleSubmit((v) => {
              onSend(v.content.trim());
              reset();
            })();
          }
        }}
      />
      {errors.content && <p className="text-xs text-red-600">{errors.content.message}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={disabled}>
          Send
        </Button>
      </div>
    </form>
  );
}
