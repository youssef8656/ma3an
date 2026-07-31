# Google Sheets as a backend — setup guide (v2, with real login)

## 1. Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and create a new spreadsheet.
2. You don't need to create any tabs by hand — the script creates all four
   (`Users`, `Teams`, `Games`, `GameSignups`) automatically, with headers and
   default rows, the first time each one is needed.

## 2. Add the Apps Script

1. In the Sheet, go to **Extensions → Apps Script**.
2. Delete any starter code and paste in the contents of `Code.gs`.
3. Click the **Save** icon (or Ctrl/Cmd+S).

## 3. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" → choose **Web app**.
3. Fill in:
   - **Description**: anything, e.g. "Camp registration API v2"
   - **Execute as**: **Me** (your account)
   - **Who has access**: **Anyone** — required so the public site can call it
4. Click **Deploy**.
5. The first time, Google will ask you to **authorize** the script. Click
   through the "unverified app" warning (expected for personal scripts) and
   allow access.
6. Copy the **Web app URL**:
   ```
   https://script.google.com/macros/s/AKfycb.../exec
   ```

### Updating the script later
If you edit `Code.gs` after deploying, the live URL won't pick up changes
automatically. Go to **Deploy → Manage deployments → Edit (pencil icon) →
New version → Deploy**. The URL stays the same; only the code behind it updates.

## 4. Test it

Paste the Web App URL into your browser — you should see:
```json
{"status":"MA3AN registration API is running."}
```

## 5. Connect it to your frontend

Open **`ma3an-data.js`** (in the site root, not this folder) and set:
```js
const SCRIPT_URL = 'https://script.google.com/macros/s/XXXX/exec';
```
That's the *only* place you need to paste the URL — every page includes
`ma3an-data.js` and calls through it, so there's no more per-page `SCRIPT_URL`
to configure.

```html
<script src="page-transitions.js"></script>
<script src="ma3an-data.js"></script>
```

- `ma3an-data.js` POSTs as `text/plain;charset=utf-8` — Apps Script doesn't
  handle the CORS preflight (`OPTIONS`) request that browsers send for
  `application/json`, so this avoids the preflight while still sending JSON
  as the body text.
- No API key, auth header, or backend server needed.

## The sheet tabs

### `Users` — one row per account
```
Email address | Password | Full Name | Age | Mobile Number |
Parent/Guardian Name | Parent/Guardian Phone Number | Grade | Gender | Team |
Switches Remaining | Points
```
- **Password** is stored as a SHA-256 hash, never plaintext — but this is
  still a lightweight system, not real authentication. Don't reuse a real
  password here, and don't put anything sensitive in the sheet.
- **Switches Remaining** / **Points** are extra bookkeeping columns the site
  needs (team-switch limits, admin points) — appended after the columns you
  asked for, so the first ten columns match your spec exactly.
- **Team** stores one of the current column headers on the `Teams` tab (e.g. `Red`).

### `Teams` — one column per team, rosters listed below
```
Red      | Yellow  | Blue      | Green
Amira H. | Sara T. | Youssef K.| Nadine R.
Omar S.  |         | Layla M.  |
```
The header row (row 1) is the list of valid team names — edit it directly to
rename or add/remove teams, the script reads it live instead of using a
hardcoded list. The names below each header are that team's roster; the
script keeps this in sync automatically every time a camper joins or
switches teams (`handleJoinTeam`), so you don't need to edit the rosters by
hand — just the header row if you want to change the team names themselves.

### `Games` — one column per game, signups listed below
```
Chairball | Dodgeball | Soccer  | Big Game | Pool Time
Amira H.  | Omar S.   | Sara T. |          |
```
Same idea as `Teams`: the header row is the list of valid games (edit it to
add/remove/rename games), and the script keeps each column's roster in sync
whenever a camper joins or leaves a game (`handleJoinGame` /
`handleLeaveGame`).

### `GameSignups` — who's in which game (many-to-many)
```
Email | Full Name | Game
```
One row per email+game pair. A camper can join more than one game. This
stays as the underlying record the script checks against (to avoid
duplicate signups); the `Games` tab above is the human-readable view.

