import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { getEnv } from '../../config/env/env.validation';
import { Public } from '../../shared/auth/auth.decorator';
import { DiscoverSearchDto } from './search.dto';
import { SearchService } from './search.service';

/**
 * *** A MANUAL TEST HARNESS FOR M-09, NOT A PRODUCT SURFACE. *** Same posture
 * as `video-test-kit.controller.ts` — read that file's header first, the
 * reasoning is identical, just for a different module.
 *
 * Exists to actually exercise the AI-assisted symptom search (query ->
 * concern/specialty mapping -> ranked doctors) against a REAL LLM credential
 * with no patient login. `@Public()` on the whole controller, gated by
 * `getEnv().SEARCH_TEST_KIT_ENABLED` (default `false`) — every route 404s,
 * not 403, when it is off.
 *
 * *** WHY `patientId: null` IS NOT A HACK. *** `search.contract.ts#
 * DiscoveryRequest.patientId` is already `string | null` for exactly this
 * shape of caller: "`null` for an unattributed source (MCP/WhatsApp) —
 * logged, but never surfaced in anyone's recent searches." This controller
 * takes that same, already-supported path with `source: 'mcp'` rather than
 * inventing a throwaway patient row — no `patients` table dependency, and a
 * test run can never appear in a real patient's search history.
 *
 * This DOES spend real money (a billed Gemini/etc call) and DOES write a
 * `search_queries` row — unlike the video test kit's inert `testkit-` rooms,
 * there is no way to make an LLM call free or a query log invisible. That
 * is an accepted cost of testing this for real, not an oversight.
 */
@Controller('search/test-kit')
@Public()
export class SearchTestKitController {
  constructor(private readonly search: SearchService) {}

  @Get()
  getPage(@Res() reply: FastifyReply): void {
    this.assertEnabled();
    void reply.header('Content-Type', 'text/html; charset=utf-8').send(TEST_KIT_HTML);
  }

  @Post('discover')
  @HttpCode(HttpStatus.OK)
  async discover(@Body() dto: DiscoverSearchDto) {
    this.assertEnabled();
    return this.search.discover({
      patientId: null,
      source: 'mcp',
      queryText: dto.queryText,
      isVoiceInput: dto.isVoiceInput,
      languages: dto.languages,
      maxFeeInr: dto.maxFeeInr,
      availableWithinDays: dto.availableWithinDays,
      limit: dto.limit,
    });
  }

  private assertEnabled(): void {
    if (!getEnv().SEARCH_TEST_KIT_ENABLED) {
      throw new NotFoundException();
    }
  }
}

