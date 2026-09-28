# Public tracking page hardening

Branch: `fix/track-hardening` from `origin/main` `5e88694`.  
No merge. Prod was not touched. Date: 2026-09-29.

## Live-driving statuses

`fleet_tracking_staging` constraint `tasks_status_check` (queried 2026-09-29, not guessed):

`pending`, `pending_review`, `accepted`, `assigned`, `rejected`, `in_progress`, `completed`, `cancelled`, `withdrawn`.

The only value in that set that means the vehicle is driving is `in_progress`. `PUBLIC_TRACK_LIVE` is that one value (`routes/publicTrack.js:11-15`).

## Code

| Item | Proof |
|---|---|
| HTML `Content-Type: text/html; charset=utf-8` on success, 404, and 500 | `routes/publicTrack.js:788`, `:810`, `:1034` |
| `<meta charset="utf-8">` and a non-empty `<title>` | success `routes/publicTrack.js:814-817`; 404 shell `routes/publicTrack.js:48-55` and `:788-792`. 404 title is `TulipFleet — Link geçersiz` |
| Success title is `TulipFleet — <task_no>` | `routes/publicTrack.js:800-801`, `:817` |
| `X-Robots-Tag`, `Referrer-Policy`, `Cache-Control` on every response of the four public routes | `onRequest` hook `routes/publicTrack.js:1056-1061`. Routes `:1070-1073` |
| `<meta name="referrer" content="no-referrer">` | `routes/publicTrack.js:815` and the 404 shell `:53` |
| Leaflet `referrerPolicy: 'no-referrer'` | `routes/publicTrack.js:909` |
| JSON drops `id` and any `*_id` key, including event ids and `eta.next_stop_id` | `stripInternalIds` `routes/publicTrack.js:37-45`, applied at `:427` |
| Kept public fields | `task_no`, `status`, `title`, `start_location`, `end_location`, `vehicle_plate`, `actual_start`, `actual_end`, `waypoints`, `events`, `last_location`, `eta`, `updated_at` — `routes/publicTrack.js:428-442` |
| `last_location` and `eta` only when status is live | `routes/publicTrack.js:287`, `:300`, `:440-441`. Assigned and pending return both `null`. Waypoints are still returned |
| TR note when the vehicle is not driving | exact string `routes/publicTrack.js:499`. The note card starts hidden (`:878`) and is shown only when status is outside `LIVE_STATUS` (`:983-987`) |
| TR status labels on the HTML badge. Raw status stays in JSON | dict `routes/publicTrack.js:17-27`, injected `:903`, used `:939` |

The 404 mojibake was the UTF-8 word `geçersiz` served without a charset. The source string was already `Link geçersiz veya süresi dolmuş`. The response charset and the meta tag are what the browser uses.

## Tests

`tests/` contains one file, `tests/publicTrack.test.js`. `npm test` is `node --test "tests/**/*.test.js"` (`package.json:7`). On this Node (v24, Windows) `node --test tests/` tries to load the directory as a module, so the script runs every `*.test.js` under `tests/` instead.

`npm test`: 9 passed, 0 failed. New coverage: charset header (`tests/publicTrack.test.js:199`, `:283`), `no-referrer` header (`:37-40`, `:205`, `:268`), no `id` / `*_id` keys (`:186`, `:267`), assigned → `last_location` null and `eta` null (`:254-267`).

## Staging

Host `fleet-prod-01`, app `/opt/fleet/backend-staging`, PM2 `fleet-staging` only. Git HEAD left at `d46d563`. Prod container and `fleet-sim-prod` were not restarted.

The process on disk was still the pre-plugin page (`fastify.get("/public/track/:token")` inline, no `routes/publicTrack.js`, no `@fastify/rate-limit`). Route-list diff against this branch's `server.js` showed no extra staging routes. The remaining `server.js` difference was the MVP1 move of those handlers into the plugin. Deploy copied this branch's `server.js`, `package.json`, `package-lock.json`, and `routes/publicTrack.js`.

Backups: `server.js.bak.20260929_011200`, `package.json.bak.20260929_011200`, `package-lock.json.bak.20260929_011200`.  
`npm install --omit=dev` added 2 packages. `node --check` passed. `require("@fastify/rate-limit")` and `require("pg")` passed.  
`pm2 restart fleet-staging --update-env` → online, pid `3498972`. `http://127.0.0.1:3001/health` **200**.

Proofs are `curl -i` from the server to `127.0.0.1:3001` and to `https://staging-api.tulipfleet.com`. Tokens were revoked in the same run (`hour_tokens=revoked:3`). No token, plate, address, or coordinate is recorded. The first `in_progress` JSON read inserted one `STOP_DELAYED` event (existing ETA path). That row was deleted (`deleted_stop_delayed=1`).

| Token task | Route | Status line | Headers |
|---|---|---|---|
| `TLP-26-00014` completed | `/v/:token`, `/v/:token.json`, `/public/track/:token`, `/public/track/:token.json`, and the public host `/v` pair | `HTTP/1.1 404 Not Found` | `content-type` HTML `text/html; charset=utf-8` or JSON `application/json; charset=utf-8`; `x-robots-tag: noindex, nofollow`; `referrer-policy: no-referrer`; `cache-control: no-store` |
| completed HTML | title `<title>TulipFleet — Link geçersiz</title>`, meta charset present, body contains `geçersiz`, mojibake absent | | |
| `RDM-1002` assigned | same four local routes plus public `/v` HTML and JSON | `HTTP/1.1 200 OK` | same three headers; HTML charset `utf-8` |
| assigned JSON | `last_location=null`, `eta=null`, `waypoints=2`, `idKeys` empty. `task` keys: `actual_end`, `actual_start`, `end_location`, `start_location`, `status`, `task_no`, `title`, `vehicle_plate`. `status=assigned` | | |
| assigned HTML | `<title>TulipFleet — RDM-1002</title>`, meta referrer, Leaflet `referrerPolicy`, page contains the TR live note | | |
| `RDM-1001` in_progress | same routes | `HTTP/1.1 200 OK` | same headers |
| in_progress JSON | `last_location` keys `heading,latitude,longitude,speed,time` (values not stored). `eta` keys `arrival_time,delayed,distance_km,minutes,next_stop_label,planned_time,speed_kmh` — no `next_stop_id`. `idKeys` empty | | |
| in_progress HTML | `<title>TulipFleet — RDM-1001</title>`, tile `referrerPolicy` present. The note string is in the language table; the card stays hidden unless status is outside the live set | | |
