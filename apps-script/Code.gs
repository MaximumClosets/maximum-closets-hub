/**
 * Maximum Closets Hub — Drive reorg + backend bridge
 * ====================================================
 * Two jobs live in this one script, because both need to run as YOUR
 * Google account (the Hub is a static page with no server of its own):
 *
 *   1. runReorg()  — one-time migration of the shared drive into
 *      /Maximum Closets Jobs/YYYY/MM/Customer-Name/{3Ds,PDFs,Contracts,Other}/
 *      Safe by default: DRY_RUN below starts as true, which only WRITES A
 *      PLAN to the "Migration Log" sheet tab and moves nothing. Review that
 *      log, then flip DRY_RUN to false and run again to actually move files.
 *      Large batches: Apps Script kills any single run after ~6 minutes, so
 *      this function time-boxes itself and is safe to just re-run repeatedly
 *      (or trigger on a timer) until the log shows everything done.
 *
 *   2. doGet(e) / doPost(e) — a small JSON API, deployed as a Web App, that
 *      the Hub (index.html) calls to: list the most recent 3D renders / PDFs
 *      for a customer, and read/write rows in the Job Data sheet.
 *
 * SETUP
 * -----
 *  1. Go to https://script.google.com → New project.
 *  2. Delete the default Code.gs contents, paste this whole file in.
 *  3. Update the CONFIG block below if any IDs changed.
 *  4. Run `runReorg` once from the editor toolbar (function dropdown →
 *     runReorg → Run). First run will ask you to authorize — that's
 *     expected, it needs Drive + Sheets access under your account.
 *  5. Open the Job Data sheet, check the new "Migration Log" tab. Review it.
 *  6. When it looks right, set DRY_RUN = false below, save, run again.
 *     Keep running it (it picks up where it left off) until the log's
 *     "Remaining" count in the toast/log hits 0.
 *  7. Deploy ▸ New deployment ▸ type "Web app" ▸ Execute as "Me" ▸
 *     Who has access "Only myself" (or "Anyone with the link" if you want
 *     the Hub reachable without you being logged in) ▸ Deploy.
 *  8. Copy the Web app URL, paste it into the Hub's Settings panel
 *     (⚙️ → "Backend Script URL").
 */

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────
const CONFIG = {
  DRIVE_ROOT_ID: '0ACfFVWmN5VhLUk9PVA',       // Maximum Closets shared drive
  JOB_DATA_SHEET_ID: '1bA4oWF9-oQ6V4FzvNyYQ0IQhmIDI9vETtRLALen0mKE',
  JOBS_ROOT_NAME: 'Maximum Closets Jobs',
  ARCHIVE_FOLDER_NAME: '_Archive',             // where non-job ops files (Maximum Pipe, inventory sheets) land
  DRY_RUN: false,                              // flipped false 2026-07-18 — tested clean all day, existing time trigger can now do real moves
  DELETE_EMPTY_JUNK: false,                    // flip true to actually delete the empty/junk folders the audit flagged
  MAX_RUNTIME_MS: 5 * 60 * 1000,               // stop this invocation before Apps Script's ~6min hard limit
  OLD_CUTOFF_MONTHS: 18,                       // files older than this (by modified date) are left exactly where they are, not organized
  MAX_3DS_PER_CUSTOMER: 5,                     // only migrate the N most recent 3D renders per customer; the rest stay in 1_3Ds_MAX untouched
  CONSOLIDATE_DRY_RUN: false,                  // flipped false 2026-07-18 — dry run confirmed clean (708 groups, 0 errors) twice in a row
};

// Folders that are 100% empty or junk per the audit — only acted on when DELETE_EMPTY_JUNK=true.
const JUNK_FOLDER_IDS = [
  '1RsYbaw99k8CZ5NbwRJsM3MNRPX6T4ZgK', // Receipts (new, empty, created 7/11/26)
  '1gJ0j3uy6i7qNNayJII79fQckhLck0IRM', // CncPrintouts (empty)
  '1QgoarA-aVFyFdE0cGUJ1wlytTNFnYl8l', // 1_3Ds_MAX/New folder (empty)
];
// Path (by name, from drive root) to the Facebook browser-scrape junk folder.
const JUNK_FOLDER_PATHS = [
  ['Finished_Pics_4Investors', 'Facebook_files'],
];
// The stale full-mirror folder found inside 1_PDF_MAX. NOT auto-deleted — flagged only.
// Review it yourself once the top-level 1_PDF_MAX migration is done: if everything in here
// really is a duplicate of something now filed under Maximum Closets Jobs, trash it by hand.
const FLAG_FOR_MANUAL_REVIEW_ID = '1HMNxYwuI-m2FfBTwvRyhRal66OsXKovz'; // 1_PDF_MAX/1_PDF_MAX

