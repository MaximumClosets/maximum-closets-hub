# Maximum Closets Hub

Internal business app for **Maximum Closets** (James, james@maximumclosets.com) — a closet
installation business. Single-file PWA (`index.html` + `manifest.json` + `icons/`), no
backend/build step; state persists to `localStorage`, no internet required.

## What the app tracks per job

Each job card carries:
- **Customer info**: name, phone, email, address, date visited, job source (referral,
  Google, Instagram, Facebook, repeat customer, other)
- **Pipeline stage**: Lead/Customer → Measure/Consult → Estimate Sent → Deposit Paid →
  Install Scheduled → Install → Done
- **Labels**: New Lead, Need Plans Sent, Follow Up Soon, Final Payment Received,
  Needs go back (design revisions), In Progress, Final Payment Due
- **Design ideas / notes**: free-text notes field per job; design drafted externally in KCD
- **Pricing**: pricing calculator tab per job, with configurable pricing defaults
  (Settings ⚙️), used to generate estimates
- **Proposal**: auto-generated from pricing data, can be emailed via Gmail
- **Checklist**: stage-based checklist items, including materials handling —
  "Order materials" (after deposit) and "Confirm materials are ready" (before install)
- **Scheduled tasks**: Measure, Install, Cut Job, Client Meeting, Drawing, Other — dates
  sync to Google Calendar

## Stage checklist reference (from `CHECKLISTS` in index.html)

0. New Lead — get name/phone/email, understand scope, schedule measure/consult
1. Measure & Design — measure + photos, note preferences, draft design in KCD, price job,
   send estimate
2. Estimate Follow-Up — follow up in 3 days, handle revisions, get approval, request deposit
3. Deposit Received — confirm deposit, **order materials**, confirm install date on
   Google Calendar
4. Install Prep — confirm date, confirm Miguel's availability, confirm materials ready,
   send client reminder 2 days out
5. Install Day — materials prepped/loaded, install complete, client sign-off, final
   payment, ask for review

## People

- **James** (james@maximumclosets.com) — owner
- **Miguel** — installer, availability confirmed before each install
