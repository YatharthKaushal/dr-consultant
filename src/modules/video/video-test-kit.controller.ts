import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, HttpStatus, InternalServerErrorException, NotFoundException, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { getEnv } from '../../config/env/env.validation';
import { Public } from '../../shared/auth/auth.decorator';
import { LivekitClient } from './livekit.client';

/**
 * *** A MANUAL TEST HARNESS FOR M-14, NOT A PRODUCT SURFACE. ***
 *
 * Exists for exactly one purpose: proving the LiveKit signaling path
 * (CloudFront -> EC2:7880 -> self-hosted LiveKit) and the UDP media path
 * actually carry a real call, without needing a real login, a real booking, a
 * real payment or a real consent record to get there first.
 *
 * *** EVERYTHING `video.controller.ts` EXISTS TO ENFORCE, THIS FILE SKIPS ON
 * PURPOSE. *** No `@AccountType`, no `@CurrentUser`, no consultation
 * ownership check, no payment gate, no consent gate — `@Public()` on the
 * whole controller. That is a deliberate, narrow hole, not an oversight, and
 * it is closed by a single gate: `getEnv().VIDEO_TEST_KIT_ENABLED`, which
 * defaults to `false` (`env.validation.ts`). Every route 404s — not 403,
 * so a deployment with the flag off does not even reveal that this
 * controller exists — until an operator explicitly turns it on. NEVER wire
 * this flag on for a deployment carrying real patient traffic.
 *
 * *** WHY THIS IS SAFE TO SHIP DARK RATHER THAN DELETE AFTER TESTING. ***
 * It mints a token via the exact same `LivekitClient#mintJoinToken` real
 * calls use, with the exact same narrow grants (no `roomAdmin`, no
 * `roomRecord` — see that method's own header) — so a token from here can
 * do nothing to a room a real token could not also do. The only thing it
 * skips is WHO gets a token and for WHICH room, which is why the flag, not
 * a code review, is what has to stay off.
 *
 * *** THE ROOM NAME DELIBERATELY DOES NOT START WITH `consult-`. ***
 * `video-room.util.ts#consultationIdFromRoomName` only recognises
 * `consult-<uuid>`; a `testkit-...` room name returns `null` from it, which
 * means `video-webhook.service.ts#handle` logs it and ignores it — a test
 * call can never write a row to `consultation_participants` or move a real
 * consultation's status. This is the same "not this platform's business"
 * path a foreign LiveKit deployment's rooms already take, not a special case
 * added for this file.
 */

const TEST_KIT_ROOM_PREFIX = 'testkit-';
/** Generous on purpose — this is a manual test session, not a clinical one bound by FR-8.5's five-minute default. */
const TEST_KIT_TOKEN_TTL_SECONDS = 3600;

export class TestKitTokenRequestDto {
  @IsIn(['doctor', 'patient'], { message: 'role must be "doctor" or "patient".' })
  role!: 'doctor' | 'patient';

  /** Free-typed by the tester so two tabs can agree on a room without a backend round trip. Bounded and character-restricted before it becomes part of a LiveKit room name. */
  @IsOptional()
  @Matches(/^[a-zA-Z0-9_-]{1,64}$/, { message: 'room must be 1-64 letters, digits, "_" or "-".' })
  room?: string;
}

@Controller('video/test-kit')
@Public()
export class VideoTestKitController {
  constructor(private readonly livekit: LivekitClient) {}

  /**
   * The one-page test UI. Same gate as the token route — see the class
   * header. Sent via `@Res()` directly rather than a plain return, for the
   * same reason `audit-admin.controller.ts#sendCsv` gives: `ResponseInterceptor`
   * wraps every ordinary return value in `{ success, data }`, which turns an
   * HTML page into a JSON object a browser cannot render.
   */
  @Get()
  getPage(@Res() reply: FastifyReply): void {
    this.assertEnabled();
    void reply.header('Content-Type', 'text/html; charset=utf-8').send(TEST_KIT_HTML);
  }