// Files that are business-ops, not job files, even though they sit at the drive root
// alongside job files. These get moved to _Archive instead of into the job structure.
const ROOT_ARCHIVE_TITLES = [
  /^maximum pipe$/i,               // already imported into the Job Data sheet — see runReorg's seed import
  /^\s*inventory list\s*$/i,
  /^inventory list - special items$/i,
];
// Files/folders to leave completely alone (not job content, not safe to touch automatically).
const ROOT_SKIP_TITLES = [
  /^gggg$/i,                       // unresolved shortcut, flagged for James in the audit
];

// Each entry describes one source location to migrate. `path` is a list of folder names
// walked from the drive root (or from `New Contacts` etc for nested ones). `topLevelFilesOnly`
// = true means don't recurse into subfolders of that source (used where a subfolder is known
// to be a stale mirror, an unrelated utility export, or a mixed bag needing a human look).
const SOURCES = [
  { path: [], name: 'Drive root (loose files)', topLevelFilesOnly: true, defaultKind: 'Other', isRoot: true },
  { path: ['1_DOTJ_JOBS'], name: '1_DOTJ_JOBS', defaultKind: 'Other' },
  { path: ['1_PDF_MAX'], name: '1_PDF_MAX (top level)', defaultKind: 'PDFs', topLevelFilesOnly: true },
  { path: ['1_3Ds_MAX'], name: '1_3Ds_MAX (top level)', defaultKind: '3Ds', topLevelFilesOnly: true, capRecentPerCustomer: true },
  { path: ['Proposals'], name: 'Proposals', defaultKind: 'Contracts',
    skipTitles: [/^maximum contract/i, /^copy of maximum contract/i, /web.?redesign.?seo/i, /^proposal_template/i, /^proposal_contracttemp/i] },
  { path: ['Cost per job '], name: 'Cost per job', defaultKind: 'Other' },
  { path: ['Max_Cut_optimizer'], name: 'Max_Cut_optimizer', defaultKind: 'PDFs' },
  { path: ['Cutlist_ExportKCD'], name: 'Cutlist_ExportKCD', defaultKind: 'PDFs' },
  { path: ['To Miguel'], name: 'To Miguel (top level)', defaultKind: 'PDFs', topLevelFilesOnly: true },
  { path: ['Invoices'], name: 'Invoices', defaultKind: 'Contracts' },
  { path: ['New Contacts', 'MaxMarketingMaterial', 'Finished closets pics'], name: 'New Contacts / Finished closets pics', defaultKind: 'Other' },
  { path: ['New Contacts', 'Proposals_Contracts_Invoice'], name: 'New Contacts / Proposals_Contracts_Invoice', defaultKind: 'Contracts' },
];

// ─────────────────────────────────────────────────────────────────────────
// REORG
// ─────────────────────────────────────────────────────────────────────────
// Thin wrapper: a 5-minute time-driven trigger can overlap the previous invocation if
// that one ran close to its full time box, and overlapping executions racing on the same
// getFoldersByName-then-create check is exactly what produced duplicate Other/PDFs/
// Contracts folders under the same customer. The lock makes overlap a no-op skip instead.
function runReorg() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another runReorg() is already running — skipping this invocation to avoid racing it.');
    return;
  }
  try {
    runReorgInner();
  } finally {
    lock.releaseLock();
  }
}

