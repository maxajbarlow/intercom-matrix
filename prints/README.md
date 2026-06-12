# config prints (local only)

Drop a system's "Group & Conference List" print here and point its
`print` path in `systems.json` at it (e.g. `"print": "prints/studio-b.txt"`).
On server start the file is parsed into an offline matrix source — no
controller or VPN needed.

- Accepts a PDF (needs `pdftotext`/poppler on the server) or already-extracted
  `-raw` text: `pdftotext -raw print.pdf print.txt`.
- Print to **A3 / wide** so panel names aren't truncated.
- Everything here except this README is gitignored — prints contain the full
  panel/conference inventory and are treated as sensitive, like `systems.json`
  and the topology trees.
