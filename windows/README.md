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

- **"pdftotext still missing" / PDF prints won't parse.** The bundled tool needs
  the Microsoft Visual C++ runtime. Step 2 installs it automatically, but if you
  declined the admin prompt, install it manually from
  <https://aka.ms/vs/17/release/vc_redist.x64.exe> and re-run. The app runs fine
  without it — you just upload pre-extracted `.txt` prints instead of PDFs.
- **Script won't run / "running scripts is disabled".** The `.bat` already calls
  PowerShell with `-ExecutionPolicy Bypass`, so double-clicking the `.bat` is the
  supported path. Don't run the `.ps1` directly unless you pass the same flag.
- **Air-gapped machine (no internet).** Pre-install Node 24+ (or drop a portable
  Node into `.node\`) and commit/copy a populated `node_modules\` over, then run
  `Install and Run.bat` — it will skip every download and just launch.
- **SmartScreen warns about the downloaded files.** Node and the VC++ redist are
  fetched from `nodejs.org` and `microsoft.com` respectively; that's expected.

For the full configuration guide (RRCS sources, auth, Docker, etc.) see the
[main README](../README.md).