function runReorgInner() {
  const startTime = Date.now();
  const root = DriveApp.getFolderById(CONFIG.DRIVE_ROOT_ID);
  const jobsRoot = getOrCreateSubfolder(root, CONFIG.JOBS_ROOT_NAME);
  const archiveRoot = getOrCreateSubfolder(root, CONFIG.ARCHIVE_FOLDER_NAME);
  const log = getMigrationLogSheet();
  const alreadyDone = getAlreadyLoggedFileIds(log);
  const overrides = getManualOverrides(log);

  let planned = 0, moved = 0, skippedDup = 0, skippedDone = 0, archived = 0, errors = 0;
  let skippedOld = 0, skippedExcess3D = 0;
  let timedOut = false;

  outer:
  for (const src of SOURCES) {
    const folder = src.isRoot ? root : getFolderByPath(root, src.path);
    if (!folder) {
      log.appendRow([nowStr(), 'ERROR', src.name, '', '', '', '', 'Source folder not found — check the path/name']);
      errors++;
      continue;
    }
    // For 1_3Ds_MAX: figure out up front which files are among the N most recent per
    // customer. Cheap metadata-only scan (no folder-creation calls), so redoing it every
    // run is fine — it's the actual move/create-folder calls that are expensive, and this
    // keeps that part limited to a handful of files per customer instead of everything.
    const keep3DsIds = src.capRecentPerCustomer ? computeKeep3DsIds(folder) : null;

    const files = folder.getFiles();
    while (files.hasNext()) {
      if (Date.now() - startTime > CONFIG.MAX_RUNTIME_MS) { timedOut = true; break outer; }
      const file = files.next();
      const fid = file.getId();
      if (fid === CONFIG.JOB_DATA_SHEET_ID) continue; // never touch the Hub's own database sheet
      if (alreadyDone.has(fid)) { skippedDone++; continue; }

      try {
        const title = file.getName();

        // Root-level non-job business files → archive, don't treat as a customer job.
        if (src.isRoot) {
          if (ROOT_SKIP_TITLES.some(rx => rx.test(title))) continue;
          if (ROOT_ARCHIVE_TITLES.some(rx => rx.test(title))) {
            if (!CONFIG.DRY_RUN) file.moveTo(archiveRoot);
            log.appendRow([nowStr(), CONFIG.DRY_RUN ? 'PLAN-ARCHIVE' : 'ARCHIVED', src.name, title, fid, '', '_Archive/' + title, '']);
            archived++; planned++;
            continue;
          }
        }
        if (src.skipTitles && src.skipTitles.some(rx => rx.test(title))) {
          log.appendRow([nowStr(), 'SKIPPED-ADMIN', src.name, title, fid, '', '', 'Admin/template file, not a job — left in place']);
          continue;
        }

        // Not logged per-file (would be thousands of Sheets writes) — just left exactly
        // where they are and counted. Anything genuinely wanted later is a manual look,
        // not something this pass needs to spend hours individually filing.
        if (isTooOld(file.getLastUpdated())) { skippedOld++; continue; }
        if (keep3DsIds && !keep3DsIds.has(fid)) { skippedExcess3D++; continue; }

        const override = overrides[fid] || overrides[title.toLowerCase()];
        const customerParts = override ? override.split('/').map(s => s.trim()).filter(Boolean) : extractCustomerPath(title);
        const kind = classifyKind(title, src.defaultKind);
        const modDate = file.getLastUpdated();
        const destMap = getOrCreateJobFolders(jobsRoot, customerParts, modDate);
        const destFolder = destMap[kind];

        const dup = findDuplicateInFolder(destFolder, title, file.getSize());
        const newPath = `${CONFIG.JOBS_ROOT_NAME}/${modDate.getFullYear()}/${pad2(modDate.getMonth() + 1)}/${customerParts.join('/')}/${kind}/${title}`;

        if (dup) {
          log.appendRow([nowStr(), CONFIG.DRY_RUN ? 'PLAN-DUP' : 'FLAGGED-DUP', src.name, title, fid, oldPathOf(file), newPath,
            'Possible duplicate of existing file in destination (' + dup.getId() + ') — left in source for manual review']);
          skippedDup++;
          continue;
        }

        if (!CONFIG.DRY_RUN) file.moveTo(destFolder);
        log.appendRow([nowStr(), CONFIG.DRY_RUN ? 'PLAN' : 'MOVED', src.name, title, fid, oldPathOf(file), newPath, '']);
        moved++; planned++;
      } catch (err) {
        log.appendRow([nowStr(), 'ERROR', src.name, file.getName(), fid, '', '', String(err)]);
        errors++;
      }
    }
  }

  if (CONFIG.DELETE_EMPTY_JUNK) cleanupJunk(root, log);

  const msg = `Reorg pass ${CONFIG.DRY_RUN ? '(DRY RUN — nothing moved)' : ''} done.\n` +
    `${CONFIG.DRY_RUN ? 'Planned' : 'Moved'}: ${moved}, Archived: ${archived}, Flagged dup: ${skippedDup}, ` +
    `Left in place (too old, >${CONFIG.OLD_CUTOFF_MONTHS}mo): ${skippedOld}, ` +
    `Left in place (excess 3D renders, kept top ${CONFIG.MAX_3DS_PER_CUSTOMER}/customer): ${skippedExcess3D}, ` +
    `Already done (skipped): ${skippedDone}, Errors: ${errors}.${timedOut ? '\nHit the time box — run runReorg() again to continue where it left off.' : '\nAll sources fully processed this pass.'}`;
  Logger.log(msg);
  log.appendRow([nowStr(), 'RUN SUMMARY', '', '', '', '', '', msg.replace(/\n/g, ' | ')]);
}

// ─────────────────────────────────────────────────────────────────────────
// CONSOLIDATE — one-time cleanup for the folder fragmentation caused by the
// old extractCustomerPath bug + the overlapping-run race condition (2026-07-17).
// Walks every Year/Month folder, groups sibling customer folders that the FIXED
// extractCustomerPath would now treat as the same customer, and merges them into
// one canonical folder (merging their 3Ds/PDFs/Contracts/Other subfolders too,
// including de-duplicating repeat subfolders created by the race condition).
// Never deletes a file — only moves, and only trashes folders once confirmed empty.
// Safe to run repeatedly: once a customer's folders are merged down to one, that
// group is a no-op on the next pass, so it doubles as its own resumability.
//
// CONFIG.CONSOLIDATE_DRY_RUN starts true: first run only logs what WOULD merge,
// nothing actually moves. Review the Migration Log for CONSOLIDATE-PLAN rows,
// then flip to false and run again to actually do it.
// ─────────────────────────────────────────────────────────────────────────
function consolidateFragments() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another run is already in progress — skipping this invocation.');
    return;
  }
  try {
    consolidateFragmentsInner();
  } finally {
    lock.releaseLock();
  }
}

