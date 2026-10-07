# Simulator follows public_route geometry

Branch: `feat/sim-follow-public-route` from `main` `31f7c56`. Code commit `2bedd39`.  
No merge. Production was not touched. Date: 2026-10-07.

Only `simulate_fleet.js` changed. An in-progress vehicle still drives two legs. The first leg, last location to pickup, stays a straight haversine line. The second leg follows `tasks.route_json.public_route.geometry` when that array is present. Without it, the second leg is still the straight line to dropoff.

## Geometry shape

`publicTrack.js` stores the HERE result on `route_json.public_route.geometry` (`routes/publicTrack.js:318-321`). The tracking page reads each element as a `[lat, lng]` pair: `p[0]` is latitude and `p[1]` is longitude (`routes/publicTrack.js:1154-1156`). A usable line has at least two points (`routes/publicTrack.js:222-225`).

`publicRouteGeometry` accepts only that shape (`simulate_fleet.js:100-114`). A top-level `route_json.geometry`, or points that are `{lat, lng}` objects, are ignored.

## Movement

| Item | Proof |
|---|---|
| Leg 1 is pickup only, and does not set `onRoad` | `simulate_fleet.js:234-239` |
| Leg 2 with geometry arms `dest` at the first point and `path` as the rest | `simulate_fleet.js:129-136`, `:240-241` |
| Leg 2 without geometry is still a single dropoff target | `simulate_fleet.js:242-247` |
| Speed ramp, wobble, and the last-1.5 km slowdown are unchanged | `simulate_fleet.js:292-299` |
| On the road, each published position is the furthest geometry vertex the step budget has reached. Leftover meters carry to the next tick | `simulate_fleet.js:300-326` |
| Off the road, the position is still one great-circle step | `simulate_fleet.js:328-336` |
| HAREKET log ends with `geometri=NNN nokta` or `geometri=yok` | `simulate_fleet.js:249-250` |

The carry exists because the vertices are not dense. On `TLP-26-00016` the 693 segments measure min 3 m, median 30 m, p95 139 m, max 725 m. A point in the middle of a long segment would be more than 30 m from both endpoints. Stopping on the vertex keeps every sample on the array, and the carried meters keep the average speed equal to `(km/h / 3.6) * interval`.

## Staging

Checkout of `origin/feat/sim-follow-public-route` on `/opt/fleet/backend-staging`, detached HEAD `2bedd39`. `node --check simulate_fleet.js` passed. A new PM2 process `fleet-sim-staging` (pid `2759432`) was started with `--interval 10 --dwell 0`, cwd `/opt/fleet/backend-staging`, so it used the staging env. Defaults in the file stay 30 s and 60 s. `fleet-sim-prod` stayed pid `2696796`. `fleet-staging` was not restarted (pid `2725715`). The staging sim was deleted after the samples below.

Proof task `TLP-26-00016` in `fleet_tracking_staging`, `in_progress`, 693 geometry points. The last location was older than 10 minutes, so the vehicle started at pickup and the delivery leg ran immediately (`baslangic=pickup`, `bacak=1/1`). Pickup is 1 m from the first geometry point. The HAREKET line for this task was `geometri=693 nokta`, `hedefe=32.5km`. Three other in-progress devices logged `geometri=yok` and kept the straight line.

Three consecutive locations written after the process started, each measured to the nearest geometry vertex:

| Order | Distance to a geometry point |
|---|---|
| 1 | 0 m |
| 2 | 0 m |
| 3 | 0 m |

The first and third of those locations are 149 m apart, so the vehicle advanced along the vertices rather than sitting on one point.
