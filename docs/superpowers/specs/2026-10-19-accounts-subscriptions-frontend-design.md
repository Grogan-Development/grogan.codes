# Accounts & Subscriptions — Frontend Design

Date: 2026-10-19
Status: Approved design, awaiting spec review
Scope: Disconnected Leptos frontend in this repo (`apps/ui`, `crates/api-types`) only.
Out of bounds: `~/Repos/Loom` (untouched), any backend, any real payment provider.

## 1. Purpose

Map and build the account/subscription surface of Grogan Code as a disconnected
frontend on mock data, the same way the existing screens (inbox, repos, change
requests, builds, search) were built. When the backend arrives, these screens
should only need a real `Platform` implementation behind them, not a redesign.

Today `/settings` is a `NotBuilt` placeholder (wireframe board `M16 · D-Account`)
and `/settings/ai` is the only real settings screen. `Org.plan` and `OrgRole`
exist in `crates/api-types` but nothing in the UI reads them.

## 2. Pricing model (the three axes are separate)

1. **Personal accounts are free.** A personal tenant never has a payment method,
   a flat fee, or an invoice.
2. **Organisations pay a flat fee per org, regardless of seats.** There is one
   Org plan. Seats never appear in pricing, plan comparison, or upgrade copy;
   members can be added without any per-seat wording anywhere in the UI.
3. **Usage is metered on top.** Compute, build minutes, storage, and graph
   compute are usage. The Org flat fee includes an allowance per meter;
   consumption past the allowance is overage billed at a per-unit rate.
   Personal usage is shown against a free allowance with no charge and no
   projected bill.