function consolidateFragmentsInner() {
  const startTime = Date.now();
  const root = DriveApp.getFolderById(CONFIG.DRIVE_ROOT_ID);
  const jobsRoot = getOrCreateSubfolder(root, CONFIG.JOBS_ROOT_NAME);
  const log = getMigrationLogSheet();
  const dry = CONFIG.CONSOLIDATE_DRY_RUN;

  let groupsMerged = 0, filesMoved = 0, foldersRemoved = 0, dupsFlagged = 0, errors = 0;
  let timedOut = false;

  try {
    const years = jobsRoot.getFolders();
    while (years.hasNext()) {
      const yearFolder = years.next();
      const months = yearFolder.getFolders();
      while (months.hasNext()) {
        if (Date.now() - startTime > CONFIG.MAX_RUNTIME_MS) { timedOut = true; throw { __timeout: true }; }
        const monthFolder = months.next();

        const custFolders = [];
        const cf = monthFolder.getFolders();
        while (cf.hasNext()) custFolders.push(cf.next());
        if (custFolders.length < 2) continue;

        const groups = {};
        custFolders.forEach(folder => {
          const canonical = extractCustomerPath(folder.getName()).join('/');
          (groups[canonical] = groups[canonical] || []).push(folder);
        });

        for (const canonical of Object.keys(groups)) {
          const list = groups[canonical];
          if (list.length < 2) continue; // this customer is already a single folder — nothing to merge

          let primary = list.find(f => f.getName() === canonical) || list[0];
          const rest = list.filter(f => f.getId() !== primary.getId());

          if (dry) {
            log.appendRow([nowStr(), 'CONSOLIDATE-PLAN', '', canonical, primary.getId(), '',
              `${yearFolder.getName()}/${monthFolder.getName()}`,
              `Would merge ${rest.length} folder(s) into "${primary.getName()}": ${rest.map(f => f.getName()).join(', ')}`]);
            groupsMerged++;
            continue;
          }

          const result = mergeFoldersInto(rest, primary, log);
          filesMoved += result.filesMoved;
          foldersRemoved += result.foldersRemoved;
          dupsFlagged += result.dupsFlagged;
          groupsMerged++;
        }
      }
    }
  } catch (err) {
    if (!err || !err.__timeout) {
      log.appendRow([nowStr(), 'ERROR', 'consolidateFragments', '', '', '', '', String(err)]);
      errors++;
    }
  }

  const msg = `Consolidate pass ${dry ? '(DRY RUN — nothing merged)' : ''} done.\n` +
    `Customer groups ${dry ? 'that would be ' : ''}merged: ${groupsMerged}, Files ${dry ? '(n/a in dry run)' : 'moved'}: ${filesMoved}, ` +
    `Folders removed: ${foldersRemoved}, Dup conflicts flagged: ${dupsFlagged}, Errors: ${errors}.` +
    `${timedOut ? '\nHit the time box — run consolidateFragments() again to continue where it left off.' : '\nFully processed this pass.'}`;
  Logger.log(msg);
  log.appendRow([nowStr(), 'CONSOLIDATE SUMMARY', '', '', '', '', '', msg.replace(/\n/g, ' | ')]);

  // A real (non-dry) pass that finished without hitting the time box means every
  // customer group is now down to one folder — nothing left to do. Stop the
  // recurring trigger set up by setupConsolidateTrigger() and let James know by
  // email, so nobody has to keep clicking Run or babysitting the Execution log.
  if (!dry && !timedOut) {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'consolidateFragments') ScriptApp.deleteTrigger(t);
    });
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
        'Maximum Closets Hub: folder consolidation finished',
        `The automatic folder cleanup is done — no more duplicate customer folders left to merge.\n\n${msg}\n\nThe recurring trigger has been switched off automatically.`);
    } catch (err) {
      Logger.log('Could not send completion email: ' + err);
    }
  }
}

// Run this once (from the function dropdown, same as any other function here) to make
// consolidateFragments() run on its own every 7 minutes until every customer group is
// down to one folder. Safe to run again later — it clears out any previous trigger for
// consolidateFragments first, so you never end up with two overlapping schedules.
function setupConsolidateTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'consolidateFragments') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('consolidateFragments').timeBased().everyMinutes(10).create();
  Logger.log('Trigger created — consolidateFragments will now run automatically every 10 minutes until the whole Drive is consolidated, then switch itself off and email you.');
}

