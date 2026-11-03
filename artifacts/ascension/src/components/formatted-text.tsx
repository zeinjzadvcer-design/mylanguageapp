/**
 * Renders text a content manager typed into a plain textarea, keeping the
 * structure they gave it.
 *
 * The CMS has no rich-text editor, so authors write lists the way anyone does
 * in a text box — "- item", "• item", "1. item" — and separate paragraphs with
 * blank lines. Rendered as a single <p>, all of that collapsed: HTML folds the
 * newlines into spaces, so a five-item list reached the student as one run-on
 * sentence with dashes in it.
 *
 * Deliberately not Markdown. Authors were never told Markdown is supported, so
 * an asterisk or underscore in ordinary prose must stay a character rather than
 * silently turning into emphasis. Only the list markers above and line breaks
 * carry meaning.
 */
import type { ReactNode } from "react";

type Segment =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbered"; items: string[]; start: number };

const BULLET = /^\s*[-*•–·▪]\s+(.*)$/;
// Western and Arabic-Indic digits, followed by "." or ")" — "1." "2)" "١."
const NUMBERED = /^\s*([0-9٠-٩۰-۹]+)[.)٫]\s+(.*)$/;

function toNumber(digits: string): number {
  const western = digits.replace(/[٠-٩۰-۹]/g, (d) =>
    String((d.charCodeAt(0) & 0xf) % 10),
  );
  const n = parseInt(western, 10);
  return Number.isFinite(n) ? n : 1;
}

export function parseFormattedText(text: string): Segment[] {
  const segments: Segment[] = [];
  const push = (seg: Segment) => segments.push(seg);
  const last = () => segments[segments.length - 1];

  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.trim() === "") {
      // A blank line ends whatever was open; the next line starts afresh.
      const open = last();
      if (open && !(open.kind === "paragraph" && open.lines.length === 0)) {
        push({ kind: "paragraph", lines: [] });
      }
      continue;
    }

    const bullet = BULLET.exec(raw);
    const numbered = bullet ? null : NUMBERED.exec(raw);
    const prev = last();

    if (bullet) {
      if (prev?.kind === "bullets") prev.items.push(bullet[1]);
      else push({ kind: "bullets", items: [bullet[1]] });
    } else if (numbered) {
      if (prev?.kind === "numbered") prev.items.push(numbered[2]);
      else push({ kind: "numbered", items: [numbered[2]], start: toNumber(numbered[1]) });
    } else if (prev?.kind === "paragraph") {
      prev.lines.push(raw);
    } else if (prev && /^\s+/.test(raw)) {
      // An indented line under a list item continues that item.
      const items = prev.items;
      items[items.length - 1] += `\n${raw.trim()}`;
    } else {
      push({ kind: "paragraph", lines: [raw] });
    }
  }

  return segments.filter((s) => (s.kind === "paragraph" ? s.lines.length > 0 : true));
}

/** Keeps single line breaks inside a paragraph or list item. */
function withBreaks(text: string): ReactNode {
  const parts = text.split("\n");
  return parts.map((part, i) => (
    <span key={i}>
      {part}
      {i < parts.length - 1 && <br />}
    </span>
  ));
}

export function FormattedText({
  text,
  className = "",
  dir,
}: {
  text: string | null | undefined;
  className?: string;
  dir?: "rtl" | "ltr";
}) {
  if (!text || text.trim() === "") return null;
  const segments = parseFormattedText(text);

  // `ps-6` (padding-inline-start) puts the markers on the correct side for
  // both Arabic and English text.
  return (
    <div className={`space-y-3 ${className}`} dir={dir}>
      {segments.map((seg, i) => {
        if (seg.kind === "bullets") {
          return (
            <ul key={i} className="list-disc ps-6 space-y-1">
              {seg.items.map((item, j) => <li key={j}>{withBreaks(item)}</li>)}
            </ul>
          );
        }
        if (seg.kind === "numbered") {
          return (
            <ol key={i} start={seg.start} className="list-decimal ps-6 space-y-1">
              {seg.items.map((item, j) => <li key={j}>{withBreaks(item)}</li>)}
            </ol>
          );
        }
        return <p key={i}>{withBreaks(seg.lines.join("\n"))}</p>;
      })}
    </div>
  );
}
