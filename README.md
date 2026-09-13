# Where Is Haitham Now?

An internal status board for a technician who moves between six buildings all
day. It exists to stop the phone ringing.

Anyone in the organisation can open it and immediately see **where Haitham is,
what he is doing, when he expects to be free, who he is with and who is
waiting** — and send him a request instead of calling.

- **No GPS. No location tracking.** Haitham posts his own location by name.
- **No typing clock times, ever.** He picks a duration; the database stamps the
  start and computes the end.
- Everything is realtime: when he updates, every open screen updates.

---

## Contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Tech stack](#3-tech-stack)
4. [Folder structure](#4-folder-structure)
5. [Setup — Supabase](#5-setup--supabase)
6. [Setup — the first administrator](#6-setup--the-first-administrator)
7. [Setup — running it locally](#7-setup--running-it-locally)
8. [Deploying to GitHub Pages](#8-deploying-to-github-pages)
9. [Security model](#9-security-model)
10. [How time is handled](#10-how-time-is-handled)
11. [Realtime](#11-realtime)
12. [PWA / installing on a phone](#12-pwa--installing-on-a-phone)
13. [Push notifications](#13-push-notifications)
14. [Reports and exports](#14-reports-and-exports)
15. [Day-to-day admin](#15-day-to-day-admin)
16. [Troubleshooting](#16-troubleshooting)
17. [Known limitations](#17-known-limitations)

---

## 1. What it does

### For everybody (`index.html`)

A single board answering the questions people used to phone about:

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

Employees can also see their own requests, with a reference number
(`REQ-2026-000123`) and a timeline of what happened to each one.

### For Haitham (`admin.html`)

Nine sections, all designed for one thumb on a phone: Dashboard, My status,
Requests, Buildings, Tasks, Users, Reports, History, Settings.

Posting a status is three taps — status, place, duration — and the screen shows
the window it will create (`4:40 PM → 4:55 PM`) before he commits.

---

## 2. Architecture

```
GitHub Pages  (static HTML + CSS + ES modules, no build step, no server)
      │
      │  @supabase/supabase-js  — anon key only
      ▼
Supabase
  ├── PostgreSQL      tables, constraints, and every write as an RPC
  ├── Auth            e-mail + password
  ├── Realtime        the board pushes itself to every open screen
  ├── Row Level Security
  └── Edge Function   send-push  (optional — Web Push only)
```

Two design decisions carry most of the weight:

**Every write goes through a `SECURITY DEFINER` function.** The browser cannot
`INSERT` or `UPDATE` a status or a request directly — those grants are revoked.
The functions call `now()` themselves, re-check the caller's role, and write the
history row and the current row in one transaction. A stolen anon key cannot
forge a status, backdate an activity, or accept somebody else's request.

**Employees never read the requests table for other people.** A single
`public_board` row holds a pre-computed, privacy-filtered JSON snapshot
(status, who is being served, the queue as names + categories, counts). Database
triggers refresh it whenever anything relevant changes, and Realtime pushes it
out. Descriptions and requester identities beyond a display name never leave the
database for people who should not see them.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Markup / styling | HTML5, CSS3 with custom properties | No framework to learn or upgrade |
| Scripting | Vanilla JavaScript, ES modules | Runs straight from static hosting |
| Backend | Supabase (PostgreSQL) | Database, auth, realtime and RLS in one |
| Charts | Hand-written inline SVG (`js/charts.js`) | No dependency; themeable and printable |
| Hosting | GitHub Pages | Free static hosting; no Node server |

The only third-party code the browser loads is `@supabase/supabase-js`, pinned to
an exact version from jsDelivr.

---

## 4. Folder structure

```
where-is-haitham/
├── index.html              Public / employee board
├── admin.html              Haitham's console (hash-routed sections)
├── login.html              Sign in, sign up, password reset
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
│   ├── auth.js             Session, profile, role guards
│   ├── data.js             Buildings, tasks, settings, users
│   ├── status.js           Status read/write + expiry logic
│   ├── requests.js         Service request lifecycle
│   ├── realtime.js         All Realtime subscriptions
│   ├── notifications.js    In-app alerts + Web Push
│   ├── reports.js          Aggregation + CSV export
│   ├── charts.js           SVG bar charts, proportion bars
│   ├── utils.js            Timezone-correct formatting, DOM helpers
│   ├── ui.js               Toasts, sheets, busy states, theme
│   ├── dashboard.js        index.html controller
│   ├── admin.js            admin.html controller
│   └── login.js            login.html controller
│
├── sql/
│   ├── schema.sql          Tables, indexes, triggers, publication
│   ├── functions.sql       Every write path, as RPCs
│   ├── rls.sql             Policies + grants
│   └── seed.sql            Settings, buildings, tasks
│
├── supabase/functions/send-push/   Optional Web Push sender
└── .github/workflows/deploy.yml    Builds env.js and publishes Pages
```

---

## 5. Setup — Supabase

1. **Create a project** at [supabase.com](https://supabase.com). Pick a region
   near Lebanon (Frankfurt works well).

2. **Run the SQL, in this order**, in *SQL Editor → New query*. Each file is
   safe to re-run.

   | # | File | What it creates |
   |---|---|---|
   | 1 | `sql/schema.sql` | Tables, indexes, triggers, realtime publication |
   | 2 | `sql/functions.sql` | The RPCs that perform every write |
   | 3 | `sql/rls.sql` | Row Level Security policies and grants |
   | 4 | `sql/seed.sql` | Settings, starter buildings and tasks |

   Order matters: `rls.sql` revokes the grants that `functions.sql` works around,
   and `seed.sql` writes through the policies.

3. **Check Authentication settings** (*Authentication → Providers → Email*):
   - Email + password enabled.
   - Decide about **Confirm email**. On is safer; off is smoother for a small
     internal team. The app handles both.
   - Under *URL Configuration*, add your GitHub Pages address to
     **Redirect URLs**, e.g. `https://yourname.github.io/where-is-haitham/*`.
     Password reset links will not work without this.

4. **Copy your keys** from *Project Settings → API*: the **Project URL** and the
   **anon public** key. Those two are all the frontend ever needs.

> **Never** put the `service_role` key in this repository. It bypasses every
> policy. It belongs only in Supabase Edge Function secrets.

---

## 6. Setup — the first administrator

Roles are never self-assigned — new sign-ups are always `employee`. Promote the
first admin by hand:

1. Create Haitham's account through the app's **Create account** tab (or in
   *Authentication → Users → Add user*).
2. In the SQL editor:

```sql
update public.profiles
   set role = 'admin', active = true
 where lower(email) = lower('haitham@example.com');
```

3. Confirm:

```sql
select full_name, email, role, active from public.profiles order by created_at;
```

After that, Haitham can promote or deactivate anyone else from *Admin → Users*.

---

## 7. Setup — running it locally

```bash
cp js/env.example.js js/env.js
```

Edit `js/env.js` and paste in your Project URL and anon key. The file is
git-ignored.

Then serve the folder over HTTP — opening `index.html` from the file system will
not work, because ES modules and service workers need a real origin:

```bash
python -m http.server 8000
```

Open <http://127.0.0.1:8000>. If configuration is missing, the app says exactly
what to do instead of failing silently.

---

## 8. Deploying to GitHub Pages

1. Push this folder to a GitHub repository.

2. Add two repository secrets (*Settings → Secrets and variables → Actions*):

   | Secret | Value |
   |---|---|
   | `SUPABASE_URL` | `https://your-ref.supabase.co` |
   | `SUPABASE_ANON_KEY` | your anon public key |
   | `VAPID_PUBLIC_KEY` | *(optional)* public half of your VAPID pair |

3. *Settings → Pages → Build and deployment → Source*: **GitHub Actions**.

4. Push to `main`. The workflow writes `js/env.js` from the secrets, refuses to
   publish if a service-role key is detected, strips `sql/`, `supabase/` and the
   workflow itself from the published output, and deploys.

Your site appears at `https://<user>.github.io/<repo>/`. Both `index.html` and
`admin.html` are plain static files, so the sub-path hosting and hash routing
work without any server rewrites.

**Custom domain (optional).** Add a `CNAME` file containing your domain at the
repository root, point a `CNAME` DNS record at `<user>.github.io`, then set the
domain in *Settings → Pages* and tick **Enforce HTTPS**. Add the new address to
Supabase's Redirect URLs too.

---

## 9. Security model

**Authentication** is Supabase Auth (e-mail + password). The JWT carries the user
id; the role lives in `public.profiles` and is read server-side.

**Authorisation** is enforced in the database, never in JavaScript. The UI hides
things it should not show, but hiding is cosmetic — the policies are the control.

| Who | Can read | Can write |
|---|---|---|
| Anonymous | The board snapshot, buildings, tasks — **only while `public_dashboard` is on** | Nothing |
| Employee | The board, their own profile, their own requests, their own notifications | Create a request; cancel their own; edit their own display name; mark their own notifications read |
| Admin | Everything | Status, all request transitions, buildings, tasks, users, settings |

Specific protections worth knowing about:

- `INSERT`/`UPDATE`/`DELETE` are revoked from `anon` and `authenticated` on
  `service_requests`, `status_history`, `current_status`, `request_history`,
  `public_board`, `audit_log` and `request_counters`. Those tables change only
  through the RPCs in `functions.sql`.
- A user may update their own profile, but **column grants** limit that to
  `full_name`, and a `BEFORE UPDATE` trigger rejects any change to `role` or
  `active` from a non-admin. Two independent barriers against self-promotion.
- Buildings and tasks cannot be deleted at all (the `DELETE` grant is revoked) —
  only disabled, so historical reports keep their names.
- Push subscriptions are credentials; a user can only ever see their own.
- The board never exposes request descriptions or e-mail addresses to people who
  are not the requester or the admin.

### Verifying it yourself

Sign in as an ordinary employee and try these in the browser console. All four
must fail:

```js
// Forge a status
await sb.from('current_status').insert({ status_type: 'available' });
// Read somebody else's requests
await sb.from('service_requests').select('*');   // returns only your own rows
// Promote yourself
await sb.from('profiles').update({ role: 'admin' }).eq('id', myId);
// Rename a building
await sb.from('buildings').update({ name: 'x' }).neq('id', '');
```

---

## 10. How time is handled

This is the part most worth understanding.

**Storage.** Every timestamp is `TIMESTAMPTZ`, stored in UTC.

**Display.** Every timestamp is formatted with `Intl.DateTimeFormat` in
`Asia/Beirut`. No code anywhere adds or subtracts a fixed number of hours, so
Lebanon's daylight-saving changes are handled by the platform. Day boundaries
for reports are converted with a two-pass offset calculation
(`utils.zonedToUtc`) that stays exact on the days DST changes.

**No manual entry.** There is no start-time field and no end-time field anywhere
in the app. Haitham picks a duration:

```
Current time 12:30 PM   +  [10 min]   →   12:30 PM → 12:40 PM
Current time  2:17 PM   +  [30 min]   →    2:17 PM →  2:47 PM
Current time  9:52 AM   +  [1 hour]   →    9:52 AM → 10:52 AM
```

The preview on screen uses the browser clock, but the row that gets written is
stamped by PostgreSQL:

```sql
started_at      := now()
expected_end_at := now() + make_interval(mins => p_duration_minutes)
```

**Expected is not actual.** These are separate columns and they mean different
things:

| Column | Meaning |
|---|---|
| `expected_end_at` | What Haitham *planned*. Never changed afterwards. |
| `actual_end_at` | When he *really* moved on — written only when he posts the next status or taps *Finish current task*. |

When the expected time passes, the app says so — "Expected time has passed …
this status may be out of date" — and stops there. It does **not** close the
activity, guess a new location, or backfill `actual_end_at` with
`expected_end_at`. Reports use actual time, which is why *Expected vs actual* can
honestly tell you that jobs planned for 10 minutes take 17.

---

## 11. Realtime

Nothing polls. `js/realtime.js` opens subscriptions and the screen re-renders
when the database says something changed:

| Channel | Watches | Who uses it |
|---|---|---|
| `board` | `public_board` | Every dashboard |
| `requests-all` | `service_requests` | Admin queue |
| `requests-mine-<id>` | own requests (RLS-filtered) | Employee |
| `notifications-<id>` | own notifications | Everyone signed in |
| `current-status` | `current_status` | Admin |
| `config` | `buildings`, `tasks` | Everyone |

Two timers exist, both purely visual and neither touching the network: the clock
in the app bar (1 s) and the expiry recalculation (20 s).

Phones suspend sockets in the background, so every screen also re-fetches once
when the tab becomes visible again or the network returns.

---

## 12. PWA / installing on a phone

The app is installable and has an offline shell.

- **Android / Chrome:** open the site → menu → *Install app* / *Add to Home
  screen*.
- **iPhone / iPad, Safari:** Share → *Add to Home Screen*. (This step is
  mandatory before notifications can work at all on iOS.)

Offline behaviour: pages, CSS, JS and icons are cached, so the app opens without
a connection and shows a clear offline notice. **Application data is never
cached** — a status board that shows stale information is worse than one that
admits it cannot reach the server. While offline the app tells you so and refuses
to pretend a save succeeded.

---

## 13. Push notifications

In-app notifications always work: a row is written to `notifications`, Realtime
delivers it, and the app shows an alert and a badge. That needs no setup.

Delivering a notification when the app is **closed** needs Web Push, and Web Push
messages must be signed with a VAPID private key. GitHub Pages has no server, so
the sending half runs as a Supabase Edge Function.

If you skip this whole section the app still works correctly — it just will not
buzz Haitham's phone while the app is shut.

### Setting it up

1. **Generate a VAPID key pair.** With Node available:

   ```bash
   npx web-push generate-vapid-keys
   ```

   Or use any VAPID generator. You get a public key and a private key.

2. **Publish the public half** — add it as the `VAPID_PUBLIC_KEY` repository
   secret (or set `vapidPublicKey` in `js/env.js` locally).

3. **Deploy the function** (needs the [Supabase CLI](https://supabase.com/docs/guides/cli)):

   ```bash
   supabase link --project-ref YOUR-PROJECT-REF
   supabase secrets set \
     VAPID_PUBLIC_KEY="BEl..." \
     VAPID_PRIVATE_KEY="xyz..." \
     VAPID_SUBJECT="mailto:it@example.com" \
     PUSH_WEBHOOK_SECRET="$(openssl rand -hex 32)"
   supabase functions deploy send-push
   ```

4. **Trigger it on new notifications.** In the dashboard: *Database → Webhooks →
   Create a new hook*.

   - Table: `notifications`, Events: **Insert**
   - Type: **Supabase Edge Functions** → `send-push`
   - HTTP header: `x-webhook-secret` = the `PUSH_WEBHOOK_SECRET` you generated

5. **Turn it on for the device.** *Admin → Settings → Notifications on this
   device → Turn on notifications*, then *Send a test*.

The permission prompt is never triggered silently — it only appears after that
button is pressed, and the screen explains plainly what is and is not supported
on the current browser.

---

## 14. Reports and exports

*Admin → Reports* generates everything from the historical tables. Nothing is
typed in and nothing is pre-aggregated, so a report always reflects what actually
happened.

Presets: **Today · Yesterday · This week · This month · Custom range**, plus
filters for building, task, priority and request status.

Each report shows totals (requests, completed, still open, urgent, working time,
average completion), requests per day as a bar chart for multi-day ranges, time
by location, time by task, tasks by count, requests by category / building /
priority, the expected-vs-actual comparison, and highlights (most common task,
most active location, busiest day).

Four exports: **Summary CSV**, **Requests CSV**, **Activity CSV** (one row per
activity with planned vs actual minutes and the difference), and **Print / save
PDF**, which uses a print stylesheet that strips the navigation and buttons.

CSVs are UTF-8 with a BOM and CRLF line endings, so Excel opens them correctly
without an import wizard.

---

## 15. Day-to-day admin

**Adding a building or task.** *Admin → Buildings* (or *Tasks*) → type the name →
**Add**. Reorder with the ▲▼ arrows; that order is what the dropdowns use.

**Retiring one.** Press **Disable**. It disappears from the menus but stays in
every past report. Deleting is deliberately impossible.

**Renaming one.** Press **Edit**. Historical rows keep a frozen
`*_name_snapshot`, so old reports do not silently change under you.

**A one-off place or job.** Choose **+ Other / custom** in the dropdown and type
it. It is recorded on that activity only and is *not* added to the permanent
lists — exactly right for "Science Laboratory, just this once".

**Users.** *Admin → Users* to search, deactivate (they can no longer sign in;
their history is kept) or change a role.

**Making the board private.** *Admin → Settings → Show the board without signing
in*. Turning it off is enforced by the RLS policies, not just by hiding the page.

---

## 16. Troubleshooting

**"Almost ready" / setup screen.** `js/env.js` is missing or still has
placeholders. Locally: copy `env.example.js`. On Pages: check both repository
secrets and re-run the workflow.

**"That e-mail and password do not match an account."** If confirmation e-mails
are enabled, the account must be confirmed first. You can confirm a user manually
in *Authentication → Users*.

**Signed in but the admin console bounces to the board.** That account's role is
still `employee`. Run the promote query in [section 6](#6-setup--the-first-administrator).

**Board loads but stays empty for signed-out visitors.** `public_dashboard` is
off. Turn it on in *Admin → Settings*, or check:

```sql
select * from public.app_settings where key = 'public_dashboard';
```

**Updates do not appear without a refresh.** Realtime is not receiving. Check
*Database → Replication* and confirm the tables are in the `supabase_realtime`
publication — re-running `sql/schema.sql` restores that. Corporate networks that
block WebSockets will also cause this.

**"You do not have permission to do that."** RLS is doing its job. Confirm the
role, and that `sql/rls.sql` was run *after* `sql/functions.sql`.

**Password reset links go nowhere.** Add your site address to Supabase
*Authentication → URL Configuration → Redirect URLs*.

**An old version keeps loading.** The service worker caches the shell. Close all
tabs and reopen, or clear site data. Bumping `VERSION` in `service-worker.js`
forces every device to refresh on the next visit.

**Push never arrives.** Work down the list: is `VAPID_PUBLIC_KEY` published; is
the function deployed; does the webhook exist with the right header; on iOS, was
the app added to the Home Screen first; is the site's notification permission
granted? *Settings → Notifications* reports which of these is the blocker.

---

## 17. Known limitations

Stated plainly, because a tool you trust is one that does not overclaim.

- **Push requires the Edge Function.** GitHub Pages cannot sign or send push
  messages. Without the function you get in-app alerts only.
- **iOS requires installation.** Safari delivers Web Push only to an app added to
  the Home Screen. The app detects this and says so rather than showing a prompt
  that cannot succeed.
- **One tracked person.** The schema already has `user_id` on status rows and
  `assigned_to` on requests, so a second technician is a UI change rather than a
  migration — but the current screens assume one.
- **Reports aggregate in the browser.** Fine at this scale (one technician, a few
  dozen requests a day, a few thousand rows a month). A year-long report across
  many technicians would want SQL aggregation instead.
- **Actual time depends on Haitham updating.** If he forgets for two hours, that
  activity counts two hours. The app nudges when a status expires; it never
  invents an end time, because a guess in a report is worse than a gap.

---

## Licence

Internal tool — use it, change it, deploy it.
