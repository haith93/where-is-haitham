# Where Is Haitham Now? — Development Log

A record of the build session: what was decided, what was built, how it was
deployed, and every problem that came up along the way with its root cause.

- **Repository:** https://github.com/haith93/where-is-haitham
- **Live site:** https://haith93.github.io/where-is-haitham/
- **Backend:** Supabase project `cjvwwncaftkzbbpwugdi`
- **Session dates:** 13 September 2026 → 27 September 2026

---

## Contents

1. [The brief](#1-the-brief)
2. [Architecture decisions](#2-architecture-decisions)
3. [What was built](#3-what-was-built)
4. [File structure](#4-file-structure)
5. [Deployment walkthrough](#5-deployment-walkthrough)
6. [Change: join with a code instead of e-mail](#6-change-join-with-a-code-instead-of-e-mail)
7. [Troubleshooting log](#7-troubleshooting-log)
8. [Commit history](#8-commit-history)
9. [Open items](#9-open-items)

---

## 1. The brief

An internal status board for Haitham, a technician who moves between six
buildings doing IT support, printer repair, photocopying and general
administration. More than 100 colleagues need him during the day.

The application exists to **stop the phone ringing**. Anyone can open it and see:

- where Haitham is, and what he is doing
- how long he expects to be there, and when he will be free
- whether he is currently with someone
- who is waiting, what they need, and how urgent it is

Plus historical data and automatic daily / weekly / monthly reports.

### Hard constraints from the brief

| Rule | How it was honoured |
|---|---|
| No GPS, no location tracking | Location is a name chosen from a list. No coordinates are ever collected. |
| Never type a clock time | The UI only offers a **duration**. The database stamps the start with `now()`. |
| Buildings and tasks configurable | Both are database tables managed from the admin panel; nothing is hard-coded in the frontend. |
| Allow one-off custom locations/tasks | Free-text entry that is recorded on the event but never added to the permanent lists. |
| Vanilla HTML/CSS/JS only | No framework, no build step. The only browser dependency is `supabase-js` from a CDN. |
| Must run on GitHub Pages | Entirely static. The database, auth and realtime all come from Supabase. |

---

## 2. Architecture decisions

```
GitHub Pages  (static HTML + CSS + ES modules, no build step, no server)
      │
      │  @supabase/supabase-js  — anon key only
      ▼
Supabase
  ├── PostgreSQL      tables, constraints, and every write as an RPC
  ├── Auth            e-mail + password, and anonymous sessions for the code flow
  ├── Realtime        the board pushes itself to every open screen
  ├── Row Level Security
  └── Edge Function   send-push  (optional — Web Push only)
```

Five decisions carry most of the weight.

### Every write goes through a `SECURITY DEFINER` function

The browser cannot `INSERT` or `UPDATE` a status or a request directly — those
grants are revoked in `rls.sql`. The functions call `now()` themselves, re-check
the caller's role, and write the history row and the current row in one
transaction.

A stolen anon key therefore cannot forge a status, backdate an activity, or
accept somebody else's request. It also makes "no manual time entry" impossible
to violate: the browser has no way to send a timestamp.

### Employees never read other people's requests

A single `public_board` row holds a pre-computed, privacy-filtered JSON snapshot
(status, who is being served, the queue as names and categories, counts).
Database triggers refresh it whenever anything relevant changes, and Realtime
pushes it out.

Request descriptions and requester identities beyond a display name never leave
the database for people who should not see them. An employee's RLS policy on
`service_requests` is `requester_id = auth.uid()` — they can only ever see their
own.

### Expected time and actual time are different columns

- `expected_end_at` = server start time + the duration that was chosen
- `actual_end_at` = written only when a real transition happens
- `actual_minutes` = a generated column, `actual_end_at - started_at`

When the expected time passes, the board says *"expected time has passed, this
status may be out of date"*. It never guesses a new location and never pretends
the expected end was the actual end. Reports use actual time; the difference
between the two is reported separately, so "planned 10 minutes, actually took
17" stays visible.

### Renames cannot rewrite history

Every history row and every request freezes `location_name_snapshot` and
`task_name_snapshot` at the time it was created. Renaming "Building 2" later
does not silently change what last month's report says.

Buildings and tasks are **disabled**, never deleted — `DELETE` is revoked from
both tables.

### Push lives in an Edge Function

A Web Push message must be signed with a VAPID *private* key, which can never
ship to a browser, and GitHub Pages has no server. So the sending half lives in
`supabase/functions/send-push`, triggered by a database webhook on
`notifications`.

The whole app works without it — notifications then arrive in-app over Realtime
instead, and the settings screen says so plainly rather than pretending.

---

## 3. What was built

### For everybody — `index.html`

```
WHERE IS HAITHAM NOW?

🔵 WITH SOMEONE
📍 Building 2
🛠️ Printer repair

STARTED 3:57 PM        EXPECTED UNTIL 4:27 PM
EXPECTED AVAILABILITY  4:27 PM

CURRENTLY SERVING      Sarah Mansour · Building 2 · Printer repair
WAITING (2)            Rita Haddad — urgent · George Saab — normal

[ REQUEST HAITHAM ]
```

Three views in one page so switching is instant on a phone: the board, the
employee's own requests (with reference numbers like `REQ-2026-000123` and a
timeline per request), and their account.

### For Haitham — `admin.html`

Nine hash-routed sections, designed for one thumb: Dashboard, My status,
Requests, Buildings, Tasks, Users, Reports, History, Settings.

Posting a status is three taps — status, place, duration — and the screen shows
the window it will create (`4:40 PM → 4:55 PM`) live, before he commits.

The queue supports accept / start / complete / reject, priority changes and
manual reordering. "Start" also moves his tracked status to that building in the
same tap.

### Reports

Built from the historical tables, never entered by hand. Today / yesterday /
this week / this month / custom range, plus filters by building, task, priority
and status.

Totals, time by location, time by task, tasks by count, requests by category,
building and priority, a requests-per-day chart, expected-vs-actual comparison,
and highlights. CSV export for summary, requests and activity; print/PDF via the
browser.

Charts are hand-written inline SVG (`js/charts.js`) — no charting library, and
they theme and print correctly.

### PWA

Manifest, service worker with an offline shell, generated PNG icons (written by
a small Python script using only `zlib` and `struct`), and installability on a
phone.

---

## 4. File structure

```
where-is-haitham/
├── index.html              Public / employee board
├── admin.html              Haitham's console (hash-routed sections)
├── login.html              Employee join page (name + access code)
├── staff.html              Administrator e-mail sign-in
├── offline.html            Shown when the network is gone
├── 404.html                GitHub Pages fallback
├── manifest.json           PWA manifest
├── service-worker.js       Offline shell + push delivery
├── .nojekyll               Stops GitHub Pages hiding files
│
├── assets/icons/           App icons (PNG + SVG)
│
├── css/
│   ├── main.css            Design tokens, reset, component set
│   ├── dashboard.css       The status board
│   ├── admin.css           Admin screens
│   └── responsive.css      Breakpoints (mobile first)
│
├── js/
│   ├── config.js           Configuration + shared label maps
│   ├── env.example.js      Copy to env.js with your keys
│   ├── supabase.js         The client + friendly error messages
│   ├── auth.js             Session, profile, role guards, code join
│   ├── data.js             Buildings, tasks, settings, users, access code
│   ├── status.js           Status read/write + expiry logic
│   ├── requests.js         Service request lifecycle
│   ├── realtime.js         All Realtime subscriptions
│   ├── notifications.js    In-app alerts + Web Push
│   ├── reports.js          Aggregation + CSV export
│   ├── charts.js           SVG bar charts, proportion bars
│   ├── utils.js            Timezone-correct formatting, DOM helpers
│   ├── ui.js               Toasts, sheets, busy states, theme, SW registration
│   ├── dashboard.js        index.html controller
│   ├── admin.js            admin.html controller
│   ├── login.js            login.html controller (join)
│   └── staff.js            staff.html controller (e-mail auth)
│
├── sql/
│   ├── schema.sql          Tables, indexes, triggers, publication
│   ├── functions.sql       Every write path, as RPCs
│   ├── rls.sql             Policies + grants
│   ├── seed.sql            Settings, buildings, tasks
│   └── access.sql          Join-with-a-code sign-up
│
├── supabase/functions/send-push/   Optional Web Push sender
└── .github/workflows/deploy.yml    Builds env.js and publishes Pages
```

### Database tables

`profiles`, `buildings`, `tasks`, `service_requests`, `request_history`,
`status_history`, `current_status`, `notifications`, `push_subscriptions`,
`audit_log`, `app_settings`, `public_board`, `request_counters`,
`access_codes`, `access_attempts`.

---

## 5. Deployment walkthrough

The order matters — the keys must exist before GitHub can deploy anything.

### A. Supabase

1. **Create the project.** Region: Frankfurt (closest good option to Lebanon).
2. **Run the SQL in order** in *SQL Editor → New query*:

   | # | File |
   |---|---|
   | 1 | `sql/schema.sql` |
   | 2 | `sql/functions.sql` |
   | 3 | `sql/rls.sql` |
   | 4 | `sql/seed.sql` |
   | 5 | `sql/access.sql` |

   Order matters: `rls.sql` revokes the grants `functions.sql` works around, and
   `seed.sql` writes through the policies.
3. **Authentication → Providers**: enable Email. Decide on *Confirm email*
   (off is smoother for a small internal team).
4. **Authentication → Providers**: enable **Anonymous sign-ins** — required for
   the join-with-a-code flow.
5. Copy the **Project URL** and the **anon public** key.

### B. GitHub

```bash
git init -b main
git add -A
git commit -m "Where Is Haitham Now? - initial version"
git remote add origin https://github.com/haith93/where-is-haitham.git
git push -u origin main
```

Repository must be **public** — GitHub Pages on free accounts requires it. That
is safe: the anon key is designed to be public and RLS does the protecting.

### C. Secrets and Pages

1. **Settings → Secrets and variables → Actions**: add `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`.
2. **Settings → Pages → Source** → **GitHub Actions** (not "Deploy from a
   branch", which would skip the workflow that writes the keys).
3. Push. The workflow writes `js/env.js` from the secrets, refuses to publish if
   it detects a service-role key, strips `sql/` and `supabase/` from the output,
   and deploys.

### D. First administrator

1. **Authentication → URL Configuration**: set Site URL and add
   `https://haith93.github.io/where-is-haitham/*` to Redirect URLs.
2. Sign up at `staff.html` with Haitham's e-mail.
3. Promote by hand — roles are never self-assigned:

   ```sql
   update public.profiles
      set role = 'admin', active = true
    where id = 'PASTE-THE-ID';
   ```

4. Set the employee access code in **Admin → Settings**.
5. Untick **Also allow sign-up with an e-mail address**.

### E. Ongoing

Every push to `main` redeploys automatically.

---

## 6. Change: join with a code instead of e-mail

### The request

Asking 100+ colleagues to create accounts with e-mail addresses and passwords is
real friction and a support burden. Could sign-up use a single shared code
instead?

### What was considered

| Option | Verdict |
|---|---|
| Drop identity entirely | Rejected — Haitham must know *who* is asking and *where they are*. |
| E-mail sign-up gated behind a shared code | Works, but still an inbox round trip. |
| **Anonymous sign-in + name + shared code** | **Chosen.** No e-mail, no password, no confirmation link. |

E-mail/password was kept for administrators, so password recovery still exists
where it matters.

### How it works

1. Employee opens the site, taps **Join**, enters their **name** and the
   **access code**.
2. The app creates an anonymous Supabase session. The profile starts
   `active = false` and can do nothing.
3. `claim_staff_access(code, name)` verifies the code **inside the database** and
   sets the name and `active = true`.

The code must be checked server-side — enforcing it in JavaScript would be
decoration, since the anon key is public. It is stored as a **bcrypt hash** in
`access_codes`, a table with RLS enabled and **no policies at all**, so nothing
holding the anon key can read it. Six wrong attempts in 15 minutes locks that
session out, on top of Supabase's own per-IP rate limit on anonymous sign-ins.

### Trade-offs, stated plainly

- **Identity is per device.** A new phone means entering name and code again,
  which creates a second account. Requests already sent keep the name they were
  sent with, so reports are unaffected.
- **No account recovery.** That is the cost of having no password.
- **Rotating the code does not sign anyone out.** People who already joined stay
  joined; a new code only affects people joining from then on. When someone
  leaves: rotate the code *and* deactivate their name in Admin → Users.

### Later refinement

The employee join page and the staff sign-in page were split into two separate
pages (`login.html` and `staff.html`), so employees never see an administrator
login form at all.

---

## 7. Troubleshooting log

Eight problems came up. Root cause and fix for each.

### 7.1 Closed dialogs visible on desktop

**Symptom:** the "Request Haitham" form rendered inline on the page instead of
staying hidden.

**Cause:** a desktop media query set `.sheet { display: grid }`, which overrode
the browser's built-in `dialog:not([open]) { display: none }` — author styles
beat the UA stylesheet.

**Fix:** scoped the rule to `.sheet[open]`.

### 7.2 Crash before configuration check

**Symptom:** `Cannot read properties of null (reading 'rpc')` on first load.

**Cause:** `initOffline()` fires its callback immediately, which called
`refreshBoard()` before the app had checked whether Supabase was configured.

**Fix:** guarded on `configured && state.booted`.

### 7.3 Guard trigger blocked the SQL editor

**Symptom:**
`ERROR: 42501: Only an administrator can change a role or deactivate an account`
when running the promote-to-admin query.

**Cause:** the Supabase SQL editor has no JWT, so `auth.uid()` is `NULL` and
`is_admin()` returned false. My trigger could not tell a database administrator
apart from an employee trying to promote themselves — and it blocked the exact
bootstrap path the setup guide told the user to use.

**Fix:** the guard now checks `current_user`. PostgREST runs API requests as
`anon` or `authenticated`, so the guard still catches the attack it exists for;
a direct connection passes through. Dropping `SECURITY DEFINER` was the other
half — inside a definer function `current_user` reports the *owner*, which would
have disabled the check entirely.

### 7.4 Stale service worker served a mismatched shell

**Symptom:** tapping "Staff sign-in" did nothing. Repeated cache clearing needed.

**Cause:** `login.html` and `login.js` were changed together but
`VERSION` in `service-worker.js` was not bumped. With stale-while-revalidate the
browser combined **new HTML with old JavaScript**. The old script's first line
referenced `#tab-signup`, which no longer existed — it threw, and every handler
after it was never attached. Dead buttons, no visible error.

**Fix:** bumped the cache version, and added an update-aware registration
(`registerServiceWorker` in `ui.js`) that activates a new worker immediately and
reloads once. The original registration had no update path at all. Also added
optional chaining throughout the login wiring so one missing element can never
take down the rest of a page — verified by deliberately deleting two elements.

### 7.5 Blank admin console

**Symptom:** app bar and bottom nav rendered, content area completely empty.

**Cause:** `boot()` threw or stalled before unhiding the shell. A thrown error
only produced a toast that vanished after 7 seconds; a *stalled* promise
produced nothing at all — no error, no timeout, just an empty page forever.

**Fix:** a 12-second watchdog, an on-page error with a Reload button, and each
section wired independently via a `safe()` wrapper.

### 7.6 The real hang — auth lock deadlock

**Symptom:** `Reading your session timed out after 8s`, with this stack:

```
getSession → getProfile → auth.js:308 ← my handler
           → _notifyAllSubscribers → _recoverAndRefresh → _initialize
```

**Cause — the big one.** `supabase-js` takes an auth lock during start-up and
**awaits** each `onAuthStateChange` callback while still holding it. My handler
was `async` and did `await getProfile()`, which calls `getSession()`, which waits
for that same lock. The dispatcher waited for the callback; the callback waited
for the dispatcher.

This is why it broke *consistently*, and why clearing site data appeared to fix
it: with no stored session there is nothing to recover, so the lock is never
taken. Sign in → session stored → next load deadlocks again.

The same mistake was in `login.js`, which is why staff sign-in kept breaking too.

**Fix:** both callbacks are now synchronous and push network work to a later task
with `setTimeout(…, 0)`, after the lock is released.

**Verified, not assumed.** A stub mirroring the real client (takes a lock, awaits
subscribers inside it) was run against both versions:

| | lock | queued callers | page |
|---|---|---|---|
| Old handler | held forever | **2** | blank, shell hidden |
| Fixed handler | released | 0 | dashboard renders |

Two queued callers matched the reported console exactly.

**Also added as a safety net:** timeouts on every auth call (8s session, 10s
profile), no redirect on timeout — an early attempt at this caused a
login ⇄ admin ping-pong loop, caught by testing — and a
**"Sign out and sign in again"** button that clears stored tokens.

### 7.7 `gen_salt(unknown) does not exist`

**Symptom:** setting the access code failed with SQL error `42883`, and the
network tab showed a `404` on the RPC.

The 404 and the error are the *same* failure: PostgREST maps `42883`
(*undefined function*) to HTTP 404.

**Cause:** `pgcrypto` lives in the `extensions` schema on Supabase, but the
functions were pinned to `search_path = public`.

**First fix failed**, for a second reason: the correction began with
`create extension if not exists "pgcrypto" with schema extensions;`. If a project
has no `extensions` schema that errors — and the Supabase SQL editor runs a
script as **one transaction**, so the whole block rolled back and the function
was never updated. The visible error was about the schema, easy to miss.

**Final fix:** `access.sql` now creates the schema if missing, installs pgcrypto
only if absent, then **looks up whichever schema it actually landed in** and
sets the search_path dynamically with `alter function … set search_path`. It
raises a clear exception if pgcrypto genuinely cannot be installed, and ends
with `notify pgrst, 'reload schema'`.

### 7.8 Notification button greyed out

**Symptom:** on a Galaxy A16, "Turn on notifications" was disabled. Was it
already on?

**Answer: no.** It was disabled because Web Push is not configured — there is no
VAPID key and the `send-push` Edge Function is not deployed. The explanatory
text said so, but a greyed-out button reads as broken rather than as
information.

In-app notifications work now over Realtime while the app is open. Closed-app
push needs the Edge Function setup in README §13.

---

## 8. Commit history

```
eaf8722  Resolve pgcrypto schema dynamically in access.sql
039b4c8  Separate join and staff sign-in pages; fix pgcrypto search_path
168306c  Fix auth lock deadlock in onAuthStateChange handler
159ef92  Stop the auth path from hanging; add session recovery
c53045e  Never leave the admin console blank when start-up fails
75f879b  Fix admin sign in
6792491  Fix profile guard blocking direct database connections
8e3402e  Join with a shared access code instead of e-mail sign-up
3cf5b9d  Trigger first deployment
bfdffea  Where Is Haitham Now? - edit api url
fc90e78  Where Is Haitham Now? - initial version
```

---

## 9. Open items

### Needs verifying

- [ ] **The pgcrypto fix.** Run the block from `sql/access.sql` (section 10) in
      the SQL editor and confirm `select crypt('test', gen_salt('bf')) is not null`
      returns `true`. This was the last thing worked on and was not confirmed
      working.
- [ ] **Set the access code** in Admin → Settings, then untick
      *Also allow sign-up with an e-mail address*.
- [ ] **End-to-end test:** send a request from a second browser via the join
      page; confirm it appears in the admin queue with no refresh.

### Optional, not yet done

- [ ] **Web Push** (README §13): generate a VAPID key pair, add the public half
      as the `VAPID_PUBLIC_KEY` repository secret, deploy
      `supabase/functions/send-push`, set its secrets, and add a database webhook
      on `notifications` INSERT. Until then, in-app alerts work normally.
- [ ] **Custom domain** for the Pages site.

### Known limitations

- Identity is per device for code-joined employees (see §6).
- The SQL in this project was never executed against a real PostgreSQL during
  development — no local instance was available — so it was verified by
  inspection and by running it live. Two bugs (§7.3, §7.7) were found that way.
- Anonymous accounts abandoned mid-join leave an inert row. **Admin → Settings →
  Remove unfinished guest accounts** clears them; it only touches accounts that
  are inactive, have no e-mail, and have never sent a request.

---

---

## 10. Change set — 27 September 2026

A follow-up brief reshaped the product around one idea: **employees should
never sign in**.

### Employee login removed entirely

The access-code join flow built earlier was deleted — tables, functions, RLS
policies, `login.html` and `js/login.js`. Anyone can now open the board and send
a request with no account.

Security moved into a single narrowly scoped RPC, `create_public_request`. The
`anon` role can execute three functions and read nothing but the pre-filtered
board and the building/task lists. Because there is no login, the RPC enforces
its own rate limits: five per device per ten minutes, duplicate suppression, and
a global cap.

`service_requests.requester_id` became nullable; the typed name lives in
`requester_name_snapshot` as it always did.

### Following your own request without an account

Creation returns an unguessable `public_token`, stored in that browser. It backs
**My requests**, so someone can check whether Haitham has accepted — which is
the follow-up phone call the app exists to prevent.

### Requests that arrive by phone, WhatsApp or in person

`admin_create_request` records those as the same standardised record. Every
request now carries a `channel`, shown on the queue card, exported in the CSV,
and broken down in Reports under *How requests arrived*. Ticking *I am handling
this right now* records and starts it in one step, moving his status to the
requester's location.

### Arabic and English

New `js/i18n.js` holds 349 translated strings with no imports of its own, so it
can sit at the bottom of the dependency graph. Two details made the rest cheap:

- **Label getters.** `STATUS_META.label` and friends became getters that call
  `t()`, so all 38 existing `.label` call sites translate with no edits.
- **Logical CSS properties.** `border-inline-start`, `padding-inline-start`,
  `inset-inline-start` and `text-align: start` replaced their physical
  equivalents, so Arabic genuinely mirrors rather than just changing words.

Switching language sets `lang`/`dir`, re-applies `data-i18n` attributes and
notifies subscribers to re-render — nothing navigates, so the screen and scroll
position survive. Dates and times use `ar-LB-u-nu-latn`: Arabic wording, Latin
digits, which is how Lebanon writes them.

### Visual redesign

Yellow leads, green supports. Text on yellow is near-black — white on yellow
fails contrast at any usable weight, so `--accent-contrast` exists for that.
The `info` tone moved from blue to teal so it stays distinguishable without
introducing a third colour family. Spacing gained `--gap` and `--gap-group`
tokens, larger card padding and more room between logically different sections.

### Verified

Built a stub client and exercised: anonymous submission (reference number and
queue position returned), device-local tracking, the admin queue showing the
channel, record-on-behalf with *start now* (status moved to "With someone ·
Administration · Computer repair" immediately), reports including the new
channel breakdown, and both languages at desktop and 375px.

One gap found and fixed during testing: `durationText` and `relativeTime` were
emitting English inside Arabic text ("20 min ago"). Both now route through i18n.

### Bilingual data names

Building and task names are *data*, not interface strings, so the Arabic layer
did not reach them — "Computer repair" stayed English on an otherwise Arabic
screen. `buildings` and `tasks` gained an optional `name_ar`, and the three
snapshot-carrying tables gained a frozen Arabic column beside the English one,
so an old report still reads correctly in either language. Where no Arabic name
has been entered the English one is used, so nothing renders blank.

The admin screens take both names when adding or renaming, and each row shows
the name in the *other* language so nothing looks like it is repeating itself.

Also corrected: the Arabic spelling of Haitham's name, حيثم → **هيثم**, in 13
places.

### Still to do

- [ ] Run `sql/migration-public-requests.sql` against the live database.
- [ ] Then run `sql/migration-bilingual-names.sql`.
- [ ] Confirm the `pgcrypto` item from §9 is moot — the access-code system that
      needed it has been removed, so `crypt`/`gen_salt` are no longer used
      anywhere.

---

*Log generated 27 September 2026.*
