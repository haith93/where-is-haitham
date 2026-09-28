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
| 6 | `migration-push-trigger.sql` | **Optional.** Calls the send-push function. Edit section 3 first |

The order matters: 2 adds columns that 3 writes to, and 3 redefines a
function that 2 created.

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

Every row should read `OK`. Number 6 is optional and may read `NOT RUN`
without anything being wrong.

## If everything reads OK but the app disagrees

PostgREST caches its view of the schema. Nudge it:

```sql
notify pgrst, 'reload schema';
```
