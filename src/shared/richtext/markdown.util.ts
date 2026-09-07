/**
 * A minimal Markdown -> HTML renderer for `legal_documents.body` (and any
 * other admin-authored Markdown this codebase later serves as a public
 * page). No dependency on a Markdown library and no HTML sanitiser — safety
 * comes from ORDERING, not from a denylist:
 *
 * *** THE WHOLE INPUT IS HTML-ESCAPED FIRST, BEFORE A SINGLE MARKDOWN
 * CONSTRUCT IS INTERPRETED. *** Every subsequent regex runs against text
 * that can no longer contain a literal `<`, `>`, `&`, `"` or `'` — so even a
 * construct this renderer parses wrong can only ever produce more inert
 * text, never a real tag. `<script>alert(1)</script>` becomes the
 * *characters* `&lt;script&gt;...`, is never treated as markup, and is
 * rendered back to the browser as visible text, not executed.
 *
 * Supports: `#`..`######` headings, `**bold**`, `*italic*`, `` `code` ``,
 * `- `/`* ` unordered lists, `1. ` ordered lists, `> ` blockquotes, a lone
 * `---` as `<hr>`, blank-line-separated paragraphs, and `[text](url)` links
 * — the last gated by a SCHEME ALLOWLIST (`http`, `https`, `mailto`); any
 * other scheme (`javascript:`, `data:`, a bare `//`) renders as the escaped
 * literal text with no `<a>` at all, never a clickable target.
 *
 * Anything not on this list — raw HTML, tables, nested lists, footnotes —
 * renders as literal (escaped) text. That is a deliberate, small surface:
 * legal copy is prose, not application UI.
 */

const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'];

/** Exported for callers embedding an untrusted plain string (a title, a version) into a hand-built HTML page, same reasoning as everything else in this file. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** `null` when the scheme is not on the allowlist, or the string is not a parseable URL at all (a relative link has no scheme to check, so it is refused too — legal copy has no reason to link relatively). */
function safeLinkHref(rawUrl: string): string | null {
  // `rawUrl` has already been through `escapeHtml` as part of the whole
  // document — decode the handful of entities a URL could legitimately
  // contain before handing it to `URL`, so `&amp;` in a query string still
  // parses as `&`.
  const decoded = rawUrl.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  try {
    const url = new URL(decoded);
    return ALLOWED_LINK_SCHEMES.includes(url.protocol) ? escapeHtml(url.toString()) : null;
  } catch {
    return null;
  }
}

/** Bold, italic, inline code and links — applied to already-escaped text. Order matters: links first (so `**` inside link text still nests), then bold, then italic, then code. */
function renderInline(escapedText: string): string {
  let result = escapedText.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (match, text: string, url: string) => {
    const href = safeLinkHref(url);
    return href ? `<a href="${href}" rel="noopener noreferrer" target="_blank">${text}</a>` : match;
  });

  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  result = result.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  return result;
}

interface Block {
  kind: 'heading' | 'hr' | 'blockquote' | 'ul' | 'ol' | 'paragraph';
  level?: number;
  lines: string[];
}

function groupIntoBlocks(escapedLines: string[]): Block[] {
  const blocks: Block[] = [];
  // A blank line always ends whatever block is open — without this, two
  // paragraphs separated by a blank line would merge into one, since
  // "same kind as the previous block" would otherwise be the only test.
  let atBoundary = true;

  for (const line of escapedLines) {
    if (line.trim() === '') {
      atBoundary = true;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, lines: [heading[2]] });
      atBoundary = false;
      continue;
    }

    if (line.trim() === '---') {
      blocks.push({ kind: 'hr', lines: [] });
      atBoundary = false;
      continue;
    }

    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      const previous = blocks.at(-1);
      if (!atBoundary && previous?.kind === 'blockquote') previous.lines.push(quote[1]);
      else blocks.push({ kind: 'blockquote', lines: [quote[1]] });
      atBoundary = false;
      continue;
    }

    const unordered = /^[-*]\s+(.*)$/.exec(line);
    if (unordered) {
      const previous = blocks.at(-1);
      if (!atBoundary && previous?.kind === 'ul') previous.lines.push(unordered[1]);
      else blocks.push({ kind: 'ul', lines: [unordered[1]] });
      atBoundary = false;
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      const previous = blocks.at(-1);
      if (!atBoundary && previous?.kind === 'ol') previous.lines.push(ordered[1]);
      else blocks.push({ kind: 'ol', lines: [ordered[1]] });
      atBoundary = false;
      continue;
    }

    const previous = blocks.at(-1);
    if (!atBoundary && previous?.kind === 'paragraph') previous.lines.push(line);
    else blocks.push({ kind: 'paragraph', lines: [line] });
    atBoundary = false;
  }

  return blocks;
}

function renderBlock(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return `<h${block.level}>${renderInline(block.lines[0] ?? '')}</h${block.level}>`;
    case 'hr':
      return '<hr>';
    case 'blockquote':
      return `<blockquote><p>${block.lines.map(renderInline).join(' ')}</p></blockquote>`;
    case 'ul':
      return `<ul>${block.lines.map((line) => `<li>${renderInline(line)}</li>`).join('')}</ul>`;
    case 'ol':
      return `<ol>${block.lines.map((line) => `<li>${renderInline(line)}</li>`).join('')}</ol>`;
    case 'paragraph':
      return `<p>${block.lines.map(renderInline).join(' ')}</p>`;
  }
}

export function renderMarkdownToHtml(markdown: string): string {
  const escaped = escapeHtml(markdown);
  const blocks = groupIntoBlocks(escaped.split(/\r?\n/));
  return blocks.map(renderBlock).join('\n');
}

/** For `content_format = 'plain_text'` — escaped, line breaks preserved, no markdown constructs applied at all. */
export function renderPlainTextToHtml(text: string): string {
  return `<p>${escapeHtml(text).split(/\r?\n\r?\n/).map((para) => para.split(/\r?\n/).join('<br>')).join('</p>\n<p>')}</p>`;
}