// Merges each folder in `fragments` into `primary`: for every subfolder inside a
// fragment (3Ds/PDFs/Contracts/Other, possibly repeated due to the race condition),
// finds-or-creates the matching subfolder under primary and moves the files across.
// Duplicate filenames at the destination are left in place and flagged, never
// silently overwritten or dropped. Empty fragment folders get trashed at the end.
function mergeFoldersInto(fragments, primary, log) {
  let filesMoved = 0, foldersRemoved = 0, dupsFlagged = 0;
  fragments.forEach(fragment => {
    const subfolders = fragment.getFolders();
    while (subfolders.hasNext()) {
      const sub = subfolders.next();
      const destSub = getOrCreateSubfolder(primary, sub.getName());
      const r = mergeFilesInto(sub, destSub, log);
      filesMoved += r.filesMoved;
      dupsFlagged += r.dupsFlagged;
      if (!sub.getFiles().hasNext() && !sub.getFolders().hasNext()) {
        sub.setTrashed(true);
        foldersRemoved++;
      }
    }
    // Loose files directly in the fragment folder (shouldn't normally happen, but safe to handle).
    const r = mergeFilesInto(fragment, primary, log);
    filesMoved += r.filesMoved;
    dupsFlagged += r.dupsFlagged;
    if (!fragment.getFiles().hasNext() && !fragment.getFolders().hasNext()) {
      fragment.setTrashed(true);
      foldersRemoved++;
    }
  });
  return { filesMoved, foldersRemoved, dupsFlagged };
}

function mergeFilesInto(srcFolder, destFolder, log) {
  let filesMoved = 0, dupsFlagged = 0;
  const files = srcFolder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const dup = findDuplicateInFolder(destFolder, f.getName(), f.getSize());
    if (dup) {
      log.appendRow([nowStr(), 'CONSOLIDATE-DUP', '', f.getName(), f.getId(), '', destFolder.getName(),
        `Same name+size already in target (${dup.getId()}) — left in fragment folder for manual review`]);
      dupsFlagged++;
      continue;
    }
    f.moveTo(destFolder);
    log.appendRow([nowStr(), 'CONSOLIDATED', '', f.getName(), f.getId(), '', destFolder.getName(), 'Merged from a fragmented customer folder']);
    filesMoved++;
  }
  return { filesMoved, dupsFlagged };
}

// Deletes the folders/paths flagged as junk in the audit. Only runs when
// CONFIG.DELETE_EMPTY_JUNK is explicitly set to true — double-checks emptiness first.
function cleanupJunk(root, log) {
  JUNK_FOLDER_IDS.forEach(id => {
    try {
      const f = DriveApp.getFolderById(id);
      if (f.getFiles().hasNext() || f.getFolders().hasNext()) {
        log.appendRow([nowStr(), 'SKIP-JUNK (not empty, re-check manually)', '', f.getName(), id, '', '', '']);
        return;
      }
      f.setTrashed(true);
      log.appendRow([nowStr(), 'DELETED-JUNK', '', f.getName(), id, '', '', 'Confirmed empty, trashed']);
    } catch (err) {
      log.appendRow([nowStr(), 'ERROR', '', '', id, '', '', String(err)]);
    }
  });
  JUNK_FOLDER_PATHS.forEach(path => {
    const f = getFolderByPath(root, path);
    if (!f) return;
    f.setTrashed(true);
    log.appendRow([nowStr(), 'DELETED-JUNK', '', path.join('/'), f.getId(), '', '', 'Browser-scrape junk folder']);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// NAME / KIND / PATH HELPERS
// ─────────────────────────────────────────────────────────────────────────

// Anything modified before this cutoff is left exactly where it already is —
// not moved, not deleted, just skipped. Revisit manually later if truly unwanted.
function isTooOld(date) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CONFIG.OLD_CUTOFF_MONTHS);
  return date < cutoff;
}

// Scans a folder's files (metadata only — no writes, so cheap even at thousands of
// files) and returns the set of file IDs that are among the MAX_3DS_PER_CUSTOMER most
// recent renders for their customer. Everything else in that folder gets left alone.
function computeKeep3DsIds(folder) {
  const groups = {};
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const modDate = f.getLastUpdated();
    if (isTooOld(modDate)) continue;
    const key = extractCustomerPath(f.getName()).join('/');
    (groups[key] = groups[key] || []).push({ id: f.getId(), modDate });
  }
  const keep = new Set();
  Object.keys(groups).forEach(key => {
    groups[key].sort((a, b) => b.modDate - a.modDate);
    groups[key].slice(0, CONFIG.MAX_3DS_PER_CUSTOMER).forEach(x => keep.add(x.id));
  });
  return keep;
}

