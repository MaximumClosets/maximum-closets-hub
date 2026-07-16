# Maximum Closets Hub — Apps Script backend

`Code.gs` is the bridge between the static Hub page (`index.html`) and Google
Drive/Sheets. It has to run as James's own Google account (a static HTML page
has no server of its own to hold real Drive/Sheets credentials), which is why
it's a script he deploys himself rather than something Claude can run directly.

Full setup steps are in the comment block at the top of `Code.gs`. Short version:

1. https://script.google.com → New project → paste in `Code.gs`.
2. Run `runReorg` once from the editor (authorize when prompted). `DRY_RUN`
   starts `true`, so this only writes a plan to the **Migration Log** tab in
   the [Job Data sheet](https://docs.google.com/spreadsheets/d/1bA4oWF9-oQ6V4FzvNyYQ0IQhmIDI9vETtRLALen0mKE) —
   nothing moves yet.
3. Review the Migration Log. If a customer name got parsed wrong, add a
   correction row to the **Manual Overrides** tab (also auto-created) —
   file ID or exact file name → correct customer path.
4. Flip `DRY_RUN` to `false`, save, run `runReorg` again. It's safe to just
   re-run it repeatedly (or put it on a time trigger) — it skips anything
   already logged as moved, so a 1,500+ file migration that can't finish in
   one ~6-minute Apps Script execution just picks up where it left off.
5. Deploy ▸ New deployment ▸ Web app ▸ Execute as "Me" ▸ deploy.
6. Paste the resulting Web app URL into the Hub's Settings panel
   (⚙️ → "Backend Script URL").

## What it does NOT do automatically

- **Delete anything**, except the specific empty/junk folders from the audit,
  and only when `DELETE_EMPTY_JUNK` is explicitly set to `true`.
- **Touch `1_PDF_MAX`'s nested duplicate-mirror subfolder.** That one's
  flagged in the audit as a likely stale copy of the parent folder — worth a
  manual look before trashing it yourself.
- **Guess perfectly.** Filenames in the source drive are inconsistent enough
  (no separators, typos, one name covering 9 different addresses) that some
  parsed customer names will be wrong. That's what the Migration Log +
  Manual Overrides tabs are for — fix and re-run rather than trusting the
  first pass blindly.