### Migrating from the old single-column Teams/Games sheets
If your `Teams`/`Games` tabs still have the old single-column layout (just
a list of names in column A), open this project at script.google.com, pick
**migrateToRosterSheets** from the function dropdown at the top, and click
**Run** once. It rebuilds both tabs into the new column-per-team/game
layout using whatever's currently in `Users`/`GameSignups`, preserving any
custom team/game names you'd added. Safe to re-run if needed.

## API reference

All endpoints go to your one Web App URL. `GET` for reads, `POST` (as
`action` in a JSON body) for writes.

**Register** — `POST`
```json
{"action":"register","email":"fady@example.com","password":"supersecret1",
 "fullName":"Fady Nabil","age":"12","mobile":"0100 000 0000",
 "parentGuardianName":"Mona Fady","parentPhone":"0111 111 1111",
 "grade":"7th","gender":"Male","team":"Red"}
```
Only `email`, `password` (min. 8 characters), and `fullName` are required.
Returns `{"success":true,"profile":{...no password...}}` — the frontend logs
the camper in right away with this.

**Login** — `POST`
```json
{"action":"login","email":"fady@example.com","password":"supersecret1"}
```
Returns `{"success":true,"profile":{...}}` or
`{"success":false,"error":"Incorrect email or password."}`.

**Get one profile** — `GET`
```
.../exec?action=getProfile&email=fady@example.com
```

**Update contact info** — `POST`
```json
{"action":"updateContact","email":"fady@example.com",
 "mobile":"0100 000 0000","parentGuardianName":"Mona Fady","parentPhone":"0111 111 1111"}
```

**Join/switch a team** — `POST`
```json
{"action":"joinTeam","email":"fady@example.com","team":"Green"}
```
Returns `{"success":true,"team":"Green","switchesRemaining":2}`, or
`{"success":false,"error":"No switches remaining."}` once they're out.

**Join / leave a game** — `POST`
```json
{"action":"joinGame","email":"fady@example.com","name":"Fady Nabil","game":"Soccer"}
{"action":"leaveGame","email":"fady@example.com","game":"Soccer"}
```
(`joinSport` / `leaveSport` still work too, as aliases, for any older code.)

**Everything public in one call** — `GET`
```
.../exec?action=getPublicData
```
Returns:
```json
{
  "success": true,
  "teams": ["Red","Yellow","Blue","Green"],
  "games": ["Chairball","Dodgeball","Soccer","Big Game","Pool Time"],
  "teamRosters": { "Red": ["Name1", "..."], "...": [] },
  "gameRosters": { "Soccer": ["Name1", "..."], "...": [] }
}
```
This is what `MA3AN.getPublicData()` in `ma3an-data.js` calls (with a short
client-side cache) so pages never have to show hardcoded/fake team or game data.

## Admin: `admin.html`

`ADMIN_KEY` in `Code.gs` gates the admin-only endpoints below — **change it
from the default before you deploy**. It's a shared secret, not real auth:
anyone with the Web App URL and the key can use them.

**List everyone** — `GET`
```
.../exec?action=getAllProfiles&adminKey=YOUR_ADMIN_KEY
```

**Add/subtract points** — `POST`
```json
{"action":"addPoints","adminKey":"YOUR_ADMIN_KEY","email":"fady@example.com","delta":10}
```

## How login/session works on the frontend (`ma3an-data.js`)

There's a real `login.html` now, but there's still no server-side session —
`ma3an-data.js` keeps the logged-in camper's profile in the browser's
`localStorage` after a successful `login`/`register` call. Every page that
needs "who's using the site right now" reads it back with:

```js
const me = MA3AN.getSession();       // { email, fullName, team, ... } or null
MA3AN.requireLogin();                // bounces to login.html if nobody's logged in
```

`page-transitions.js`'s old `?email=&name=` URL-carrying is left in place for
pages that haven't been rewired yet, but new/updated pages should prefer
`MA3AN.getSession()` — it survives navigation without cluttering the URL, and
is what actually reflects the account someone logged into.

## Limitations to know about

- Apps Script Web Apps have Google's quota limits (executions/day, runtime
  per request) — fine for a camp site, not built for high-volume traffic.
- This is not enterprise-grade auth: passwords are hashed but there's no
  rate-limiting, password reset flow, or session expiry. Good enough for a
  camp sign-up site; don't store anything sensitive beyond what's listed above.
- Google may show a brief cold-start delay on the first request after a
  period of inactivity.