  /**
   * Mints a token for a made-up test room, no auth, no ownership check.
   * `@HttpCode(200)` for the same reason `video.controller.ts#issueToken`
   * uses it: this creates no row and no room.
   */
  @Post('token')
  @HttpCode(HttpStatus.OK)
  async issueTestToken(@Body() body: TestKitTokenRequestDto) {
    this.assertEnabled();

    const room = `${TEST_KIT_ROOM_PREFIX}${body.room ?? 'default'}`;
    const identity = `${body.role}-${randomUUID().slice(0, 8)}`;
    const displayName = body.role === 'doctor' ? 'Doctor (test)' : 'Patient (test)';

    const token = await this.livekit.mintJoinToken({
      roomName: room,
      identity,
      displayName,
      ttlSeconds: TEST_KIT_TOKEN_TTL_SECONDS,
    });

    if (!token) {
      throw new InternalServerErrorException('Could not mint a test token — check the server logs.');
    }

    return { serverUrl: this.livekit.getServerUrl(), token, identity, room };
  }

  /** `false`/absent -> 404, not 403: a deployment with the flag off should not even confirm this controller exists. */
  private assertEnabled(): void {
    if (!getEnv().VIDEO_TEST_KIT_ENABLED) {
      throw new NotFoundException();
    }
  }
}

