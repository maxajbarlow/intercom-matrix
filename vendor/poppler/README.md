# Vendored poppler (`pdftotext`)

`pdftotext` (from [poppler](https://poppler.freedesktop.org/)) extracts text from
controller **config-print PDFs** server-side — see `lib/print-parser.js`. The app
shells out to it as a separate process; it is **not** linked into this codebase.

## Why this is vendored

Intercom Matrix is meant to run on private / air-gapped intercom networks where a
package manager or internet access may be unavailable. On macOS and Linux the app
resolves `pdftotext` from `PATH` (`brew install poppler` / `apt-get install
poppler-utils`, and the Docker image installs `poppler-utils`). **Windows has no
package manager**, so the Windows binaries are committed here and resolved
automatically — zero setup on a fresh clone.

## Contents

| Path | What |
| --- | --- |
| `win-x64/pdftotext.exe` + `*.dll` | Windows x64 build. The DLLs must stay next to the `.exe`. |
| `COPYING`, `COPYING.gpl2`, `COPYING.adobe` | poppler's license texts (see below). |

## Provenance

- **Project:** poppler — https://poppler.freedesktop.org/
- **Version:** 26.02.0
- **Build:** prebuilt Windows x64 release
- **Source code:** available from the poppler project at the URL above and via its
  git repository at https://gitlab.freedesktop.org/poppler/poppler

## License

poppler is licensed under the **GNU GPL v2 (or later)**. Its license texts are
included in this directory (`COPYING`, `COPYING.gpl2`, `COPYING.adobe`). poppler
remains under its own license; bundling it here as a standalone executable invoked
as a separate process is aggregation and does **not** change the MIT license of
Intercom Matrix itself. If you redistribute this project with these binaries, keep
these license files alongside them and retain the provenance information above.

## Resolution order

`lib/print-parser.js` resolves the `pdftotext` binary in this order:

1. `PDFTOTEXT_BIN` env var, if set (absolute path to an executable).
2. The bundled binary for the current platform (currently `win-x64` only).
3. `pdftotext` on `PATH` (macOS/Linux/Docker, or a Windows install on PATH).

To add another platform, drop the binaries under `vendor/poppler/<platform>-<arch>/`
and extend `resolvePdftotext()` in `lib/print-parser.js`.
