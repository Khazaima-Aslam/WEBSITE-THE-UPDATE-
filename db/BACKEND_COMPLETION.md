# CKA BuildStruct — Backend Completion

**Production backend:** Supabase project `qrjglihvjhhemqoegqmt`  
**Database:** PostgreSQL 17  
**Backend source of truth:** `db/migrations/` + live Supabase migration history  
**Browser data layer:** `assets/js/store.js`  
**Operational client facade:** `assets/js/backend-api.js`

This document describes the backend state verified on 5 September 2026. `db/schema.sql` is the historical base schema; the ordered migration files are the canonical production evolution and must be applied after that base when recreating the environment.

## Production data verified

- 89 active catalogue products.
- 18 categories.
- 89 `product_images` rows.
- 29 suppliers, of which 15 are currently verified.
- `project-uploads` remains private for customer/BOQ files.
- `product-images` is the public catalogue-image bucket.
- No supplier login is linked yet; supplier account linking is intentionally an admin onboarding action.

## Public website backend

The public website uses named RPC endpoints rather than direct writes to sensitive operational tables:

- `submit_quote(...)`
- `submit_project(...)`
- `submit_project_with_file(...)`
- `submit_inquiry(...)`
- `submit_supplier_application(...)`
- `subscribe_rate_list(...)`

The public function names are `SECURITY INVOKER` wrappers. Their validated privileged implementations live in the non-exposed `private` schema. Anonymous callers have only explicit `EXECUTE` rights on these endpoints and `SELECT` rights on the public catalogue/content surfaces.

`v_catalogue` is a `security_invoker` view and was verified anonymously with 89 rows and zero missing main images.

## Catalogue administration

Staff/admin RLS supports product/category/image/variant management. Product images are separated from private project uploads. Image cleanup checks live database references before deletion and never sends arbitrary external URLs to Storage deletion.

The data model uses:

- `products.image_url` as the canonical main image.
- `product_images` as optional gallery images.
- `products.specifications` JSONB for flexible grade/size/badge attributes.
- PostgreSQL stock/quality enums rather than UI labels.

## Staff operational workflows

Authenticated `admin`/`staff` users can use the following RPCs:

- `staff_dashboard_summary()` — work-queue counts.
- `staff_update_quote(...)` — quote status, assignment and internal notes.
- `staff_update_project(...)` — status, progress, assignment and notes.
- `staff_set_inquiry_handled(...)` — handled/unhandled state with handler/time.
- `staff_review_supplier_application(...)` — under-review/approve/reject. Approval creates or links a supplier record but does **not** automatically verify it.
- `staff_set_supplier_verification(...)` — verification state and reliability score.
- `staff_award_bid(...)` — one atomic winner per quote and quote confirmation.
- `admin_link_supplier_account(...)` — admin-only supplier login linking.

Staff can read `admin_audit_log`; there is no client mutation privilege on this table.

## Audit trail

`admin_audit_log` captures INSERT/UPDATE/DELETE state changes for:

- products
- categories
- suppliers
- quotes
- projects
- supplier bids
- supplier applications
- inquiries
- newsletter subscribers

The audit trigger runs server-side. During transactional QA, the operational workflow produced nine audit events and the entire QA transaction was then rolled back.

## Supplier portal backend

A supplier account becomes operational only after all of these are true:

1. The supplier has a Supabase Auth/profile account.
2. An administrator links that profile with `admin_link_supplier_account`.
3. The profile role is `supplier`.
4. The supplier record is verified.

Verified suppliers can:

- Read/update their own supplier contact row, while server-side triggers protect verification/reliability trust fields.
- Call `supplier_open_tenders()` to receive a sanitized bidding feed.
- Call `supplier_submit_bid(...)` only for quotes whose status is `bidding`.
- Read their own bid history through RLS.

The tender feed deliberately does not include customer name, phone, email or delivery address. It exposes reference, city, date, item names/units/quantities and bid count.

## Customer portal backend

Authenticated customers inherit ownership through `customer_id` RLS on quotes/projects. Available backend operations include:

