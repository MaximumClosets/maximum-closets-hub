#!/usr/bin/env python3
"""
Move misplaced files in the MAXKCDFILES shared Google Drive back into their
correct top-level category folder, based on file extension:

    .pdf                          -> 1_PDF_MAX
    .3ds                          -> 1_3Ds_MAX
    .job / .kjob / .kcd           -> 1_DOTJ_JOBS

Scans every file in the shared drive (regardless of how deeply nested it is,
including files trapped inside duplicate lookalike folders), and only lists
a file as "to move" if it isn't already directly inside the correct target
folder.

CRITICAL SAFETY BEHAVIOR: this script ALWAYS does a dry run first. It prints
every single planned move and does not touch anything until you review the
list and type YES at the prompt.

Setup:
    pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib

    1. In Google Cloud Console, enable the Google Drive API for a project.
    2. Create an OAuth Client ID (type "Desktop app") and download it as
       credentials.json into this same folder.
    3. Run this script. A browser window will open once for you to sign in
       and grant access; after that a token.json is cached locally.
"""

import os
import sys

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/drive"]

# Verified folder IDs for the MAXKCDFILES shared drive (top-level category
# folders). Hardcoded rather than looked up by name because more than one
# folder with the same name exists in this drive (duplicates from a past
# botched reorg) - looking up by name risks picking the wrong one again.
SHARED_DRIVE_ID = "0ACfFVWmN5VhLUk9PVA"

TARGET_FOLDERS = {
    "3ds": ("1_3Ds_MAX", "1HcmRFtgIqHFAYM8wIwOAPOIRyHUJun-6"),
    "pdf": ("1_PDF_MAX", "1IUkUptM2dhSq7BV0fD3kV5FClEPgnrcr"),
    "job": ("1_DOTJ_JOBS", "1XJInGfobGJQwI5vTobY6f9OBpaVsEfSG"),
}

EXTENSION_TO_CATEGORY = {
    ".3ds": "3ds",
    ".pdf": "pdf",
    ".job": "job",
    ".kjob": "job",
    ".kcd": "job",
}


def get_drive_service():
    creds = None
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
            creds = flow.run_local_server(port=0)
        with open("token.json", "w") as token:
            token.write(creds.to_json())
    return build("drive", "v3", credentials=creds)


def list_all_files(service):
    files = []
    page_token = None
    query = "trashed = false and mimeType != 'application/vnd.google-apps.folder'"
    while True:
        response = service.files().list(
            q=query,
            corpora="drive",
            driveId=SHARED_DRIVE_ID,
            includeItemsFromAllDrives=True,
            supportsAllDrives=True,
            fields="nextPageToken, files(id, name, parents)",
            pageSize=1000,
            pageToken=page_token,
        ).execute()
        files.extend(response.get("files", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return files


def category_for(filename):
    lower = filename.lower()
    for ext, category in EXTENSION_TO_CATEGORY.items():
        if lower.endswith(ext):
            return category
    return None


def get_folder_path(service, folder_id, cache):
    if folder_id in cache:
        return cache[folder_id]
    names = []
    current_id = folder_id
    while current_id:
        if current_id in cache:
            names.append(cache[current_id])
            break
        try:
            meta = service.files().get(
                fileId=current_id, fields="name, parents", supportsAllDrives=True
            ).execute()
        except Exception:
            break
        names.append(meta.get("name", "?"))
        parents = meta.get("parents") or []
        current_id = parents[0] if parents else None
    path = "/".join(reversed(names))
    cache[folder_id] = path
    return path


def main():
    print("Connecting to Google Drive...")
    service = get_drive_service()

    print("Scanning the entire shared drive for .pdf, .3ds, and KCD job files...")
    all_files = list_all_files(service)
    print(f"Found {len(all_files)} total files in the shared drive.\n")

    planned_moves = []
    path_cache = {}
    for f in all_files:
        category = category_for(f["name"])
        if category is None:
            continue
        target_name, target_id = TARGET_FOLDERS[category]
        current_parent = (f.get("parents") or [None])[0]
        if current_parent == target_id:
            continue  # already in the right place
        planned_moves.append((f, current_parent, target_name, target_id))

    if not planned_moves:
        print("Nothing to move - everything is already in the right folder.")
        return

    print("=" * 70)
    print(f"DRY RUN - {len(planned_moves)} file(s) would be moved:")
    print("=" * 70)
    for f, current_parent, target_name, _ in planned_moves:
        current_path = get_folder_path(service, current_parent, path_cache) if current_parent else "(no parent)"
        print(f"  {f['name']}")
        print(f"      from: {current_path}")
        print(f"      to:   {target_name}\n")

    print("=" * 70)
    print("NO FILES HAVE BEEN MOVED YET.")
    print("=" * 70)
    answer = input("Type YES to proceed with these moves, anything else to cancel: ")

    if answer.strip() != "YES":
        print("Cancelled. No changes were made.")
        return

    print("\nMoving files...")
    for f, current_parent, target_name, target_id in planned_moves:
        try:
            service.files().update(
                fileId=f["id"],
                addParents=target_id,
                removeParents=current_parent or "",
                supportsAllDrives=True,
                fields="id, parents",
            ).execute()
            print(f"  Moved: {f['name']} -> {target_name}")
        except Exception as e:
            print(f"  FAILED: {f['name']} - {e}")

    print("\nDone.")


if __name__ == "__main__":
    main()
