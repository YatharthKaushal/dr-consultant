import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LEGAL_AUDIENCES, type LegalAudience } from '../../schema/enums.schema';
import { Public } from '../../shared/auth/auth.decorator';
import { escapeHtml, renderMarkdownToHtml, renderPlainTextToHtml } from '../../shared/richtext/markdown.util';
import { LegalDocumentService, parseLegalDocumentType } from './legal-document.service';

function parseAudience(value: string | undefined): LegalAudience {
  if (value === undefined) return 'all';
  const match = LEGAL_AUDIENCES.find((audience) => audience === value);
  return match ?? 'all';
}

/**
 * *** THE ONE TOKENLESS SURFACE THIS MODULE HAS FOR READING LEGAL COPY. ***
 * Same posture `carehub-share.controller.ts`/`promotion-link.controller.ts`
 * document for their own public routes: NO class-level `@AccountType`, so
 * `AccountTypeGuard` never has a reason to look for `request.auth` at all.
 *
 * `legal-document.controller.ts` (the authenticated sibling) stays exactly
 * as it is — this is an ADDITIVE second read path, not a replacement, for
 * two callers neither an app session nor an admin token can serve:
 *   1. A store reviewer or a link shared outside the app, opening a plain
 *      URL in a browser and expecting a readable page.
 *   2. The mobile app itself fetching "raw rich text only content" (the
 *      Markdown source, not a rendered page) to lay out in its own UI —
 *      `?format=json` (or a JSON-preferring `Accept` header) is exactly that.
 *
 * Content negotiation, not two routes: a browser's default `Accept` header
 * lists `text/html` before `application/json` and a JSON HTTP client sends
 * `Accept: application/json` — so "does the request prefer HTML" is a
 * faithful proxy for "is this a browser", with `?format=` as an explicit
 * override for anyone (a curl script, a test) who wants to force one
 * without fighting header defaults. No `Accept` at all, or the wildcard
 * value meaning "anything", defaults to JSON — the safer default for a
 * machine caller that forgot to set the header, since HTML is opt-in for a
 * human.
 */
@Controller('legal')
export class LegalDocumentPublicController {
  constructor(private readonly service: LegalDocumentService) {}

  @Public()
  @Get(':documentType')
  async getDocument(
    @Param('documentType') documentTypeParam: string,
    @Query('audience') audienceParam: string | undefined,
    @Query('format') formatParam: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const documentType = parseLegalDocumentType(documentTypeParam);
    const audience = parseAudience(audienceParam);
    const document = await this.service.getCurrentForAudience(documentType, audience);

    const wantsHtml = formatParam === 'html' || (formatParam !== 'json' && this.prefersHtml(request.headers.accept));

    if (!wantsHtml) {
      void reply.header('Content-Type', 'application/json; charset=utf-8').send({
        success: true,
        data: {
          documentType: document.documentType,
          audience: document.audience,
          version: document.version,
          title: document.title,
          format: document.contentFormat,
          body: document.body,
        },
      });
      return;
    }

    const bodyHtml = document.contentFormat === 'markdown' ? renderMarkdownToHtml(document.body) : renderPlainTextToHtml(document.body);
    void reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(this.renderPage(escapeHtml(document.title), escapeHtml(document.version), bodyHtml));
  }

  /** True when `text/html` is listed ahead of (or without) `application/json` in `Accept`. Absent, or the "anything" wildcard, is NOT a preference for HTML — see the class header. */
  private prefersHtml(accept: string | undefined): boolean {
    if (!accept) return false;
    const htmlIndex = accept.indexOf('text/html');
    if (htmlIndex === -1) return false;
    const jsonIndex = accept.indexOf('application/json');
    return jsonIndex === -1 || htmlIndex < jsonIndex;
  }

  private renderPage(title: string, version: string, bodyHtml: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 20px; background: #fff; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
  .doc { max-width: 720px; margin: 0 auto; line-height: 1.6; }
  .version { color: #888; font-size: 13px; margin-bottom: 28px; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; }
  a { color: #2e7d32; }
  blockquote { margin: 0; padding-left: 16px; border-left: 3px solid #ccc; color: #666; }
  code { background: rgba(127,127,127,0.15); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
</style>
</head>
<body>
<div class="doc">
<div class="version">Version ${version}</div>
${bodyHtml}
</div>
</body>
</html>
`;
  }
}