AI is never part of the subscription: it stays bring-your-own (Claude Code
login, Codex, or the user's API key) as already designed in `/settings/ai`.

## 3. Approach

One settings shell that follows the tenant switcher (existing `ActiveOrg`
context in the top bar). The personal account is a tenant in the switcher,
alongside orgs (GitHub-style). The settings side nav changes with:

- the active tenant's plan (Personal vs Org), and
- the signed-in user's role in that tenant (`Owner` / `Admin` / `Member`).

Rejected alternatives: separate `/account/*` vs `/orgs/:slug/settings/*` areas
(duplicates profile and AI screens, fights the existing switcher model), and a
single long settings page (billing, usage, and members outgrow it).

## 4. Routes

`/settings` becomes a `ParentRoute` with a `SettingsLayout` (side nav +
`Outlet`), replacing the `NotBuilt` placeholder. Existing `/settings/ai` keeps
working under the same layout.

| Route | Screen | Visible when |
| --- | --- | --- |
| `/settings` | Overview | Always |
| `/settings/profile` | Profile / org details | Always |
| `/settings/members` | Members & roles | Org tenant; personal sees a create-org card |
| `/settings/billing` | Plan & billing | Org tenant, `Owner`/`Admin` only |
| `/settings/usage` | Usage & allowances | Always |
| `/settings/ai` | AI connections (existing) | Always |

Navigation rules:

- The settings header shows the active tenant name, a plan badge
  (`Personal` or `Org`), and the user's role badge.
- `Billing` is omitted from the side nav for `Member`s. Navigating to it
  directly as a `Member` renders a "Owner or Admin required" state in place of
  the screen (client-side design gate only; a real backend must enforce this
  server-side later — that enforcement is not part of this frontend work).
- Switching the tenant in the top bar re-renders the settings screens for the
  new tenant, via the same `LocalResource` pattern the existing screens use.

## 5. Screens

### 5.1 Overview (`/settings`)

- Signed-in user (name, handle), active tenant, plan, role.
- Plan card: for Personal, "Personal — Free" and what that includes; for an
  Org, the flat fee, renewal date, and subscription status.
- Usage summary: the meter closest to (or over) its allowance, linking to
  `/settings/usage`.
- Shortcuts to members, billing (when permitted), and AI connections.

### 5.2 Profile (`/settings/profile`)

- A "You" card, in both tenant contexts: the signed-in user's name, handle,
  email, and sign-in methods (passkey, Google, GitHub — display only, matching
  the login screen).
- A "Tenant" card below it: for a personal tenant, the tenant name/slug and
  the free plan; for an org, the org name, slug, plan, and the user's role.
  User identity and tenant identity are separate cards, never one merged form.

### 5.3 Members (`/settings/members`)

- Org tenant: member list with handle, name, role, and joined date; pending
  invites listed separately. Invite and role-change controls render in their
  final visual state for `Owner`/`Admin` and are hidden for `Member`s. As with
  the existing "Add API key" button, controls are inert in the disconnected
  frontend — they exist so the layout and states can be reviewed.
- No seat counts, seat limits, or per-seat pricing anywhere on this screen.
- Personal tenant: no members concept. The screen is a single card explaining
  that collaboration needs an organisation, with a "Create an organisation"
  call to action (inert; org creation is out of scope).

### 5.4 Plan & billing (`/settings/billing`)

Org tenant, `Owner`/`Admin` only:

- Current plan card: the single Org plan, flat fee per period, what the
  included allowances are, renewal date, subscription status.
- Payment method placeholder card (brand + last digits from mock data).
- Invoices: date, amount, status (`Paid` / `Open`), most recent first.
- If subscription status is not `Active`, a banner states the status
  (e.g. past due) above the plan card. Mock data uses `Active`; the banner
  exists in the design for the other states.
- No plan picker, tier comparison, upgrade/downgrade, or cancellation flow:
  there is one Org plan, and lifecycle flows are out of scope.

Personal tenant: this route is not in the nav. Direct navigation shows the
"Personal — Free" plan card and the create-org call to action instead of any
billing content. A personal tenant never sees payment or invoice UI.

### 5.5 Usage (`/settings/usage`)

Visible to everyone, including org `Member`s, so people can see the cost
consequences of their work:

- One meter per usage kind: build minutes, compute, storage, graph compute.
  Each shows used amount, included allowance, unit, and a usage bar.
- Org tenant: usage past an allowance is marked as overage with the per-unit
  rate and the projected overage charge for the current period; the screen
  totals the projected overage.
- Personal tenant: the same meters against the free allowance, marked "over
  free allowance" when past it, with no rates, no charges, and no totals.
- Period label (current billing period for orgs, current month for personal).

### 5.6 AI connections (`/settings/ai`)

Unchanged content, moved under the settings layout. It stays per-user in both
tenant contexts and is never presented as org-billed, because model access is
bring-your-own.

## 6. Types (`crates/api-types`)

- `Plan::Team` is renamed to `Plan::Org`. `Plan` stays `Personal | Org`;
  deleting `Team` is safe because nothing outside the mock reads it yet.
- New types:
  - `SubscriptionStatus`: `Active`, `PastDue`, `Cancelled`.
  - `Subscription`: org slug, status, period start/end labels, flat fee
    (cents), and the payment method summary (`card_brand`, `last4`).
  - `UsageKind`: `BuildMinutes`, `Compute`, `Storage`, `GraphCompute`.
  - `UsageMeter`: kind, used, included allowance, unit label, overage rate
    (cents per unit, `0` for personal tenants).
  - `Invoice`: id, date label, amount (cents), status (`Paid` / `Open`).
  - `Billing`: a `Subscription` plus its `Vec<Invoice>`.
  - `Member`: `User`, `OrgRole`, joined label.
  - `Invite`: email, `OrgRole`, sent label.
  - `Members`: `Vec<Member>` plus `Vec<Invite>` (one struct, matching how
    `RepoHome` and `SearchResults` bundle a screen's payload).
- Money is integer cents; amounts are formatted in the UI, never stored as
  floats or pre-formatted strings. Fixture amounts are illustrative layout
  values carried by the mock, not pricing decisions; the mock preview bar
  already labels all data as mock.
- All new types follow the existing rules for this crate: serde-derived,
  WASM-safe, no I/O or clocks (dates arrive as display labels, as elsewhere).

## 7. Platform trait and mock

`Platform` gains three methods, implemented by `MockPlatform` with the same
140 ms simulated latency as the existing methods:

- `members(org) -> Result<Members, ApiError>`
- `billing(org) -> Result<Billing, ApiError>` — returns
  `ApiError::NotFound` for a personal tenant, which the UI never requests
  because the route is gated before the call.
- `usage(org) -> Result<Vec<UsageMeter>, ApiError>`

The Overview screen composes the existing `session()` with `usage()`, and
with `billing()` for org tenants only; it introduces no method of its own.

Fixtures:

- `zack` (Personal, user is `Owner`): free allowance meters, one close to its
  allowance; no billing, no members.
- `grogan-dev` (Org, user is `Admin`): active subscription, payment method,
  three invoices, a member list covering all three roles plus one pending
  invite, and four usage meters with storage deliberately over its allowance
  so the overage state renders.
- The existing two tenants are kept; no third tenant is added. `Member`-role
  gating is therefore implemented and code-reviewed but not exercised by the
  fixtures (the user is `Owner`/`Admin` in both tenants).

## 8. Components and files

- New `apps/ui/src/pages/settings.rs`: `SettingsLayout`, `SettingsOverview`,
  `Profile`, `Members`, `Billing`, `Usage`. `AiSettings` stays in `home.rs`
  and is routed under the layout.
- `apps/ui/src/pages/mod.rs` exports the new components.
- `apps/ui/src/app.rs`: `/settings` placeholder route replaced by the nested
  settings routes; top-bar avatar link target unchanged (`/settings`).
- `apps/ui/src/components.rs`: reuse `load()`/`Loading`/`ErrorState`; add a
  small usage-meter component next to the existing badge components. Meter
  widths use the `style:width` directive pattern already established for CSP
  compatibility.
- `apps/ui/style/app.css`: settings two-column layout (side nav + content),
  plan/invoice/meter styling in the existing paper-and-ink palette; side nav
  collapses to a horizontal strip under the mobile preview width.
- `README.md`: no change needed beyond what already describes the frontend;
  the pricing model is recorded in this spec, not the README.

## 9. States and error handling

- Loading and error states reuse the shared `load()` helper (spinner text and
  retry-less error message with the `ApiError` display text), consistent with
  every other screen.
- Empty states: an org with no invites shows no invites section; an org with
  no invoices shows "No invoices yet."
- Permission states are explicit screens (Section 4), never blank pages.
- Long names, emails, and handles must not overflow rows (existing list-row
  patterns apply); meters clamp at 100% width while still showing the true
  used figure as text.

## 10. Out of scope

Signup, onboarding, org creation, checkout or any payment-provider
integration, plan changes, cancellation, trials, seat-based anything, tax or
address forms, tokens/security screens (wireframe `D-Tokens`), repo settings,
and all backend/API work. Nothing in `~/Repos/Loom` is read or modified.

## 11. Verification

- `cargo fmt --all --check`
- `cargo clippy --target wasm32-unknown-unknown --workspace --all-targets`
  (workspace lints deny `unwrap`/`expect` and unsafe code)
- `trunk build --release` in `apps/ui`
- Browser check of every settings route under both tenants (`zack` personal
  and `grogan-dev` org), confirming: nav differences, the storage overage
  state, the personal create-org cards, and the existing `/settings/ai`
  screen under the new layout. Also spot-check the iOS preview width for the
  collapsed settings nav.