// Words that mark "the customer name part is over, this is a room/revision/descriptor
// now" — e.g. "TeddyDianeVitt_BasementR", "TeddyDianeVitt_Media", "TeddyDianeVitt_New"
// must all fold into ONE "Teddy Diane Vitt" folder, not three separate ones. Matched as
// a prefix (case-insensitive) against each word, so "Basementsmall" still catches on
// "basement". Extend this list from the Migration Log rather than fighting individual
// filenames — a missed word here just means one over-long folder name, not lost data.
const DESCRIPTOR_STOPWORDS = [
  'basement', 'media', 'pic', 'new', 'master', 'kitchen', 'bath', 'bed', 'closet',
  'garage', 'laundry', 'office', 'pantry', 'mudroom', 'entry', 'hall', 'stair',
  'storage', 'safe', 'floor', 'wall', 'room', 'rev', 'revision', 'final', 'copy',
  'draft', 'old', 'update', 'layout', 'design', 'print', 'drawing', 'cutlist',
  'estimate', 'proposal', 'invoice', 'quote', 'plan', 'wing', 'side', 'level',
  'upstairs', 'downstairs', 'addition', 'back', 'front', 'top', 'bottom', 'small',
  'large', 'main', 'guest', 'kids', 'child', 'nursery', 'den', 'library', 'foyer',
  'drawer', 'shelf', 'shelve', 'cabinet', 'door', 'unit', 'wardrobe', 'reach',
  'walkin', 'linen', 'dining', 'living', 'attic', 'loft', 'porch', 'deck', 'outdoor',
  'right', 'left', 'birdseye', 'noxtra',
];
const MAX_NAME_WORDS = 4; // safety cap even if no stopword/digit is ever hit

// Filenames with no real customer name in them at all — generic camera/screenshot
// exports like "IMG_9740.jpg", "DSC_0021.jpg", or "Screenshot 2026-06-01.png" — would
// otherwise get a fabricated "customer" name (e.g. "Img 9740") from the first word +
// digits. Route these into one shared bucket instead so a human can look at them,
// rather than spraying one-off junk customer folders across the Jobs tree.
const GENERIC_FILENAME_PATTERNS = [
  /^img[-_ ]?\d+$/i,
  /^dsc[-_ ]?\d+$/i,
  /^dcim[-_ ]?\d+$/i,
  /^photo[-_ ]?\d+$/i,
  /^screenshot/i,
  /^untitled/i,
  /^\d+$/, // bare numbers, e.g. a phone's auto-generated filename
];

// Best-effort customer name → folder path segments. Wrong guesses are exactly
// why the Migration Log + Manual Overrides tab exist: fix the name there and
// re-run rather than fighting the regex further.
function extractCustomerPath(rawTitle) {
  let base = rawTitle;
  // strip chained extensions, e.g. "KCD Drawings - X.Job.pdf" -> "KCD Drawings - X"
  while (/\.(pdf|job|jpe?g|png|heic|webp|csv|xlsx?|docx?|zip|tmp)$/i.test(base)) {
    base = base.replace(/\.(pdf|job|jpe?g|png|heic|webp|csv|xlsx?|docx?|zip|tmp)$/i, '');
  }
  if (GENERIC_FILENAME_PATTERNS.some(rx => rx.test(base.trim()))) {
    return ['Unsorted - Needs Review'];
  }
  base = base.replace(/^KCD Drawings - /i, '');
  // split camelCase runs ("TeddyDianeVitt" / "GardenCity") — most source filenames have
  // no separators at all, so this is the difference between a readable folder name and not.
  base = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

  // Plain \b treats "_" as a word char, so it wouldn't catch "Inder_9Delaware" — match on
  // non-letter boundaries instead (still correctly rejects "Arvinder", which has a letter before it).
  if (/(^|[^a-z])inder([^a-z]|$)/i.test(base)) {
    let addr = base.replace(/inder/ig, ' ').replace(/[_-]+/g, ' ').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
    return ['Inder', titleCase(truncateToName(addr.split(/\s+/))) || 'General'];
  }

  const words = base.replace(/[_-]+/g, ' ').replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  const name = titleCase(truncateToName(words)) || 'Unsorted';
  return [sanitizeFolderName(name)];
}

// Keeps leading words until a descriptor stopword, a digit-bearing word (except the very
// first — addresses like "112 Luquor" or "9 Delaware" legitimately start with a number),
// or the word cap is hit. Whichever comes first wins.
function truncateToName(words) {
  const kept = [];
  for (let i = 0; i < words.length && i < MAX_NAME_WORDS; i++) {
    const w = words[i];
    if (i > 0 && /\d/.test(w)) break;
    // Short stopwords ("den", "bed", "top") need an exact match — a prefix match on those
    // collides with real first names ("Denise", "Dennis"). Longer ones ("basement",
    // "storage") are safe as prefixes, which is what catches "Basementsmall" too.
    const wl = w.toLowerCase();
    if (DESCRIPTOR_STOPWORDS.some(sw => sw.length >= 5 ? wl.startsWith(sw) : wl === sw)) break;
    kept.push(w);
  }
  return (kept.length ? kept : words.slice(0, 1)).join(' ');
}

