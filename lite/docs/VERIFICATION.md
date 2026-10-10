# Verification — 2026-10-10

## Station song history

The existing now-playing API already supplied the latest song, current-program
songs and up to 50 recent station songs. The Lite UI now renders those records
below the tuner on desktop and mobile, with covers, artist names and explicit
JST timestamps. Station/program scopes, four-row expansion and manual refresh
use the existing endpoint and playback-time 60-second refresh schedule.
Album covers load directly from their HTTPS image providers.

- Node 24.21.0: type check, frontend build, all 13 backend tests and DOM checks
  passed. DOM checks cover scope/expansion, JST conversion, untrusted text,
  empty records, failed-refresh retention, retry and A → B → A request races.
- Real FMJ records loaded through the local Node adapter and the production
  metadata endpoint. Chrome 154.0.8037.98 in an isolated headless browser passed
  history interaction checks at widths 1440, 1024, 768, 390 and 320, with no
  horizontal overflow or JavaScript page errors. Screenshots were captured in
  dark mode at all widths and light mode at 1440 and 390; the desktop dark and
  mobile light screenshots were visually reviewed.
- At width 390, real audio started and continued advancing during a manual
  song-history refresh. No physical mobile browser was available for this change.
- This feature was verified locally; production deployment is left to the user's
  Git push through the existing Vercel integration.

## Playback / native select fix (local handoff)

