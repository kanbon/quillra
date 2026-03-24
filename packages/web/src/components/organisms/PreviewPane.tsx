import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";

type Props = {
  src: string | null;
  onRefresh: () => void;
  starting?: boolean;
  engineLabel?: string;
};

export function PreviewPane({ src, onRefresh, starting, engineLabel }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-neutral-200 bg-neutral-50">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-3 py-2">
        <div>
          <Heading as="h3" className="text-base">
            Live preview
          </Heading>
          {engineLabel && (
            <p className="text-[11px] uppercase tracking-wide text-neutral-400">{engineLabel}</p>
          )}
        </div>
        <Button variant="outline" type="button" onClick={onRefresh} disabled={starting || !src}>
          Refresh
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {src ? (
          <iframe title="Site preview" src={src} className="h-full w-full border-0 bg-white" />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
            {starting ? "Installing dependencies and starting dev server…" : "Start preview when you are ready."}
          </div>
        )}
      </div>
    </div>
  );
}