function classifyKind(title, defaultKind) {
  const ext = (title.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  if (['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(ext)) return '3Ds';
  if (['job'].includes(ext)) return 'Other';
  if (ext === 'pdf' && !defaultKind) return 'PDFs';
  return defaultKind || 'Other';
}

function titleCase(s) {
  return s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.substr(1).toLowerCase());
}
function sanitizeFolderName(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '-').trim().slice(0, 100) || 'Unsorted';
}
function pad2(n) { return String(n).padStart(2, '0'); }
function nowStr() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }
function oldPathOf(file) {
  const parents = file.getParents();
  return parents.hasNext() ? parents.next().getName() + '/' + file.getName() : file.getName();
}

function getFolderByPath(startFolder, pathParts) {
  let f = startFolder;
  for (const part of pathParts) {
    const it = f.getFoldersByName(part);
    if (!it.hasNext()) return null;
    f = it.next();
  }
  return f;
}
function getOrCreateSubfolder(parent, name) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}
function getOrCreateJobFolders(jobsRoot, customerParts, date) {
  let cust = getOrCreateSubfolder(jobsRoot, String(date.getFullYear()));
  cust = getOrCreateSubfolder(cust, pad2(date.getMonth() + 1));
  customerParts.forEach(part => { cust = getOrCreateSubfolder(cust, part); });
  return {
    root: cust,
    '3Ds': getOrCreateSubfolder(cust, '3Ds'),
    'PDFs': getOrCreateSubfolder(cust, 'PDFs'),
    'Contracts': getOrCreateSubfolder(cust, 'Contracts'),
    'Other': getOrCreateSubfolder(cust, 'Other'),
  };
}
function findDuplicateInFolder(folder, title, size) {
  const it = folder.getFilesByName(title);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getSize() === size) return f;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// MIGRATION LOG / MANUAL OVERRIDES (tabs inside the Job Data sheet)
