"use client";

import { useId, type ReactNode } from "react";
import { glossaryEntry, type GlossaryId } from "@/lib/aegis/glossary";

type Props = {
  id: GlossaryId;
  children?: ReactNode;
};

/**
 * Jargon word with a keyboard-reachable tooltip.
 * Hover, focus, or Enter/Space opens it. Escape closes it.
 */
export function Term({ id, children }: Props) {
  const entry = glossaryEntry(id);
  const tipId = useId();
  return (
    <span className="chrome-term">
      <button
        type="button"
        className="chrome-term-trigger"
        aria-describedby={tipId}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      >
        {children ?? entry.plain}
      </button>
      <span role="tooltip" id={tipId} className="chrome-tip">
        <strong>{entry.term}</strong>
        <span>{entry.detail}</span>
      </span>
    </span>
  );
}
