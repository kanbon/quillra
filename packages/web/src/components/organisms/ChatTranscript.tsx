import { ChatBubble } from "@/components/molecules/ChatBubble";
import { ToolEventRow } from "@/components/molecules/ToolEventRow";
import { Spinner } from "@/components/atoms/Spinner";
import type { ChatLine } from "@/hooks/useProjectChat";

type Props = {
  lines: ChatLine[];
  busy: boolean;
};

export function ChatTranscript({ lines, busy }: Props) {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-4">
      {lines.map((line) => {
        if (line.kind === "user") {
          return (
            <ChatBubble key={line.id} role="user">
              {line.text}
            </ChatBubble>
          );
        }
        if (line.kind === "tool") {
          return <ToolEventRow key={line.id} detail={line.detail} />;
        }
        return (
          <ChatBubble key={line.id} role="assistant" streaming={line.streaming}>
            {line.text}
          </ChatBubble>
        );
      })}
      {busy && (
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <Spinner />
          Thinking…
        </div>
      )}
    </div>
  );
}
