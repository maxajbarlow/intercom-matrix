# Intercom Matrix on Windows — one-click setup

For a clean Windows 10/11 (or Windows Server) machine with **no Node.js installed**.

## Quick start

1. Get the project onto the machine — either `git clone`, or download the repo
   ZIP from GitHub and extract it.
2. Double-click **`Install and Run.bat`** in the project root.
3. Wait for it to finish. Your browser opens at **http://localhost:8080** and the
   [first-run wizard](../README.md#3-first-run-wizard) walks you through the rest.

That's it. Run `Install and Run.bat` again any time to start the server.

## What it does

`Install and Run.bat` launches [`windows/install.ps1`](install.ps1), which:

| Step | Action | Needs admin? | Needs internet? |
| --- | --- | --- | --- |
| 1 | Use an existing Node 24+ if present, else download a **portable** Node into `.node\` | No | Only if Node is missing |
| 2 | Ensure the **Visual C++ runtime** (the bundled `pdftotext.exe` needs it) | Maybe (UAC, only if missing) | Only if missing |
| 3 | `npm ci` the app dependencies (express, ws, exceljs, …) | No | Yes (first run) |
| 4 | Start `server.js` and open the browser | No | No |

The portable Node lives in `.node\` inside the project and is **gitignored** — it
makes no system-wide change and needs no admin rights, so it can't clash with any
other Node on the machine. Delete `.node\` to force a fresh download.

## Options

Pass flags through the `.bat`:

```bat
"Install and Run.bat" -Port 9000     REM serve on a different port
"Install and Run.bat" -NoBrowser     REM don't auto-open the browser
"Install and Run.bat" -NoStart       REM install only, don't launch
```

## Notes & troubleshooting

- **Is PDF upload going to work?** Near the end, the installer prints one of:
  - `PDF config-print upload: ENABLED` — you're done; PDF uploads will parse.
  - `PDF config-print upload: DISABLED` — the Microsoft Visual C++ runtime isn't
    installed (Step 2 needs admin; you declined the prompt or lack rights). The app
    still runs — upload pre-extracted `.txt` prints — and PDFs start working once you
    install <https://aka.ms/vs/17/release/vc_redist.x64.exe> and re-run. If you try a
    PDF without it, the app tells you exactly this rather than a cryptic error.
- **"This looks like it's running from inside the ZIP."** You double-clicked the
  `.bat` without extracting. Right-click the `.zip` → **Extract All**, then run it
  from the extracted folder.
- **Downloads fail / "a proxy or firewall is blocking nodejs.org".** The installer
  auto-uses your system proxy (with your Windows credentials) for Node, the VC++
  runtime, and npm. If it still can't reach `nodejs.org` / `registry.npmjs.org` /
  `aka.ms`, ask IT to allow those, or pre-stage Node + `node_modules\` (see
  air-gapped below).
- **"Port 8080 is already in use."** Something else holds the port. Re-run as
  `"Install and Run.bat" -Port 9000` (or any free port).
- **"…install.ps1 is not digitally signed" / "running scripts is disabled".**
  This is the PowerShell **execution policy** blocking an unsigned, downloaded
  script. You don't need to change any policy: always launch via
  **`Install and Run.bat`**, which runs the script through `Invoke-Expression`
  rather than as a file — so it works even when the policy is `AllSigned` /
  `RemoteSigned` or locked down by Group Policy (where `-ExecutionPolicy Bypass`
  is ignored). Running the `.ps1` directly *will* be blocked on such machines;
  use the `.bat`.
- **Air-gapped machine (no internet).** Pre-install Node 24+ (or drop a portable
  Node into `.node\`) and commit/copy a populated `node_modules\` over, then run
  `Install and Run.bat` — it will skip every download and just launch.
- **SmartScreen warns about the downloaded files.** Node and the VC++ redist are
  fetched from `nodejs.org` and `microsoft.com` respectively; that's expected.

For the full configuration guide (RRCS sources, auth, Docker, etc.) see the
[main README](../README.md).
