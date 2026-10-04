# Running the SQL

Two situations, and they need different files.

---

## A. Your existing database — run migrations only

Run these in the Supabase SQL editor, **in this order**. Each is safe to
re-run: they use `create or replace`, `add column if not exists`,
`on conflict do nothing`, and guarded `create extension`.

| # | File | What it adds |
|---|---|---|
| 1 | `migration-public-requests.sql` | Anonymous requests, channels, removal of the access-code system |
| 2 | `migration-bilingual-names.sql` | `name_ar` on buildings and tasks, frozen Arabic snapshots |
| 3 | `migration-buildings-and-interruptions.sql` | Real building names; putting a job on hold |
| 4 | `migration-test-cleanup.sql` | Delete one request; clear test data |
| 5 | `migration-edit-request.sql` | Requester can change a pending request |
| 6 | `migration-life-death.sql` | A fourth urgency above "very urgent" |
| 7 | `migration-print-requests.sql` | Print requests, the school's class list, the private document store |
| 8 | `migration-priority-flag.sql` | Flag the urgency instead of overwriting it |
| 9 | `migration-print-multi-file.sql` | Several documents per print request, each with its own settings |
| 10 | `migration-push-trigger.sql` | **Optional.** Calls the send-push function. Edit section 3 first |

Number 9 is the only migration here with an undo: `rollback-print-multi-file.sql`
puts every function it replaced back as it was. Run that, not git, if the
multi-file feature is abandoned - git takes the code back and cannot take
the database back.

There used to be a seventh file, `migration-ui-skin.sql`, which stored a
site-wide interface style. The interface now has one deliberate design
system instead of a choice of skins, so that file is gone and nothing
reads the setting any more. If you already ran it, leave the `ui_skin`
row where it is: it is ignored and harmless.

The order matters: 2 adds columns that 3 writes to, 3 redefines a
function that 2 created, and 7 redefines the public snapshot that 3
and 6 built up.

Migration 7 needs two things doing outside the SQL editor as well — a
private storage bucket and two Edge Functions. See "Print requests"
in the project README.

### Do not re-run the base files here

`schema.sql`, `functions.sql` and `rls.sql` still contain the **earlier**
version of five functions that the migrations have since replaced:

| Function | Replaced by |
|---|---|
| `update_my_status` | 2 — loses the Arabic snapshots |
| `build_public_snapshot` | 2, then 3 — loses Arabic names and paused requests |
| `start_request` | 3 — loses the automatic pause on interruption |
| `get_public_status` | 1 — goes back to consulting a deleted setting |
| `handle_new_user` | 1 — goes back to the anonymous-account flow |

Running one of them would revert those quietly, with no error. If you ever
do, re-run migrations 1 to 5 afterwards to put things back.

---

## B. A brand new Supabase project — base files, then migrations

| # | File |
|---|---|
| 1 | `schema.sql` |
| 2 | `functions.sql` |
| 3 | `rls.sql` |
| 4 | `seed.sql` |
| 5 | then every migration from section A, in order |

`rls.sql` revokes grants that `functions.sql` works around, and `seed.sql`
writes through those policies, so 1–4 cannot be reordered.

---

## Checking what has already been applied

`check-migrations.sql` is read-only and changes nothing. It looks for
something only each migration creates, so the answer does not depend on
remembering what was run:

```sql
-- paste sql/check-migrations.sql
```

Every row should read `OK`. The push trigger is optional and may read `NOT RUN`
without anything being wrong.

## If everything reads OK but the app disagrees

PostgREST caches its view of the schema. Nudge it:

```sql
notify pgrst, 'reload schema';
```
