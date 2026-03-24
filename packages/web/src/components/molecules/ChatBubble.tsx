import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

type Props = {
  role: "user" | "assistant";
  children: string;
  streaming?: boolean;
};

const mdClass =
  "[&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_code]:rounded [&_code]:bg-neutral-100 [&_code]:px-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-neutral-100 [&_pre]:p-3 [&_a]:text-brand";

export function ChatBubble({ role, children, streaming }: Props) {
  const isUser = role === "user";
  return (
    <div
      className={cn(
        "max-w-[min(100%,42rem)] rounded-2xl px-4 py-3 text-sm",
        isUser ? "ml-auto bg-neutral-100 text-neutral-900" : "mr-auto border border-neutral-200 bg-white text-neutral-800",
      )}
    >
      {isUser ? (
        <p className="whitespace-pre-wrap">{children}</p>
      ) : (
        <div className={cn(mdClass, streaming && "opacity-90")}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || (streaming ? "…" : "")}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
