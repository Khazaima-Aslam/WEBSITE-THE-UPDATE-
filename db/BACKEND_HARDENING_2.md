# CKA BuildStruct — Backend Hardening 2

Verified against live Supabase project `qrjglihvjhhemqoegqmt` on 5 September 2026.

## What this tranche adds

- Last-administrator protection: the final `admin` profile cannot be demoted or deleted.
- Safe supplier account onboarding: admin/staff logins cannot be repurposed as supplier accounts; only verified suppliers can be linked; explicit unlink/recovery RPC added.
- Staff assignment integrity for quotes/projects.
- Enforced quote and project lifecycle transitions at trigger level.
- Project completion automatically sets progress to 100%.
- Financial constraints for quote item prices, quote subtotals and project budgets.
- Quote subtotal is recalculated from generated line totals after any line-item mutation.
- Supplier/profile role/link consistency is validated at transaction commit.
- Durable in-app notifications and external-delivery outbox.
- Realtime publication for `user_notifications`.
- Guest quote/project tracking using reference + phone with abuse throttling.
- Authenticated customers can claim prior guest quotes/projects into their account.
- Exact duplicate public submissions are idempotent for quotes, projects, inquiries and supplier applications.
- Project Storage object metadata is unique per bucket/path.
- Future `public` tables automatically receive RLS via an event trigger.
- Staff backend health and manual ephemera-maintenance RPCs.
- Service-role-only outbox worker RPCs with `FOR UPDATE SKIP LOCKED`, sent/failed acknowledgement and retry scheduling.
- `pg_cron` scheduled cleanup for short-lived tracking/idempotency data and Cron history. Business records and audit history are never auto-deleted.

## Cron jobs

- `cka-backend-ephemera-cleanup` — daily at `03:17` UTC.
- `cka-cron-history-cleanup` — Sundays at `03:37` UTC; removes Cron run history older than 30 days only.

## Worker contract

The browser must never call these functions. They are granted only to `service_role` for a future Edge Function or trusted notification worker:

- `system_claim_outbox_batch(limit)`
- `system_mark_outbox_sent(outbox_id)`
- `system_mark_outbox_failed(outbox_id, error, retry_seconds)`

No provider secret or service-role credential is stored in repository browser code.

## Browser/backend contract additions

`assets/js/backend-api.js` now exposes:

- `CKABackend.public.trackQuote()` / `trackProject()`
- `CKABackend.customer.claimQuote()` / `claimProject()`
- `CKABackend.notifications.list()` / `markRead()` / `subscribe()`
- `CKABackend.staff.health()` / `runMaintenance()`
- `CKABackend.staff.quotes.assign()` / `projects.assign()`
- `CKABackend.staff.suppliers.unlinkAccount()`
- `CKABackend.staff.outbox.summary()` / `list()`

Authorization remains entirely in PostgreSQL grants, RLS and RPC checks.

## Live QA performed with transaction rollback

- Final admin demotion was blocked and administrator count remained `1`.
- Admin account could not be converted into a supplier account.
- Invalid quote/project backward transitions were blocked; valid progressions succeeded.
- Completed project progress became `100`.
- Quote subtotal changed `20 -> 30 -> 0` as line items were inserted, updated and deleted.
- Signed-in/guest notification events created expected in-app/outbox records without sending external messages.
- Anonymous guest tracking worked; quote/project claiming linked both records to a disposable customer and produced two claim notifications.
- Duplicate quote, project, inquiry and supplier application calls produced one business row each and one reference where applicable.
- Outbox worker leased disposable rows once and correctly acknowledged one `sent` and one `failed` job.
- Final QA-leftover check: zero QA quotes, projects, inquiries, supplier applications, outbox rows and auth users; catalogue remained `89` rows.

## Current advisor state

Supabase Database Advisor after all migrations:

- Security: only the project-level Auth setting **Leaked Password Protection Disabled** remains. This setting is not exposed through the available SQL connector and must be enabled in Supabase Auth settings.
- Performance: only `unused_index` informational notices remain; there are no warning-level policy/index findings.

## Recommendation from here

The database/backend architecture should now be treated as stable. Further work should consume these APIs in the admin/customer/supplier UI, configure the real external notification provider behind the outbox worker, enable leaked-password protection in Auth, and add a local Supabase project/pgTAP CI setup only after the repository is initialized for reproducible local database testing.
