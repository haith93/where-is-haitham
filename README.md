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
3. [The design system](#3-the-design-system)
4. [Print requests](#4-print-requests)
5. [Tech stack](#5-tech-stack)
6. [Folder structure](#6-folder-structure)
7. [Setup — Supabase](#7-setup--supabase)
8. [Setup — the first administrator](#8-setup--the-first-administrator)
9. [Setup — running it locally](#9-setup--running-it-locally)
10. [Deploying to GitHub Pages](#10-deploying-to-github-pages)
11. [Security model](#11-security-model)
12. [How time is handled](#12-how-time-is-handled)
13. [Realtime](#13-realtime)
14. [PWA / installing on a phone](#14-pwa--installing-on-a-phone)
15. [Push notifications](#15-push-notifications)
16. [Reports and exports](#16-reports-and-exports)
17. [Day-to-day admin](#17-day-to-day-admin)
18. [Troubleshooting](#18-troubleshooting)
19. [Known limitations](#19-known-limitations)

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

## 3. The design system

The interface is **neo-brutalist / retro-tech**: ink borders you cannot
miss, hard offset shadows with no blur, flat fills, square corners, and
controls that physically move onto their own shadow when pressed. Yellow
is the action colour; green, blue, amber, orange and red carry meaning
and nothing else.

`css/tokens.css` is the only file that decides any of this. Everything
else spends its tokens and invents no hex code, border width or shadow of
its own, so retuning the system is one file:

| Token group | Controls |
|---|---|
| `--bd`, `--bd-thin`, `--bd-hair` | How heavy every edge in the app is |
| `--sh-1/2/3`, `--sh-dir` | Shadow depth, and which way shadows fall |
| `--press`, `--press-deep` | How far a control travels when pressed |
| `--s-1` … `--s-7` | The whole spacing scale |
| `--t-display` … `--t-meta` | The type scale |
| `--accent`, `--secondary` | Brand and action colour |
| `--ok`, `--info`, `--warn`, `--urgent`, `--danger` | Meaning, as **text** |
| `--ok-fill`, `--info-fill`, … | The same meanings as **fills** |

Two details worth knowing before you change anything:

**Every tone has a text value and a fill value.** A 13px label on a pale
ground needs a dark, low-chroma colour. A 14px stripe sitting against a
3px ink border needs the opposite — if it is as dark as the ink, it just
reads as a thicker border and the signal disappears. Pick whichever one
matches the job.

**Shadow direction flips once.** `--sh-dir` is `1`, or `-1` under
`:root[dir='rtl']`, and every shadow and press animation is built from
it with `calc()`. That is why Arabic mirrors correctly without a single
RTL override anywhere in the component sheets.

Status colour is never the only signal: every badge prints its own words,
so the board still works for a colour-blind reader and in a photocopy.

### The four urgency levels

| Level | Shown as | Meaning |
|---|---|---|
| `normal` | Normal | Whenever he gets to it |
| `urgent` | Urgent | Today, please |
| `very_urgent` | Very urgent | This is stopping work right now |
| `life_death` | **Life & death** | Everything else waits |

The fourth exists because three stopped discriminating. Once "very
urgent" was the top of the scale, everything that genuinely stopped work
got filed there, and the real emergencies were buried among the merely
annoying ones.

`life_death` is the one thing in the entire interface drawn as solid ink
rather than coloured text on a pale ground — the `--critical` tone. That
treatment is deliberately reserved: if a second thing ever uses it, it
stops meaning anything.

Adding a fifth level would mean: a row in `PRIORITY_META`
(`js/config.js`), a string in `js/i18n.js`, a radio in the two request
forms, and a migration extending the check constraint and the four
functions that validate, order or count a priority. `sql/migration-life-death.sql`
is the worked example.

### The icon set

`js/icons.js` holds every icon in the application, drawn as inline SVG.
There are no emoji left in the interface and no icon font or sprite to
load.

Emoji were replaced because they were never designed together: Apple,
Google, Samsung and Windows each draw them differently, so the same
screen looked like a different product on every phone in the building,
and none of those drawings had anything to do with a system built on ink
borders and flat fills.

Each icon is a 24×24 box with a 2px outline and one or two solid fills.
The outline is `currentColor`, so an icon takes the ink of whatever it
sits in — black on paper, cream in dark mode, black again on a yellow
button.

Two custom properties make them survive being dropped anywhere:

| Property | What it colours |
|---|---|
| `--ic` | The solid body of the drawing |
| `--ic2` | A cut-out inside that body — a pin's hole, a gear's centre |

Every fill is written `var(--ic, its-own-colour)`. Left alone, an icon
keeps its own palette. On a filled control — a yellow nav tab, a red
badge — one rule in `main.css` sets `--ic` to the paper colour and
`--ic2` back to the ground, and both halves of a two-tone drawing stay
readable. A yellow wrench on a yellow tab would otherwise vanish.

Use them two ways:

```html
<span class="ico" data-icon="pin"></span>   <!-- static markup -->
```
```js
`<p>${icon('pin')} ${esc(location)}</p>`     // inside a template
```

`paintIcons()` fills in every `data-icon` on the page; each controller
calls it once at start-up. An unknown name draws nothing rather than a
broken glyph. Directional drawings — `next`, `walk`, `phone` — are
listed in `FLIPPED` and mirror for Arabic automatically.

### Where the playful lines live

`js/messages.js` holds every informal line in the application — the
urgency quips ("DROP EVERYTHING."), and the availability ones ("In the
office. Coffee mode."), in English and Arabic side by side. Nothing
playful is written anywhere else, so changing the tone of the app is
editing one table rather than grepping render functions.

Most keys hold several lines rather than one. The line shown is chosen
from the moment the status was posted, so it is steady for as long as
that status lasts and different the next time he sets one — it never
changes under a reader's eyes.

The Arabic is written to be funny in Arabic. The two halves of a row say
the same thing; they do not say it the same way.

The joke never replaces the fact. Every quip sits next to the plain
status or urgency label, never instead of it.

---

## 4. Print requests

A second kind of request, beside the existing one. The request sheet has
two tabs: **Ask for help**, which is exactly what it always was, and
**Print something**, which carries a document.

### The privacy rule, and where it is actually enforced

The document must never reach another colleague. That is not a UI
concern, so it is not solved in the UI:

| Layer | What stops a leak |
|---|---|
| Bucket | `print-jobs` is **private**. No policy on `storage.objects` grants `anon` or `authenticated` anything, so no browser can read it directly |
| Table | `print_jobs` holds the filename and path. `anon` has no `select` on it at all, and the admin policy requires `is_admin()` |
| Public board | `build_public_snapshot` — the only thing an anonymous visitor reads — emits a title or nothing. No filename, no path, no size |
| Download | Every link is minted by `print-download` after it has checked the caller. It expires in 60 seconds |

A colleague reading the raw JSON of the public board learns nothing the
board does not already show them.

### Who can open a document

**Haitham, or any administrator** — proven by their Supabase session. The
JWT is verified, then the profile is read with the service role to confirm
the role is still `admin` and the account still active. A token alone is
never taken as proof.

**The person who sent it** — proven by the request's `public_token`, the
same unguessable value that already lets them view and cancel their own
request. It is matched against the request row, so it cannot be pointed at
a different request.

Nobody else. There is no third branch. A storage path is never accepted
from the caller — the path is read from the database *after*
authorisation, so guessing one gains nothing, and "no such request" and
"not yours" return the same 404 so the endpoint cannot be used to discover
which requests exist.

### The school's class structure

Three levels, **Section → Cycle → Grade**, seeded from the school's own
spreadsheet into `public.school_grades`. It is data: next year's structure
is an edit in that table, not a release.

There is no class (A/B/C) level, because the spreadsheet does not contain
one. Adding it later is a column and a fourth dropdown; `js/school.js`
derives each list from the rows rather than hard-coding any of them, so
an impossible combination is never selectable.

The seed reproduces the sheet verbatim, including the rows where a
support (مساند) grade sits under a different section than its neighbours.

### One-time setup

```bash
# A PRIVATE bucket. Not public — the whole design depends on this.
supabase storage create-bucket print-jobs

supabase functions deploy print-upload
supabase functions deploy print-download
```

Both functions use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which
Supabase injects automatically. Neither key ever reaches the frontend.

### Limits

15 MB per file. PDF, Word, Excel, PowerPoint, OpenDocument, RTF, plain
text and common images. The extension is checked *and* the first bytes are
compared against what that extension claims, because an extension is a
claim by the uploader, not a fact.

Colour printing asks whether permission was given. Answering "no" disables
the submit button and says why; the RPC refuses it again server-side,
because a browser can be edited and that one costs money.

---

## 5. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Markup / styling | HTML5, CSS3 with custom properties | No framework to learn or upgrade |
| Design system | Neo-brutalist, defined entirely in `css/tokens.css` | One file decides how everything looks |
| Scripting | Vanilla JavaScript, ES modules | Runs straight from static hosting |
| Backend | Supabase (PostgreSQL) | Database, auth, realtime and RLS in one |
| Charts | Hand-written inline SVG (`js/charts.js`) | No dependency; themeable and printable |
| Hosting | GitHub Pages | Free static hosting; no Node server |

The only third-party code the browser loads is `@supabase/supabase-js`, pinned to
an exact version from jsDelivr.

---

## 6. Folder structure

```
where-is-haitham/
├── index.html              Public / employee board
├── admin.html              Haitham's console (hash-routed sections)
├── staff.html              Administrator sign-in (employees never see it)
├── offline.html            Shown when the network is gone
├── 404.html                GitHub Pages fallback
├── manifest.json           PWA manifest
├── service-worker.js       Offline shell + push delivery
├── .nojekyll               Stops GitHub Pages hiding files
│
├── assets/icons/           App icons (PNG + SVG)
│
├── css/
│   ├── tokens.css          THE design system: colour, geometry, rhythm, type
│   ├── main.css            Reset + the shared component set
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
│   ├── i18n.js             Arabic / English strings and RTL
│   ├── messages.js         Every playful status line, EN + AR, in one table
│   ├── icons.js            The whole icon set, drawn as inline SVG
│   ├── print.js            Print requests: upload, submit, fetch back
│   ├── school.js           The section → cycle → grade cascade
│   ├── dashboard.js        index.html controller
│   ├── admin.js            admin.html controller
│   └── staff.js            staff.html controller
│
├── sql/
│   ├── schema.sql          Tables, indexes, triggers, publication
│   ├── functions.sql       Every write path, as RPCs
│   ├── rls.sql             Policies + grants
│   ├── seed.sql            Settings, buildings, tasks
│   └── migration-public-requests.sql
│                           Public submission + channels (one-time)
│
├── supabase/functions/
│   ├── send-push/          Optional Web Push sender
│   ├── print-upload/       Validates and stores a document (service role)
│   └── print-download/     Authorises, then mints a 60-second signed URL
└── .github/workflows/deploy.yml    Builds env.js and publishes Pages
```

---

## 7. Setup — Supabase

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
   | 5 | `sql/migration-public-requests.sql` | Public requests, channels, no employee login |

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

## 8. Setup — the first administrator

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

### How everybody else asks for help

They don't sign in. At all.

An employee opens the site, taps **Request Haitham**, and fills in four things:
their name, where they are, what they need, and how urgent it is. That is the
whole flow — no account, no password, no access code, no confirmation e-mail.

Submission goes through one narrowly scoped RPC, `create_public_request`.
The `anon` role can execute exactly three functions (read the board, submit a
request, follow/cancel its own request by token) and can read nothing else. It
cannot see the requests table, cannot modify anything, and cannot reach any
administrative function.

Because there is no login there is also no natural rate limit, so the RPC
enforces its own: at most five requests per device per ten minutes, duplicate
suppression on the same person/place/need within three minutes, and a global cap
so a reset device id cannot be used to flood.

Creation returns an unguessable token, kept in that browser's local storage, so
the person can follow their own request under **My requests** — and cancel it —
without an account. The token is what the database checks; local storage is
only a convenience.

### Requests that arrive some other way

Not everyone will use the app. People will still phone, send a WhatsApp message,
or stop Haitham in a corridor.

**Admin → Requests → Record a request** captures those as the same standardised
record, with the channel it arrived by (app, WhatsApp, phone, in person, other)
and an optional note. Tick *I am handling this right now* and it is recorded and
started in one step, moving his status to their location.

Every request therefore lands in the same queue, the same history and the same
reports, however it reached him — and *How requests arrived* in Reports shows
the split.

---

## 9. Setup — running it locally

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

## 10. Deploying to GitHub Pages

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

## 11. Security model

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

## 12. How time is handled

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

## 13. Realtime

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

## 14. PWA / installing on a phone

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

## 15. Push notifications

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

## 16. Reports and exports

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

## 17. Day-to-day admin

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

## 18. Troubleshooting

**"Almost ready" / setup screen.** `js/env.js` is missing or still has
placeholders. Locally: copy `env.example.js`. On Pages: check both repository
secrets and re-run the workflow.

**"That e-mail and password do not match an account."** If confirmation e-mails
are enabled, the account must be confirmed first. You can confirm a user manually
in *Authentication → Users*.

**Signed in but the admin console bounces to the board.** That account's role is
still `employee`. Run the promote query in [section 8](#8-setup--the-first-administrator).

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

## 19. Known limitations

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
