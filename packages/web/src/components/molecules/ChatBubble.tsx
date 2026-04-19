import { cn } from "@/lib/cn";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

type Props = {
  speaker: "user" | "assistant";
  children: string;
  streaming?: boolean;
};

const mdClass =
  "[&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_code]:rounded [&_code]:bg-neutral-100 [&_code]:px-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-neutral-100 [&_pre]:p-3 [&_a]:text-brand [&_br]:block [&_br]:content-[''] [&_br]:mt-1 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:font-bold [&_h3]:mt-2 [&_h3]:mb-1 [&_li]:mb-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-600";

export function ChatBubble({ speaker, children, streaming }: Props) {
  const isUser = speaker === "user";
  return (
    <div
      className={cn(
        "max-w-[min(100%,42rem)] rounded-2xl px-4 py-3 text-sm",
        isUser
          ? "ml-auto bg-neutral-100 text-neutral-900"
          : "mr-auto border border-neutral-200 bg-white text-neutral-800",
      )}
    >
      {isUser ? (
        <p className="whitespace-pre-wrap">{children}</p>
      ) : (
        <div className={cn(mdClass, streaming && "opacity-90")}>
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {children || (streaming ? "…" : "")}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
