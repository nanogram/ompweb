import { RotateCw } from "lucide-react";

/** TUI-style effort circle, including a plain ring for provider-defined levels. */
export function ThinkingGlyph({ level }: { level: string }) {
  return (
    <span className="composer-thinking-glyph" data-level={level} aria-hidden="true">
      {level === "auto" ? <RotateCw strokeWidth={2} /> : null}
    </span>
  );
}