// ─────────────────────────────────────────────────────────────────────────
function getMigrationLogSheet() {
  const ss = SpreadsheetApp.openById(CONFIG.JOB_DATA_SHEET_ID);
  let sheet = ss.getSheetByName('Migration Log');
  if (!sheet) {
    sheet = ss.insertSheet('Migration Log');
    sheet.appendRow(['Timestamp', 'Action', 'Source', 'File Name', 'File ID', 'Old Path', 'New Path', 'Note']);
    sheet.setFrozenRows(1);
  }
  let overrides = ss.getSheetByName('Manual Overrides');
  if (!overrides) {
    overrides = ss.insertSheet('Manual Overrides');
    overrides.appendRow(['File ID or exact File Name', 'Correct Customer Path (e.g. "Inder/9 Delaware" or "Smith")']);
    overrides.appendRow(['# Fill this in BEFORE flipping DRY_RUN to false if the log shows a misparsed name.', '']);
    overrides.setFrozenRows(1);
  }
  return sheet;
}
// Bug fix (2026-07-16): this used to only recognize the live-mode action names, so in
// DRY_RUN every trigger fire re-planned the same files from scratch instead of resuming —
// it must also recognize the dry-run action names or resumability silently does nothing.
//
// Bug fix (2026-07-17): "done" has to mean "done in the CURRENT mode." A file logged as
// PLAN during the dry run is NOT actually moved — so once DRY_RUN flips to false, PLAN
// rows must not count as handled, or the live run would see everything as "already done"
// (from dry-run planning) and skip every file without ever really moving anything.
const LIVE_DONE_ACTIONS = new Set(['MOVED', 'ARCHIVED', 'FLAGGED-DUP', 'SKIPPED-ADMIN']);
const DRY_RUN_DONE_ACTIONS = new Set(['MOVED', 'ARCHIVED', 'FLAGGED-DUP', 'PLAN', 'PLAN-ARCHIVE', 'PLAN-DUP', 'SKIPPED-ADMIN']);
function getAlreadyLoggedFileIds(logSheet) {
  const handled = CONFIG.DRY_RUN ? DRY_RUN_DONE_ACTIONS : LIVE_DONE_ACTIONS;
  const values = logSheet.getDataRange().getValues();
  const ids = new Set();
  for (let i = 1; i < values.length; i++) {
    if (handled.has(values[i][1])) ids.add(values[i][4]);
  }
  return ids;
}
function getManualOverrides(logSheet) {
  const ss = logSheet.getParent();
  const sheet = ss.getSheetByName('Manual Overrides');
  const map = {};
  if (!sheet) return map;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const key = String(values[i][0] || '').trim();
    const val = String(values[i][1] || '').trim();
    if (key && val && !key.startsWith('#')) map[key.toLowerCase()] = val;
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
// WEB APP API — called by the Hub (index.html)
// ─────────────────────────────────────────────────────────────────────────
function doGet(e) {
  const action = e.parameter.action;
  try {
    if (action === 'recentFiles') return jsonOut(apiRecentFiles(e.parameter.customer, e.parameter.kind, Number(e.parameter.limit) || 5));
    if (action === 'fileData') return jsonOut(apiFileData(e.parameter.id));
    if (action === 'jobs') return jsonOut(apiListJobs());
    if (action === 'ping') return jsonOut({ ok: true, time: nowStr() });
    return jsonOut({ error: 'Unknown action: ' + action }, 400);
  } catch (err) {
    return jsonOut({ error: String(err) }, 500);
  }
}
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    if (body.action === 'upsertJob') return jsonOut(apiUpsertJob(body.job));
    return jsonOut({ error: 'Unknown action: ' + body.action }, 400);
  } catch (err) {
    return jsonOut({ error: String(err) }, 500);
  }
}
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Finds /Maximum Closets Jobs/*/*/<customer>/<3Ds|PDFs>/ across all year/month folders
// (customer folders repeat per month, so this walks the tree — fine at this drive's scale)
// and returns the `limit` most-recently-modified files, newest first.
// Matches by FILE NAME, not by walking to one exact customer folder: the same customer's
// files are often still scattered across several near-duplicate folders (see
// consolidateFragments), so requiring an exact folder-name match was returning "no files
// found" for real customers just because their files hadn't been merged into one folder
// yet. Drive's `contains` operator matches whole tokens (it splits on _, -, ., and spaces),
// so searching on the customer's last name catches "Joe_Grosetto_LeftX1.jpg" no matter
// which of a dozen folders it's currently sitting in.
//
// Sorted by DATE CREATED, not last-modified: every file's "modified" timestamp gets bumped
// to today the moment runReorg/consolidateFragments touches it, which silently made old
// renders look like the newest ones. Created date is untouched by moves, so it's the only
// reliable signal for "which version did James actually make most recently."
function apiRecentFiles(customerName, kind, limit) {
  if (!customerName || !kind) return { error: 'customer and kind are required' };
  const words = customerName.trim().split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return { customer: customerName, kind, files: [] };
  const key = words[words.length - 1].replace(/'/g, "\\'"); // last word = surname, usually the most distinctive token
  const query = `title contains '${key}' and trashed = false and mimeType != '${MimeType.FOLDER}'`;
  const it = DriveApp.searchFiles(query);
  const matches = [];
  while (it.hasNext()) {
    const f = it.next();
    const parents = f.getParents();
    const parent = parents.hasNext() ? parents.next() : null;
    if (!parent || parent.getName() !== kind) continue; // only files actually filed under the requested kind subfolder (3Ds/PDFs)
    if (!isUnderJobsRoot(parent)) continue; // ignore anything outside Maximum Closets Jobs that happens to share the word
    matches.push({ id: f.getId(), name: f.getName(), url: f.getUrl(), modified: f.getDateCreated().toISOString(), size: f.getSize() });
  }
  matches.sort((a, b) => b.modified.localeCompare(a.modified));
  return { customer: customerName, kind, files: matches.slice(0, limit) };
}

function isUnderJobsRoot(folder) {
  let f = folder, depth = 0;
  while (f && depth < 8) {
    if (f.getName() === CONFIG.JOBS_ROOT_NAME) return true;
    const parents = f.getParents();
    f = parents.hasNext() ? parents.next() : null;
    depth++;
  }
  return false;
}

// Returns a file's bytes as base64 so the Hub can embed it directly into a proposal
// (data: URL) — a live Drive link would 403 for a customer who has no access to the
// shared drive, so anything going into an emailed/printed proposal needs to be self-contained.
// Capped at 8MB to keep the Web App response reasonable; the Hub should show an error for
// anything larger rather than let this hang.
function apiFileData(fileId) {
  if (!fileId) return { error: 'id is required' };
  const file = DriveApp.getFileById(fileId);
  if (file.getSize() > 8 * 1024 * 1024) return { error: 'File too large to inline (>8MB): ' + file.getName() };
  const blob = file.getBlob();
  return {
    id: fileId,
    name: file.getName(),
    mimeType: blob.getContentType(),
    base64: Utilities.base64Encode(blob.getBytes()),
  };
}

function apiListJobs() {
  const ss = SpreadsheetApp.openById(CONFIG.JOB_DATA_SHEET_ID);
  const sheet = ss.getSheets()[0];
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  return values.slice(1).filter(r => r.some(c => c !== '')).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

// Upserts a job by "Job ID" — updates the row if it exists, appends if not.
function apiUpsertJob(job) {
  if (!job || !job['Job ID']) return { error: 'job.Job ID is required' };
  const ss = SpreadsheetApp.openById(CONFIG.JOB_DATA_SHEET_ID);
  const sheet = ss.getSheets()[0];
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol = headers.indexOf('Job ID');
  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (values[i][idCol] === job['Job ID']) { rowIndex = i; break; }
  }
  const row = headers.map(h => (h in job ? job[h] : (rowIndex >= 0 ? values[rowIndex][headers.indexOf(h)] : '')));
  if (rowIndex >= 0) {
    sheet.getRange(rowIndex + 1, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  return { ok: true, jobId: job['Job ID'] };
}
