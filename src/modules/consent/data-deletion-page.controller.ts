import { Controller, Get, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { PUSH_APP_KEYS, type PushAppKey } from '../notification/notification-push.types';
import { Public } from '../../shared/auth/auth.decorator';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { escapeHtml } from '../../shared/richtext/markdown.util';
import { DATA_DELETION_CONFIG_KEYS, DATA_DELETION_DEFAULT_GRACE_PERIOD_DAYS } from './data-deletion.constants';

function parseApp(value: string | undefined): PushAppKey {
  const match = PUSH_APP_KEYS.find((app) => app === value);
  return match ?? 'patient';
}

/**
 * *** THE PUBLIC "DELETE MY ACCOUNT" PAGE. *** App Store guideline 5.1.1(v)
 * (and the equivalent DPDP Act expectation) requires an account-deletion
 * path reachable from OUTSIDE the app, not just inside it — this is that
 * page. `@Public()`, no class-level `@AccountType`, and *** ALWAYS ON — NO
 * ENV FLAG. *** Unlike the two test kits (`video-test-kit.controller.ts`/
 * `search-test-kit.controller.ts`), a store reviewer must be able to reach
 * this in every environment, so it is never gated behind a feature flag.
 *
 * *** DOES NOT ADD A NEW UNAUTHENTICATED DELETION ENDPOINT. *** The page's
 * own JavaScript is a thin browser client for routes that already exist and
 * already enforce ownership: `POST /api/auth/otp/request` and
 * `POST /api/auth/otp/verify` (both already `@Public()`) to prove the
 * visitor controls the number, then the real, authenticated
 * `POST /api/data-deletion-requests` with the access token that verify
 * returns — the EXACT SAME call the mobile app itself makes. There is no
 * server-side code here that can raise a deletion request; this controller
 * only serves the page and reads the grace-period config to display it.
 */
@Controller('account-deletion')
export class DataDeletionPageController {
  constructor(private readonly appConfig: AppConfigService) {}

  @Public()
  @Get()
  async getPage(@Query('app') appParam: string | undefined, @Res() reply: FastifyReply): Promise<void> {
    const app = parseApp(appParam);
    const graceDays = await this.appConfig.getNumber(DATA_DELETION_CONFIG_KEYS.GRACE_PERIOD_DAYS, DATA_DELETION_DEFAULT_GRACE_PERIOD_DAYS);
    void reply.header('Content-Type', 'text/html; charset=utf-8').send(renderPage(app, graceDays));
  }
}

function renderPage(app: PushAppKey, graceDays: number): string {
  const appLabel = escapeHtml(app === 'doctor' ? 'Doctor' : 'Patient');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Delete Your Account</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 20px 80px; background: #fff; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
  .doc { max-width: 560px; margin: 0 auto; line-height: 1.6; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #888; font-size: 14px; margin-bottom: 28px; }
  h2 { font-size: 16px; margin-top: 32px; }
  ul { padding-left: 20px; }
  .card { border: 1px solid rgba(127,127,127,0.3); border-radius: 10px; padding: 20px; margin-top: 16px; }
  label { display: block; font-size: 13px; color: #888; margin: 14px 0 4px; }
  input { width: 100%; box-sizing: border-box; font-size: 15px; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(127,127,127,0.4); background: transparent; color: inherit; }
  button { margin-top: 16px; width: 100%; font-size: 15px; padding: 11px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; background: #c0392b; color: white; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: #2e7d32; }
  #status { font-size: 13px; margin-top: 12px; min-height: 18px; }
  #status.error { color: #e74c3c; }
  #status.ok { color: #27ae60; }
  #confirmation { display: none; }
  .retained { font-size: 13px; color: #888; margin-top: 24px; }
  a { color: #2e7d32; }
</style>
</head>
<body>
<div class="doc">
  <h1>Delete Your Account</h1>
  <p class="sub">${appLabel} app</p>

  <p>You can request deletion of your account at any time. Once you request it:</p>
  <ul>
    <li>Your account stays fully usable for <strong>${graceDays} days</strong> — you can keep using the app, and cancel the deletion request at any time before it takes effect.</li>
    <li>After that window (or as soon as an admin reviews and approves it, if sooner), your account is deactivated and your name and contact details are hidden from other users.</li>
    <li>Medical, consultation, and payment records are kept as required by law and are never shown to anyone as belonging to you again.</li>
    <li>Your registered mobile number is freed — if you ever want to come back, you'll sign up as a new account. An admin can restore your original account instead, at any time, on request.</li>
  </ul>

  <h2>Request deletion in the app</h2>
  <p>Open the app, go to <strong>Settings → Delete Account</strong>, and confirm. You'll see your request's status and a Cancel option there at any time before it takes effect.</p>

  <h2>Or request it right here</h2>
  <div class="card" id="form-card">
    <div id="step-mobile">
      <label for="mobile">Your registered mobile number</label>
      <input id="mobile" type="tel" placeholder="+91XXXXXXXXXX" autocomplete="tel" />
      <button id="send-otp">Send verification code</button>
    </div>
    <div id="step-code" style="display:none">
      <label for="code">Verification code</label>
      <input id="code" type="text" inputmode="numeric" placeholder="6-digit code" autocomplete="one-time-code" />
      <button id="verify-otp">Verify and request deletion</button>
    </div>
    <div id="status"></div>
  </div>

  <div class="card" id="confirmation">
    <strong>Your deletion request has been submitted.</strong>
    <p id="confirmation-detail"></p>
    <p>You can cancel this request at any time before it takes effect by signing in to the app.</p>
  </div>

  <p class="retained">This page never deletes anything itself — it verifies your number the same way signing in does, then submits the same request the app's own Delete Account screen submits.</p>
</div>

<script>
(function () {
  var APP = ${JSON.stringify(app)};
  var mobileEl = document.getElementById('mobile');
  var codeEl = document.getElementById('code');
  var sendBtn = document.getElementById('send-otp');
  var verifyBtn = document.getElementById('verify-otp');
  var statusEl = document.getElementById('status');
  var stepMobile = document.getElementById('step-mobile');
  var stepCode = document.getElementById('step-code');
  var formCard = document.getElementById('form-card');
  var confirmationEl = document.getElementById('confirmation');
  var confirmationDetailEl = document.getElementById('confirmation-detail');
  var challengeId = null;

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = kind || '';
  }

  async function unwrap(res) {
    var body = await res.json();
    if (!res.ok) {
      var message = (body && body.error && body.error.message) || ('Request failed (' + res.status + ').');
      throw new Error(message);
    }
    return body.data;
  }

  sendBtn.addEventListener('click', async function () {
    var mobileNumber = mobileEl.value.trim();
    if (!mobileNumber) { setStatus('Enter your mobile number.', 'error'); return; }
    sendBtn.disabled = true;
    setStatus('Sending code...');
    try {
      var data = await unwrap(await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobileNumber: mobileNumber, audience: APP }),
      }));
      challengeId = data.challengeId;
      stepMobile.style.display = 'none';
      stepCode.style.display = 'block';
      setStatus('Code sent. Enter it below.', 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      sendBtn.disabled = false;
    }
  });

  verifyBtn.addEventListener('click', async function () {
    var code = codeEl.value.trim();
    if (!code) { setStatus('Enter the code you received.', 'error'); return; }
    verifyBtn.disabled = true;
    setStatus('Verifying...');
    try {
      var verified = await unwrap(await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: challengeId, code: code }),
      }));

      setStatus('Submitting deletion request...');
      var request = await unwrap(await fetch('/api/data-deletion-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + verified.accessToken },
        body: JSON.stringify({ reason: 'Submitted via the public account-deletion page.' }),
      }));

      formCard.style.display = 'none';
      confirmationEl.style.display = 'block';
      var when = request.scheduledFor ? new Date(request.scheduledFor).toLocaleDateString() : 'the review period';
      confirmationDetailEl.textContent = 'Status: ' + request.status + '. Scheduled for ' + when + ' unless cancelled or reviewed sooner.';
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      verifyBtn.disabled = false;
    }
  });
})();
</script>
</body>
</html>
`;
}