const TEST_KIT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Search Test Kit</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #111; color: #eee; max-width: 760px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #999; font-size: 13px; margin: 0 0 20px; }
  textarea { width: 100%; box-sizing: border-box; font-size: 14px; padding: 10px; border-radius: 6px; border: 1px solid #444; background: #1c1c1c; color: #eee; resize: vertical; min-height: 80px; }
  button { margin-top: 10px; font-size: 14px; padding: 8px 18px; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; background: #2e7d32; color: white; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #status { font-size: 13px; color: #4fc3f7; margin: 14px 0; min-height: 18px; }
  #result { display: none; }
  .crisis { background: #4a1414; border: 1px solid #a33; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 13px; }
  .guidance { font-size: 14px; margin-bottom: 16px; line-height: 1.5; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .chip { background: #1c1c1c; border: 1px solid #444; border-radius: 999px; padding: 3px 10px; font-size: 12px; color: #ccc; }
  .chip b { color: #eee; }
  .section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #888; margin: 18px 0 6px; }
  .doctor-card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .doctor-card .name { font-size: 15px; font-weight: 600; }
  .doctor-card .meta { font-size: 12px; color: #999; margin-top: 2px; }
  .doctor-card .reason { font-size: 12px; color: #7fd17f; margin-top: 6px; }
  .empty { font-size: 13px; color: #888; font-style: italic; }
  details { margin-top: 20px; }
  summary { cursor: pointer; font-size: 12px; color: #888; }
  pre { background: #000; border-radius: 8px; padding: 14px; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; margin-top: 8px; }
</style>
</head>
<body>
  <h1>AI Search Test Kit</h1>
  <p class="sub">Manual test harness for the AI-assisted symptom search — no login, no patient record. Runs a real, billed LLM call.</p>

  <textarea id="query" placeholder="e.g. I've been feeling anxious and can't sleep for the past two weeks">I've been feeling very anxious and can't sleep well for the past two weeks</textarea>
  <div><button id="go">Send Query</button></div>
  <div id="status"></div>

  <div id="result">
    <div id="crisisBox"></div>
    <div class="guidance" id="guidanceText"></div>

    <div class="section-label">Matched concerns / specialties</div>
    <div class="chips" id="matchedChips"></div>

    <div class="section-label">Ranked doctors</div>
    <div id="doctorList"></div>

    <details>
      <summary>Raw JSON response</summary>
      <pre id="out"></pre>
    </details>
  </div>

<script>
(function () {
  var queryEl = document.getElementById('query');
  var goBtn = document.getElementById('go');
  var statusEl = document.getElementById('status');
  var resultEl = document.getElementById('result');
  var crisisBoxEl = document.getElementById('crisisBox');
  var guidanceEl = document.getElementById('guidanceText');
  var chipsEl = document.getElementById('matchedChips');
  var doctorListEl = document.getElementById('doctorList');
  var outEl = document.getElementById('out');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Replaces {{specialty:code}}/{{concern:code}} tokens with their human label, using guidance.references. */
  function renderGuidanceText(guidance) {
    if (!guidance) return '';
    var byToken = {};
    (guidance.references || []).forEach(function (ref) { byToken[ref.token] = ref.label; });
    return escapeHtml(guidance.text).replace(/\{\{[a-z]+:[a-z0-9_]+\}\}/gi, function (token) {
      return '<b>' + escapeHtml(byToken[token] || token) + '</b>';
    });
  }

  function renderChips(data) {
    var chips = [];
    (data.matchedSpecialties || []).forEach(function (s) { chips.push('<span class="chip">specialty: <b>' + escapeHtml(s.name) + '</b></span>'); });
    (data.matchedConcerns || []).forEach(function (c) { chips.push('<span class="chip">concern: <b>' + escapeHtml(c.name) + '</b></span>'); });
    return chips.length ? chips.join('') : '<span class="empty">No specific match — showing general suggestions in the raw response.</span>';
  }

  function renderDoctors(results) {
    if (!results || results.length === 0) return '<div class="empty">No doctors matched this query.</div>';
    return results.map(function (d) {
      return '' +
        '<div class="doctor-card">' +
          '<div class="name">' + escapeHtml(d.fullName) + '</div>' +
          '<div class="meta">' + escapeHtml(d.qualification || '') + ' &middot; ' + d.yearsOfExperience + ' yrs &middot; ₹' + escapeHtml(d.consultationFeeInr) + ' &middot; ' + escapeHtml((d.languages || []).join(', ')) + '</div>' +
          '<div class="reason">' + escapeHtml(d.reason || '') + ' (score ' + d.score + ')</div>' +
        '</div>';
    }).join('');
  }

  goBtn.addEventListener('click', async function () {
    var text = queryEl.value.trim();
    if (!text) return;
    goBtn.disabled = true;
    statusEl.textContent = 'Sending to AI search...';
    resultEl.style.display = 'none';

    try {
      var res = await fetch('/api/search/test-kit/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryText: text }),
      });
      var body = await res.json();

      if (!res.ok) {
        statusEl.textContent = 'Request failed (' + res.status + ').';
        outEl.textContent = JSON.stringify(body, null, 2);
        resultEl.style.display = 'block';
        return;
      }

      var data = body.data;
      statusEl.textContent = 'Done. Interpretation source: ' + (data.meta ? data.meta.interpretation : 'unknown') + '.';

      crisisBoxEl.innerHTML = data.crisis
        ? '<div class="crisis">' + escapeHtml(JSON.stringify(data.crisis)) + '</div>'
        : '';
      guidanceEl.innerHTML = renderGuidanceText(data.guidance);
      chipsEl.innerHTML = renderChips(data);
      doctorListEl.innerHTML = renderDoctors(data.results);
      outEl.textContent = JSON.stringify(body, null, 2);
      resultEl.style.display = 'block';
    } catch (err) {
      statusEl.textContent = 'Could not reach the backend: ' + err.message;
    } finally {
      goBtn.disabled = false;
    }
  });
})();
</script>
</body>
</html>
`;