const TEST_KIT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>LiveKit Test Kit</title>
<script src="https://cdn.jsdelivr.net/npm/livekit-client@2.22.2/dist/livekit-client.umd.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #111; color: #eee; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #999; font-size: 13px; margin: 0 0 20px; }
  .panel { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; margin-bottom: 16px; }
  label { display: block; font-size: 12px; color: #aaa; margin-bottom: 4px; }
  select, input { font-size: 14px; padding: 6px 8px; border-radius: 6px; border: 1px solid #444; background: #1c1c1c; color: #eee; }
  button { font-size: 14px; padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; }
  #startBtn { background: #2e7d32; color: white; }
  #endBtn { background: #c62828; color: white; }
  #muteBtn, #camBtn { background: #333; color: #eee; border: 1px solid #555; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  #status { font-size: 13px; color: #4fc3f7; margin-bottom: 16px; min-height: 18px; }
  .videos { display: flex; gap: 16px; flex-wrap: wrap; }
  .videoBox { width: 420px; max-width: 100%; }
  .videoBox h3 { font-size: 12px; color: #999; margin: 0 0 6px; font-weight: 500; }
  .videoBox .frame { background: #000; border-radius: 8px; aspect-ratio: 4 / 3; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .videoBox video { width: 100%; height: 100%; object-fit: cover; }
  .controls { display: flex; gap: 8px; margin-top: 20px; }
</style>
</head>
<body>
  <h1>LiveKit Test Kit</h1>
  <p class="sub">Manual test harness — no login, no booking, no payment. Two tabs, same room, opposite roles.</p>

  <div class="panel">
    <div>
      <label for="role">Join as</label>
      <select id="role">
        <option value="patient">Patient</option>
        <option value="doctor">Doctor</option>
      </select>
    </div>
    <div>
      <label for="room">Room</label>
      <input id="room" type="text" value="test-room" maxlength="64" />
    </div>
    <button id="startBtn">Start Call</button>
    <button id="endBtn" disabled>End Call</button>
    <button id="muteBtn" disabled>Mute</button>
    <button id="camBtn" disabled>Camera Off</button>
  </div>

  <div id="status">Idle.</div>

  <div class="videos">
    <div class="videoBox">
      <h3>You</h3>
      <div class="frame" id="localFrame"></div>
    </div>
    <div class="videoBox">
      <h3>Other participant</h3>
      <div class="frame" id="remoteFrame"></div>
    </div>
  </div>

<script>
(function () {
  var roleSelect = document.getElementById('role');
  var roomInput = document.getElementById('room');
  var startBtn = document.getElementById('startBtn');
  var endBtn = document.getElementById('endBtn');
  var muteBtn = document.getElementById('muteBtn');
  var camBtn = document.getElementById('camBtn');
  var statusEl = document.getElementById('status');
  var localFrame = document.getElementById('localFrame');
  var remoteFrame = document.getElementById('remoteFrame');

  var room = null;
  var micOn = true;
  var camOn = true;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function clearFrame(frame) {
    while (frame.firstChild) frame.removeChild(frame.firstChild);
  }

  function resetUi() {
    endBtn.disabled = true;
    muteBtn.disabled = true;
    camBtn.disabled = true;
    startBtn.disabled = false;
    muteBtn.textContent = 'Mute';
    camBtn.textContent = 'Camera Off';
    micOn = true;
    camOn = true;
    clearFrame(localFrame);
    clearFrame(remoteFrame);
  }

  async function startCall() {
    startBtn.disabled = true;
    setStatus('Requesting a token...');

    var res;
    try {
      res = await fetch('/api/video/test-kit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: roleSelect.value, room: roomInput.value || 'default' }),
      });
    } catch (err) {
      setStatus('Could not reach the backend: ' + err.message);
      startBtn.disabled = false;
      return;
    }

    if (!res.ok) {
      var text = await res.text();
      setStatus('Token request failed (' + res.status + '): ' + text);
      startBtn.disabled = false;
      return;
    }

    var data = await res.json();
    setStatus('Connecting to ' + data.serverUrl + ' as ' + data.identity + '...');

    room = new LivekitClient.Room();

    room.on(LivekitClient.RoomEvent.TrackSubscribed, function (track) {
      var el = track.attach();
      if (track.kind === 'video') {
        clearFrame(remoteFrame);
        remoteFrame.appendChild(el);
      } else {
        el.style.display = 'none';
        document.body.appendChild(el);
      }
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, function (track) {
      track.detach().forEach(function (el) { el.remove(); });
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, function (pub) {
      if (pub.track && pub.track.kind === 'video') {
        var el = pub.track.attach();
        clearFrame(localFrame);
        localFrame.appendChild(el);
      }
    });

    room.on(LivekitClient.RoomEvent.ParticipantConnected, function (p) {
      setStatus('Connected. ' + p.identity + ' joined.');
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, function (p) {
      setStatus(p.identity + ' left.');
      clearFrame(remoteFrame);
    });

    room.on(LivekitClient.RoomEvent.Disconnected, function (reason) {
      setStatus('Disconnected (' + (reason || 'unknown reason') + ').');
      resetUi();
      room = null;
    });

    try {
      await room.connect(data.serverUrl, data.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      await room.localParticipant.setCameraEnabled(true);
      setStatus('In call as ' + data.identity + ' in room "' + data.room + '". Waiting for the other side...');
      endBtn.disabled = false;
      muteBtn.disabled = false;
      camBtn.disabled = false;
    } catch (err) {
      setStatus('Failed to connect: ' + err.message);
      startBtn.disabled = false;
      room = null;
    }
  }

  function endCall() {
    if (room) {
      room.disconnect();
    }
    setStatus('Call ended.');
    resetUi();
  }

  function toggleMute() {
    if (!room) return;
    micOn = !micOn;
    room.localParticipant.setMicrophoneEnabled(micOn);
    muteBtn.textContent = micOn ? 'Mute' : 'Unmute';
  }

  function toggleCamera() {
    if (!room) return;
    camOn = !camOn;
    room.localParticipant.setCameraEnabled(camOn);
    camBtn.textContent = camOn ? 'Camera Off' : 'Camera On';
    if (!camOn) clearFrame(localFrame);
  }

  startBtn.addEventListener('click', startCall);
  endBtn.addEventListener('click', endCall);
  muteBtn.addEventListener('click', toggleMute);
  camBtn.addEventListener('click', toggleCamera);
})();
</script>
</body>
</html>
`;
