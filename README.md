# Intercom Matrix

A live, hostable, multi-client viewer for one or more intercom
systems — driven entirely by the **read-only** RRCS API. Host it on a box on the
intercom network and anyone can open it in a browser; it pulls the current state
from each controller and presents three views, with a system selector to
switch between deployments (e.g. Studio A / Studio B / Control Room).

## Views

- **Matrix** — a panel × conference grid. Each cell shows the direction:
  ● Talk · ○ Listen · ⊗ both · ·· via key. Filter rows (panels) and columns
  (conferences), restrict to physical panels only, or toggle key-access.
- **Conferences** — pick a conference (or group) and see every member, its type,
  and its Talk/Listen direction.
- **Panels** — pick a panel/port and see every conference it belongs to, marked
  **Member** (permanent) or **Via key** (from the loaded config), with direction.

Any view can be exported to a styled **Excel workbook** (the **⬇ Excel** button)
with three sheets mirroring the UI: a frozen-pane **Matrix** grid (panels ×
conferences, glyphs colour-coded by direction), **Conferences** (each with its
members), and **Panels** (each with its memberships).
- **Requests** — a change-request platform. One composer builds a request from
  any mix of operations: add/remove a conference on a panel, change a key's
  Talk/Listen, and create / rename / delete a conference. Requests are validated
  against the current system, grouped into a per-conference **work order** for
  the engineer, shown as a **pending-changes** overlay on the other views, and
  **auto-verified** when the next config print reflects them.

## Change requests (request → implement → verify)

The viewer never writes to the live system. Instead it captures change
**intent** and follows it to completion:

1. **Request** — from a Conference or Panel (or the Requests tab), build one or
   more changes of any type (membership, direction, create/rename/delete). Each
   is validated live (valid · already a member · conflict · not found).
2. **Work order** — pending changes are grouped **by conference** with exact
   add/remove/direction/create/rename/delete steps for the engineer.
3. **Verify** — upload the fresh config print; the platform reconciles it
   against open requests and marks fulfilled changes **verified** automatically
   (partial landings are tracked per change).

Pending changes appear as an overlay (toggle on the Matrix; inline on Conference
and Panel detail). Requests are stored in SQLite at `data/requests.db` (the only
state not re-derivable from a print — gitignored; `POST /api/requests-backup`
writes a timestamped copy). Requests are attributed to the **signed-in user**
(see Authentication below).

## Read-only & safe

The RRCS client is hard-locked to `Get*` query methods (`GetAllPorts`,
`GetAllConferences`, `GetAllGroups`). It physically cannot call `SetXp`,
`KillXp`, or anything that changes the live system. Viewers share one
server-side cached snapshot per system, and a lock + 3 s minimum interval mean a
controller is never hammered no matter how many people connect. A failed refresh
keeps the **last good data** (shown as *stale*) rather than blanking out.

## Installation & setup

### Prerequisites

- **Node.js 24 or newer** — the request and auth stores use the built-in
  `node:sqlite` module (`DatabaseSync`), which is unflagged from Node 24 onward.
  Check yours with `node --version`. (There is no separate database server to
  install — the SQLite files live under `data/`.)
