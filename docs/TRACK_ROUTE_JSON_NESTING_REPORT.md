# HERE cache nested under route_json.public_route

Branch: `fix/track-route-json-nesting` from `main` `7ad2203`. Code commit `791b512`.  
No merge. Production was not updated. Date: 2026-10-07.

The public tracker was merging the HERE cache onto the top level of `tasks.route_json` (`origin`, `destination`, `geometry`, `distance_m`, `duration_s`, `provider`, `computed_at`). The driver app reads `route_json.origin` and `route_json.destination` as strings and renders them in `<Text>` (`DriverTaskDetail.js:510-519`, `:836`, `:855`). An object there crashes the screen. That shape was seen in production on `TLP-26-00003`.

The cache now lives only under `route_json.public_route`. A top-level `jsonb ||` merge still keeps sibling dispatcher keys such as `distance`. The public JSON response still sets `route.geometry` from that nested cache, so the Leaflet page keeps the road.

## Code

| Item | Proof |
|---|---|
| Read only `route_json.public_route` | `routes/publicTrack.js:216-220` |
| Geometry cache hit is `public_route.geometry` as an array of length >= 2 | `routes/publicTrack.js:222-226`, re-read `:269`, page read `:518` |
| Write patch is `{ public_route: { origin, destination, geometry, distance_m, duration_s, provider:'here', computed_at } }` | `routes/publicTrack.js:317-327` |
| Persist is `COALESCE(route_json,'{}')::jsonb \|\| $2::jsonb`; the WHERE skips a row that already has a `public_route.geometry` array | `routes/publicTrack.js:330-339` |
| Response `route.geometry` still comes from that cache | `routes/publicTrack.js:518-529` |
| Top-level `route_json.origin` / `destination` are still preferred when present, otherwise enterprise pickup / dropoff | `routes/publicTrack.js:490-505` |

A top-level `geometry` is not a cache hit. Until the cleanup below runs, a visit still calls HERE once and writes `public_route` beside the old keys. After the cleanup, the reader finds the nested geometry and does not call HERE.

`simulate_fleet.js` still prefers a top-level `route_json.origin` and still walks a straight leg (`simulate_fleet.js:124-125`, `:157-163`). After nesting, that fallback is the enterprise pickup. Following the road geometry stays a separate branch.

## Tests

`npm test` (`node --test "tests/**/*.test.js"`): 24 passed, 0 failed.

`tests/publicTrackHere.test.js:136` starts from `{ distance: "18.5" }`, asserts the UPDATE mentions `'public_route'`, keeps `distance` at the top level, leaves the seven HERE keys off the top level, and stores them on `public_route`. The second GET makes no HERE call. The ETA fixtures read the same nested shape (`tests/publicTrackHere.test.js:199-298`).

## One-time cleanup

Run the count, then the update, on production. The count on `fleet_tracking` at the time of this report was **1** row (`route_json->>'provider' = 'here'`). That SELECT ran inside the `fleet-backend` container. The UPDATE was not run there.

After the move, top-level `provider` is gone, so the same WHERE does not match the row again. `jsonb ||` replaces `public_route` when both a nested object and a top-level `provider` exist; the seven top-level values become the nested object.

```sql
SELECT count(*)::int
FROM tasks
WHERE route_json->>'provider' = 'here';

UPDATE tasks
SET route_json = (
  (
    route_json::jsonb
    - 'origin'
    - 'destination'
    - 'geometry'
    - 'distance_m'
    - 'duration_s'
    - 'provider'
    - 'computed_at'
  )
  || jsonb_build_object(
    'public_route',
    jsonb_strip_nulls(
      jsonb_build_object(
        'origin', route_json::jsonb -> 'origin',
        'destination', route_json::jsonb -> 'destination',
        'geometry', route_json::jsonb -> 'geometry',
        'distance_m', route_json::jsonb -> 'distance_m',
        'duration_s', route_json::jsonb -> 'duration_s',
        'provider', route_json::jsonb -> 'provider',
        'computed_at', route_json::jsonb -> 'computed_at'
      )
    )
  )
)
WHERE route_json->>'provider' = 'here';
```

## Staging

Checkout of `origin/fix/track-route-json-nesting` on `/opt/fleet/backend-staging`, detached HEAD `791b512`. PM2 `fleet-staging` restarted (`--update-env`), `/health` 200. `fleet-sim-prod` stayed pid `2696796`. Production `fleet-backend` was not restarted.

The same UPDATE was run on `fleet_tracking_staging` so the new reader could see the cache. That database had 1 matching row before and 0 after (`updated=1`). Production was only counted.

Proof task `TLP-26-00016`. A new token was inserted for two hours and revoked in the same run (`revoked=1`). The token is not recorded here.

`jsonb_object_keys` on `route_json`: `public_route` only. This row had no other top-level keys. Keys under `public_route`: `computed_at`, `destination`, `distance_m`, `duration_s`, `geometry`, `origin`, `provider`. Stored geometry length 693.

Two `GET /v/<token>.json` calls against `127.0.0.1:3001` both returned 200. Response `route.geometry` length 693. The pm2 count of `public track HERE route computed` did not increase on either call (`here_delta_first=0`, `here_delta_second=0`).
