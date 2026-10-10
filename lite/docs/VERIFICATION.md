# Verification — 2026-10-10

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