- **npm** (bundled with Node) and **git**.
- **`pdftotext`** (from [poppler](https://poppler.freedesktop.org/)) —
  *optional*, only needed to parse **PDF** config prints server-side. Without it
  the app still runs and accepts pre-extracted `.txt` prints (PDF upload
  degrades gracefully). Install with `brew install poppler` (macOS) or
  `sudo apt-get install -y poppler-utils` (Debian/Ubuntu). **On Windows it's
  bundled** (`vendor/poppler/win-x64`) and resolved automatically — no install.
- **TCP reachability** to each controller's RRCS port (default `8193`) — only if
  you use the live-RRCS source. The offline config-print source needs no
  controller access at all.

### Windows: one-click setup

On a clean Windows 10/11 or Windows Server machine — even with **no Node.js
installed** — you don't need the manual steps below:

1. On the **[GitHub repo](https://github.com/maxajbarlow/intercom-matrix)**, click
   **Code → Download ZIP** (or `git clone`), then extract it.
2. Open the extracted folder and **double-click `Install and Run.bat`**.
3. The first time, Windows **SmartScreen** may say *"Windows protected your PC"* —
   click **More info → Run anyway** (it's an unrecognised download, not a problem).

It then does the rest, with no admin rights needed (one UAC prompt only if the
Visual C++ runtime has to be installed):

1. Download a **portable** Node.js 24+ into `.node\` if you don't already have one.
2. Ensure the Visual C++ runtime the bundled `pdftotext` needs.
3. `npm ci` the dependencies (needs internet, one time).
4. Start the server and open **http://localhost:8080**.

Run it again any time to launch — installed bits are reused. Pass flags through the
`.bat`: `"Install and Run.bat" -Port 9000`, `-NoBrowser`, `-NoStart`.

> **Always launch via `Install and Run.bat`, not the `.ps1` directly.** A
> downloaded `install.ps1` is unsigned and will be blocked by PowerShell's
> execution policy (*"…is not digitally signed"*); the `.bat` runs it in a way
> that works regardless of policy. Full details, air-gapped instructions, and
> troubleshooting are in [`windows/README.md`](windows/README.md).

The manual steps below also work on Windows (PowerShell/CMD) if you'd rather install
Node yourself.

### 1. Install

```bash
git clone https://github.com/maxajbarlow/intercom-matrix.git
cd intercom-matrix
npm install        # no native build steps — pure-JS deps + built-in node:sqlite
```

### 2. Run

```bash
npm start          # → http://localhost:8080
```

Serve on a different port with `PORT=9000 npm start`. The process logs the URL
and each system's connection status on boot. Stop it with Ctrl-C; nothing is
written outside the project directory (state lives in `data/`, `systems.json`,
and `settings.json`, all gitignored).

### 3. First-run wizard

Open the URL in a browser. On a fresh install a four-step **first-run wizard**
walks you through it:

1. **Create the admin account** (scrypt-hashed locally; this is your way in).
2. **Add your first system** — either *connect a controller live over RRCS*
   (with a one-click **Test connection**) **or** *upload a config print* to
   work offline from a snapshot. Either gives you the full Matrix / Conferences /
   Panels views.
3. **Branding & theme** (optional — name, subtitle, dark/light).
4. **Finish** — a recap of the read-only / request→verify model, an optional
   *Require login* wall, and you're in.

The wizard only orchestrates the same endpoints the Settings panel uses, so
nothing it does is special — you can also configure everything by hand (below),
and an admin can replay it any time from **Settings → Safety → Re-run setup**.

The wizard appears only until setup is marked complete; an install that already
has an admin, a configured system, or the login wall on is detected at boot and
skips it. To force the env bootstrap admin as the *only* first-admin path (e.g.
on an untrusted network), set `ONBOARDING_OPEN=0`.

### Manual setup (the file-based path)

Prefer files? Skip the wizard entirely by configuring `systems.json` up front:

```bash
cp systems.example.json systems.json     # then fill in each system's host
npm start                                 # → http://localhost:8080
```

Each system's controller can also be set/repointed from the UI ("Controller"
field) — that's persisted back to `systems.json`.

### systems.json

```json
[
  { "id": "studio-a",   "name": "Studio A",         "host": "10.x.x.x", "port": 8193, "config": "" },
  { "id": "studio-b", "name": "Studio B",    "host": "10.x.x.x", "port": 8193, "config": "" },
  { "id": "control-room",  "name": "Control Room", "host": "10.x.x.x", "port": 8193, "config": "" }
]
```

`config` is an optional path to a controller config (`.Art`/`.ash`) for that system (adds
key-access — see below). `systems.json` is gitignored (it holds controller IPs);
commit only `systems.example.json`.

### Environment

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8080` | HTTP port to serve on |
| `SYSTEMS_FILE` | `./systems.json` | path to the systems definition |
| `SETTINGS_FILE` | `./settings.json` | path to the deployment settings (see below) |
| `REFRESH_SEC` | `0` | server-side auto-refresh interval per system (0 = off) |
| `RRCS_HOST` | — | fallback single system if no `systems.json` |
| `RRCS_ENABLED` | `off` | **seed** for the live-polling toggle on first run; thereafter `settings.json` is the source of truth |
| `ONBOARDING_OPEN` | `on` | allow the first-run wizard to create the first admin without auth (locks once one exists). Set `0` to require the env bootstrap admin instead |
| `PRINTS_DIR` | `./prints` | where uploaded config prints are versioned (gitignored) |

See [`.env.example`](.env.example) for the full list, including the
authentication and cookie variables.

### Run with Docker

A [`Dockerfile`](Dockerfile) is included (Node 25 + `poppler-utils`). Build the
image, then run it with your `systems.json` mounted and the SQLite databases on
a named volume so they survive container replacement:

```bash
docker build -t intercom-matrix .

docker run -d --name intercom-matrix \
  -p 8080:8080 \
  -v "$PWD/systems.json:/app/systems.json:ro" \
  -v intercom-data:/data \
  -e RRCS_ENABLED=on \
  -e LOCAL_ADMIN_USER=admin -e LOCAL_ADMIN_PASS='change-me' \
  intercom-matrix
```

- The image sets `REQUESTS_DIR=/data`; the `intercom-data` volume holds the
  request and auth databases. Mount `systems.json` read-only so controller IPs
  are never baked into the image.
- A `HEALTHCHECK` polls `/api/systems` (returns 200 even with zero systems).
- Behind a TLS proxy, add `-e COOKIE_SECURE=1`.

### Production checklist

- **TLS:** serve behind a TLS-terminating reverse proxy and set `COOKIE_SECURE=1`
  so session cookies carry the `Secure` flag. The app deliberately does **not**
  trust `X-Forwarded-*` headers (see the note in `server.js`).
- **At-rest key:** set a stable `IMX_SECRET_KEY` (32 bytes, base64) so in-app
  LDAP/SAML secrets survive a redeploy; otherwise one is generated at
  `data/.secret-key` on first run.
- **Break-glass admin:** provide `LOCAL_ADMIN_USER` / `LOCAL_ADMIN_PASS` so you
  always have a way in, then turn on **Require login** (Settings → Safety) if the
  network isn't trusted. See [Authentication](#authentication) for LDAP / SAML.
- **Persist `data/`:** it holds the request and auth databases (the only state
  not re-derivable from a config print).

### Run the tests

```bash
npm test     # node --test — unit + HTTP integration tests, no extra setup
```

## Settings (configuring a customer deployment)

The **⚙ Settings** tab is the no-files-needed way to tailor a deployment in the
field. It edits two server-owned, gitignored files (commit only their
`.example` copies):

- **`systems.json`** — the systems list. Add / rename / reorder / delete systems
  and edit each one's controller IP, port, and offline source paths (key-access
  config, topology tree, VSP export) right from the UI. The system **id** is
  fixed once created (it keys stored prints & requests).
- **`settings.json`** — everything else, in four groups:
  - **Branding** — site name, subtitle, logo, default system, default landing view.
  - **Display defaults** — auto-refresh, theme (dark/light), matrix defaults,
    date format. Applied to every client on first load; each viewer can still
    override in-session from the header.
  - **Safety** — the RRCS live-polling toggle, the minimum refresh interval
    (3 s floor; RRCS stays read-only regardless), and the **Require login** wall.
  - **Users** — local username/password accounts (admin-managed) and the
    read-only status of the LDAP and SAML sign-in paths.

```bash
cp settings.example.json settings.json    # optional — sensible defaults apply if absent
```

## Authentication

Three ways to sign in, all converging on one session cookie and the
**viewer / editor / admin** role model (`admin` manages deployment config):

1. **Local accounts** — username/password created in **Settings → Users** by an
   admin, scrypt-hashed in `data/auth.db` (built-in `node:sqlite`, no native dep).
   A bootstrap `LOCAL_ADMIN_USER` / `LOCAL_ADMIN_PASS` from env gives the first
   way in before any accounts exist.
2. **LDAP / Active Directory** — set `LDAP_URL` (+ optional bind/TLS); users
   authenticate with directory credentials and `LDAP_GROUP_{ADMIN,EDITOR,VIEWER}`
   maps groups to roles.
3. **SAML 2.0 SSO** — set the entry-point/issuer/callback and IdP cert; a "Sign
   in with SSO" button appears on the login screen.

See [`.env.example`](.env.example) for every variable. Login is **optional by
default** — anonymous visitors get read-only access (the trusted-network premise)
— until an admin turns on **Require login** in Settings → Safety, which gates the
whole app behind a sign-in screen.

### Configuring LDAP / SAML in-app

You can configure both connections entirely in the UI — **Settings → Users →
Configure LDAP… / Configure SAML…** — including pasting CA / IdP / SP **PEM**
certs and keys, with an LDAP **Test connection** button. The env vars are a
fallback; any field set in-app overrides its env value. The security model:

- **Secrets are encrypted at rest** (AES-256-GCM, `lib/crypto-vault`) in
  `data/auth-config.json`. The master key is `IMX_SECRET_KEY` (env) or an
  auto-generated `data/.secret-key` (0600). A leaked config file is ciphertext.
- **Secrets never leave the server.** The admin config endpoint returns
  `••••••••` / `hasValue: true`, never the value; the public `GET /api/settings`
  stays secret-free. Editing leaves a secret blank to keep it unchanged.
- **Admin + same-origin only.** `/api/auth-config` is admin-gated; serve over
  HTTPS (`COOKIE_SECURE=1` behind a TLS proxy). The env bootstrap admin is always
  the recovery path.

### Turning sign-in methods on/off

**Settings → Users** has a switch for each method (Local / LDAP / SAML). The env
vars provide the *connection* config; the switch decides whether a configured
method is *offered*. A method can only be switched on once it's configured in env
(its toggle is locked otherwise). Turning everything off is allowed — the env
**bootstrap admin** (`LOCAL_ADMIN_*`) always works as a recovery path, reachable
via a "use a local account" link on the SSO-only login screen. The
`LDAP_URL` / `SAML_ENABLED` env values seed each switch's initial state on first
run; after that `settings.json` is authoritative.

### Microsoft Entra ID (SAML) quickstart

In **Entra admin center → Enterprise applications → New application → Create your
own (non-gallery) → Single sign-on → SAML**:

| Entra field | Maps to |
|---|---|
| Identifier (Entity ID) | `SAML_ISSUER` (e.g. `intercom-matrix`) |
| Reply URL (ACS) | `https://YOUR-HOST/api/auth/saml/acs` → `SAML_CALLBACK_URL` |
| Login URL | `SAML_ENTRY_POINT` |
| Certificate (Base64) | download → save as PEM → `SAML_IDP_CERT_FILE` |

```bash
SAML_ENTRY_POINT=https://login.microsoftonline.com/<tenant>/saml2
SAML_ISSUER=intercom-matrix
SAML_CALLBACK_URL=https://your-host/api/auth/saml/acs
SAML_IDP_CERT_FILE=/etc/intercom-matrix/entra.pem
COOKIE_SECURE=1     # Entra requires an HTTPS reply URL
```

**Roles** — Entra emits group claims as GUIDs by default, so prefer **App Roles**
(App registration → App roles: define `admin`/`editor`/`viewer`, assign users):

```bash
SAML_GROUPS_ATTRIBUTE=http://schemas.microsoft.com/ws/2008/06/identity/claims/role
SAML_GROUP_ADMIN=admin
SAML_GROUP_EDITOR=editor
SAML_GROUP_VIEWER=viewer
```

(Or add a groups claim and put each group's **Object ID** in `SAML_GROUP_*` — our
resolver matches them as opaque strings.) The SP metadata is at
`/api/auth/saml/metadata` if you'd rather hand Entra a URL. Then flip **SAML** on
in Settings → Users.

### Role gating

Writes to shared config (settings, systems, user accounts) require the **admin**
role; everyone else sees Settings read-only. The gate lives in `lib/identity.js`
`can()` and is enforced **server-side** — `currentUser()` resolves the session
cookie to a verified user, so the UI only mirrors what the server already
enforces. (The old self-claimed `X-Imx-*` header is gone; you can no longer pick
your own role.)

## Key-access (optional)

Conference *membership* is permanent and authoritative. Some panels also reach
conferences via **keys** (press-to-talk) without being members. That programming
isn't in RRCS, but it is in the controller config file. Load a `.Art` or `.ash`
per system (the **+ Key-access** button, or the `config` path in `systems.json`)
and those panels gain "Via key" edges, joined to the live system by ObjectID and
clearly distinguished from permanent membership. (Config files are not committed
to this repo.)

## Node / Card grouping (optional)

Load a controller **node-configuration tree** (`Net → Node → Card/Bay → Port`) per
system to group and filter the views by node and card. It's joined to the live
ports by name; once loaded, the **Matrix** and **Panels** views gain **Node** and
**Card/Bay** dropdowns. Load it via the **+ Topology** button, or set a
`topology` path in `systems.json`. See `topology/README.md`. (Trees hold the full
port inventory and are not committed.)

## Virtual system — load a VSP export (optional)

If you can produce a VSP key-function-programming **export** as JSON, the app can
load it as a read-only system called **Virtual**, alongside the intercom systems —
with the same Matrix / Conferences / Panels views and Excel export. Producing the
export is out of scope for this project; bring your own.

1. Place the export at `data/vsp-export.json` (gitignored — exports hold
   production config).
2. Add a system to `systems.json`:
   `{ "id": "virtual", "name": "Virtual", "vsp": "data/vsp-export.json" }`.
3. Restart. `lib/vsp-model.js` maps the export into the snapshot shape.

The expected export shape (ports × targets with a Talk/Listen cell for each
relationship):

```json
{
  "source": "vsp", "system": "…", "generatedAt": "…",
  "ports":   [{ "uuid": "…", "label": "…", "longName": "…", "trunk": false }],
  "targets": [{ "uuid": "…", "label": "…", "kind": "conference|member|group|ifb" }],
  "cells":   [{ "portUuid": "…", "targetUuid": "…", "talk": true, "listen": false }]
}
```

## Updating

- Each viewer has an **Auto** selector (Off / 10s / 30s / 1m / 5m) plus a manual
  **Refresh**.
- Optionally run with `REFRESH_SEC` so the shared cache stays warm even with no
  one watching.

## API (most take `?system=<id>`)

The matrix/snapshot endpoints are read-only and never touch the live system. The
change-request endpoints write only to the local request DB — never to RRCS.

| Endpoint | Returns |
|---|---|
| `GET /api/systems` | list of systems + status |
| `GET /api/status` | connection state, counts, stale flag, last-fetch time |
| `GET /api/snapshot` | full model (matrix + conferences + panels) |
| `GET /api/matrix` | rows / cols / sparse cells |
| `GET /api/conferences` | conferences & groups with members |
| `GET /api/panels` | panels with their conference memberships |
| `GET /api/export.xlsx` | the current snapshot as a 3-sheet Excel workbook (Matrix / Conferences / Panels) |
| `POST /api/refresh` | re-pull from RRCS for a system |
| `POST /api/system-config` | point a system at a controller (persisted) |
| `POST /api/config-file` | load a `.Art`/`.ash` for key-access |
| `GET /api/requests` | change requests + status counts |
| `POST /api/requests` | create a request (membership change or new conference) |
| `GET /api/requests/:id` | one request: changes, validation, comments, history |
| `POST /api/requests/:id/transition` | move a request through its lifecycle |
| `POST /api/requests/:id/comments` | add a comment |
| `GET /api/pending` | actionable pending changes (the overlay feed) |
| `GET /api/work-order` | pending changes grouped by conference for the engineer |
| `POST /api/requests-reconcile` | reconcile open requests against the current print |
| `POST /api/requests-backup` | write a timestamped copy of the request DB |

## What it is (and isn't)

The intercom routing in an intercom system *is* the conference membership, so this
shows the real communication matrix — who talks/listens to whom — resolved to
authoritative names from `GetAllPorts`. Per-physical-key target programming isn't
exposed by RRCS on all firmware (`GetAllKeyConfigurations`); the optional
`.Art`/`.ash` key-access fills in the conference keys a panel can reach.

## License

[MIT](LICENSE).

## Trademarks

This is an independent, unaffiliated project. Any product, protocol, or company
names referenced (for example, RRCS) are the property of their respective
owners; they are used only nominatively to describe interoperability and do not
imply any affiliation with or endorsement by those owners.
