# Kitchen Dashboard

Kiosk dashboard for the kitchen tablet. Pulls the weekend plan from the
WeekendPlanning site, weather from the National Weather Service, live MBTA
departures, today's workouts from WorkoutPlanning, and runs its own chore
schedule and feedback board.

## Run locally

```
npm install
node server.js
```

Open http://localhost:3000. PINs: Brendan `1998`, Emma `2024` by default
(override with `BRENDAN_PIN` / `EMMA_PIN`). Log in once on the tablet; the
cookie lasts a year.

## Environment

- `PORT` (Railway sets this)
- `DATA_DIR` — sqlite db lives here. On Railway, mount a volume at `/data`
  and set `DATA_DIR=/data`.
- `SESSION_SECRET` — required in production, any long random string
- `BRENDAN_PIN`, `EMMA_PIN`
- `WEEKEND_URL` (default https://weekend.finnoperations.com), `WEEKEND_PIN`
  (default = BRENDAN_PIN) — the server logs into WeekendPlanning and reads
  `/api/state`
- `WORKOUT_URL` (default the WorkoutPlanning Railway domain)
- `MBTA_API_KEY` — optional; raises rate limits (free at api-v3.mbta.com)
- `LAT`, `LON` — default Central Square, Cambridge

## Modules

- **Weekend** — this weekend + the next planned-out weekend: dates, status,
  availability for B and E, itinerary items, link to the planner.
- **Weather** — NWS forecast: today/tonight/tomorrow plus an hourly strip.
- **MBTA** — live countdowns (predictions, falling back to schedules):
  Red Line at Central toward Kendall/MIT (`place-cntsq`, direction 0),
  1 bus at Mass Ave opp Lee St toward BMC (stop `69`, direction 1),
  47 bus at Green St @ Magazine St toward Longwood/BCH (stop `1123`,
  direction 1).
- **Chores** — daily/weekly schedule with per-week alternation ("alt"
  chores swap between B and E by ISO week), tap to check off.
- **Workouts** — best-effort read of WorkoutPlanning `/api/state` for
  today; shows an empty state until that API grows a richer summary.
- **Feedback** — the ✦ Idea button; ideas stay listed until marked done.

## Kiosk notes

Designed for a landscape 10" tablet. Data refreshes every 45 s
(server-side caches: MBTA 30 s, weather 10 min, weekend 5 min). MBTA
countdowns re-render every 20 s between fetches.