- `customer_portal_summary()`
- own `quotes` reads
- own `quote_items` reads
- own `projects` reads
- own allowed `project_files` reads

The summary was transaction-tested with one owned quote and one owned project and returned the expected totals/open counts.

## Realtime

The following operational tables are published to `supabase_realtime`:

- `quotes`
- `projects`
- `supplier_bids`

RLS remains the authorization layer for Realtime consumers.

## Least-privilege Data API

The backend no longer relies on Supabase's historical broad default table grants.

Anonymous role:

- `SELECT` only on catalogue/content surfaces.
- Explicit `EXECUTE` only on validated public submission RPCs.
- No table `INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES` privileges.

Authenticated role:

- Explicit ordinary CRUD grants only where required.
- Every exposed table has RLS enabled.
- Role/ownership policies determine the rows/actions actually available.

New public tables/functions receive no automatic anon/authenticated privileges through PostgreSQL default privileges; future migrations must grant what they need explicitly.

## Storage

### `product-images`

- Public read.
- Staff-managed writes/deletes.
- Image MIME types only.

### `project-uploads`

- Private bucket.
- 10 MB limit.
- Supports project/BOQ document MIME types used by the website.
- Public uploads are restricted to the project submission path; signed-in ownership/staff policies cover authenticated access.
- `project_files` requires exactly one parent: project **or** quote.

## Frontend integration contract

Load `assets/js/store.js` first, then `assets/js/backend-api.js` on pages that need operational APIs.

Available global:

```js
CKABackend.staff.summary()
CKABackend.staff.quotes.list()
CKABackend.staff.quotes.update(id, changes)
CKABackend.staff.projects.update(id, changes)
CKABackend.staff.inquiries.setHandled(id, true)
CKABackend.staff.supplierApplications.review(id, "approved", notes)
CKABackend.staff.suppliers.setVerification(id, true, 95, notes)
CKABackend.staff.suppliers.linkAccount(supplierId, profileId)
CKABackend.staff.bids.award(bidId)
CKABackend.staff.audit.list()

CKABackend.supplier.tenders()
CKABackend.supplier.submitBid(quoteId, rate, deliveryDays, terms)
CKABackend.customer.summary()
```

The facade intentionally does not contain role checks or service credentials. Authorization belongs to database grants/RLS/RPCs.

## Verification completed

The production backend was tested using rollback transactions so QA records were not left behind.

Verified:

- Anonymous catalogue: 89 rows, zero missing images.
- Anonymous inquiry submission.
- Anonymous newsletter subscription.
- Anonymous quotation submission.
- Anonymous project submission.
- Anonymous supplier application.
- Staff quote/project status workflows.
- Inquiry handling.
- Supplier application approval.
- Supplier verification workflow.
- Single-winner bid award.
- Audit log creation.
- Supplier account linking after fixing the detected RLS ordering issue.
- Sanitized supplier tender access.
- Verified supplier bid submission.
- Customer ownership summary.
- All QA rows were confirmed absent after rollback.

## Supabase advisors after completion

**Security:** all SQL/RLS/view/function/extension warnings introduced by the application have been cleared. The only remaining security advisor item is the project-level Supabase Auth setting **Leaked Password Protection Disabled**. This is an Auth configuration setting, not a schema migration.

**Performance:** no remaining warning-level findings. Current notices are only unused-index informational items; these indexes are retained because this is a new/low-traffic backend and many are integrity/foreign-key/work-queue indexes that should not be removed merely because their usage counter is currently zero.

## Remaining product work (not backend blockers)

- Build the visual staff operations dashboard on top of `CKABackend.staff`.
- Build supplier login/portal UI and onboard supplier Auth accounts.
- Build customer account/portal UI.
- Enable Supabase Auth leaked-password protection in project Auth settings.
- Add payment-provider integration only when the commercial/payment flow is defined; the current backend records payment preference but does not process money.
- Add email/WhatsApp notification delivery when provider credentials and templates are approved.

The core application backend, authorization model, workflow database, public submission APIs, audit trail, supplier bidding backend, customer ownership backend, Storage separation and Realtime publication are production-ready and represented by migrations in this repository.