Production inspected: `dpl_Ch24SdJM4noBR4Z71fEekimSetQq`, Git `main` at
`004d10dfde02adedadb2aa4f75f8f93c8e79ee1b`.
Deployment: https://radikall-lite-8h6ygdv31-txfs19260817s-projects.vercel.app
(alias https://radikall-lite.vercel.app/).
Existing project `radikall-lite` has Root Directory `lite`, Node 24, region `iad1`.
No deployment, remote push, environment change, or project relinking was performed.

### Confirmed 502 cause

FMJ / JP13 session and master returned 200. Windows Edge 154 selected native HLS
(`canPlayType` returned `maybe`) and sent `Range: bytes=0-` for the extensionless
media playlist. The proxy forwarded that header. The upstream `/medialist`
returned 200 and `application/x-mpegURL`, but its body was six bytes: `200 OK`.
The proxy correctly rejected the invalid playlist with 502. Browser decoding
then failed as a consequence.

Replaying the **same production media URL** with Range returned 502; replaying
without Range returned 200 and a valid `#EXTM3U` playlist. Direct authenticated
upstream requests from local Node reproduced the same six-byte response versus
a valid 641-byte playlist. This isolates the fault to Range forwarding, rather
than the session secret, unsupported codecs, or a Vercel-only network restriction.

First captured failure: `/api/playback/live/<redacted>/proxy`, 502,
`application/json`, message `电台播放列表无效。`, Vercel request ID
`sfo1::iad1::jv8k2-1791667977829-575456a7710e`.
No signed URLs, playback tokens or authentication headers are retained here.

The fix omits redundant full-file `bytes=0-` ranges, fetches known playlists
whole, and refetches extensionless HLS responses without Range before rewriting.
Actual binary byte ranges and 206 responses still pass through. The allowlist,
TLS validation, authentication forwarding scope and both TS import settings remain.

### Checks passed

- Node 24.21.0: `npm run check`, `npm run build`, `npm test` (13 backend tests
  plus DOM checks), and `npm start`. Both Range regression tests failed with 502 before the fix.
- Real FMJ: session, master, media and three consecutive segments. The smoke
  script checks HLS syntax and audio/container signatures, bounds reads, cancels
  each reader, and sends the original native-browser Range header for playlists.
- `@vercel/node` 23.0.1 with TypeScript 5.9.3: built a `nodejs24.x` Lambda in a
  temporary directory; imported its actual `api/index.js` under Node 24.
  Compiled health, bootstrap (109 stations), session, master, media and three
  segments all returned 200 through the adapter's `__route` handling.
- Windows Chrome 154.0.8037.98, isolated headless browser: native HLS advanced
  70.07 seconds; hls.js advanced 70.06 seconds. Both passed pause/replay and
  FMJ → TBS switching, with zero playback HTTP errors (23 and 22 binary responses
  respectively, including restart/switch). hls.js was exercised by overriding
  `canPlayType` in the **test browser only**; production selection is unchanged.
- Windows Edge 154 native HLS: audio advanced to 78.05 seconds and restarted.
- Browser-injected session and native-media failures showed safe correlation
  IDs; removing the injected failure and clicking Play recovered. DOM regression
  checks preserve that ID when the later `play()` rejection arrives.
- Failure tests distinguish auth1, auth2, stream lookup and media parsing;
  logs preserve status, MIME type, duration, safe error code and request ID while
  excluding injected credentials, URL queries, body text and header parameters.
- Chrome desktop and 390×844 mobile emulation: dark, light, system-dark,
  system-light and live system-theme switching. Inspected closed controls and
  actual expanded native menus, keyboard focus, selection and highlighted items.
  Before the fix the popup was white with near-white text. After explicit
  select/option/optgroup backgrounds, dark menus are dark with light text and
  light menus have dark text; selected/highlighted items remain readable.

Native media elements do not expose the failed HTTP response to JavaScript.
Session errors therefore display their `requestId`; subsequent playback errors
display the non-secret `playbackId`, which is also carried in server failure logs
alongside the individual `requestId`. Search either value in runtime logs.
Logs use the event `radio_upstream_failure`; lookup fallback uses warning level.

### Reproduce and deploy through the existing integration

Run in the application directory with Node 24:

```powershell
npm ci
npm run check
npm run build
npm test
node scripts/smoke-live.ts
# Optional: after a deployment is authorized, test that deployment's alias.
$env:TEST_ORIGIN = 'https://radikall-lite.vercel.app'
node scripts/smoke-live.ts
Remove-Item Env:TEST_ORIGIN
```

The local smoke probe generates an ephemeral key if none is supplied; it does
not require a production secret or write an environment file. `TEST_STATION`
and `TEST_AREA` can select another valid station/area pair (defaults FMJ / JP13).
The pre-fix production deployment still failed this Range-aware probe on the
final retest: session/master 200, media 502. Its request ID was
`sfo1::iad1::f8rhq-1791668791607-06fe2950a167`.

When release is authorized, review/merge the local fix branch into the existing
GitHub production branch and let its Vercel integration deploy. Keep Root
Directory `lite`; do not import a second project or change framework settings.
Start runtime logging before replaying the probe / browser test:

```powershell
npx vercel@latest logs --deployment https://radikall-lite.vercel.app --follow
```

CLI syntax was checked against installed 63.1.2 help and the
[official logs documentation](https://vercel.com/docs/cli/logs).

### Remaining verification boundary

The fixes have **not** been deployed or verified on a new production deployment.
Desktop native popups were visible in this browser's screenshots; mobile
emulation uses the desktop engine/popup and is not an Android/iOS device test.
No physical phone, Safari/WebKit, human audible listening, lock-screen playback,
55-minute renewal, or new Cloudflare/Netlify deployment was tested.

## Initial implementation verification (historical)

Validated locally with Node.js 24.19.0.

## Passed

- Strict TypeScript check (`npm run check`).
- Native Node TypeScript frontend build (`npm run build`).
- Nine backend/integration tests (`npm test`): encrypted session round-trip and tamper detection; HLS playlist, key and init-map rewriting; upstream URL restrictions; input validation; session creation and expiry; streaming audio and Range forwarding; redirect validation; Vercel/Netlify/Cloudflare adapter dispatch; Node static file exposure boundaries.
- DOM interaction checks with mocked network/audio: bootstrap, theme switching, station search, favorites across region filters, play/pause state, sleep-timer selection and CDATA metadata rendering. These run with happy-dom, not a real browser.
- Real J-WAVE / FMJ upstream: session returned 200, master and media playlists were valid HLS, first audio response yielded 16,384 bytes with `application/octet-stream`. No authentication token or signed stream URL is included in this report.

## Not verified here

- Visual screenshots and real-browser interactions: the browser preview tool timed out when connecting to the local development server. Mobile layout was implemented with responsive CSS, but has not been visually verified on a real device.
- Audible decoding, actual iPhone Safari playback, background/lock-screen behavior, and a full 55-minute session renewal.
- Cloud production deployment. Platform adapters were tested locally; no user GitHub/hosting account was connected or changed.
- Docker image build and each provider's build/routing environment.

Use the deployment checklist in DEPLOY.zh-CN.md after importing your GitHub fork. The real upstream check is a snapshot, not a promise that all stations or hosting regions will remain reachable.
