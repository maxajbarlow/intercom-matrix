# Intercom Matrix

A hostable, multi-client viewer for one or more intercom systems, fed by
**config prints**: the "Group & Conference List" exported from the config tool
(PDF or extracted text). Upload a print per system and anyone can open the
viewer in a browser. It presents three views, with a system selector to switch
between deployments (e.g. Studio A / Studio B / Control Room). It never
connects to the intercom system itself.

## Views

- **Matrix** — a panel × conference grid. Each cell shows the direction:
  ● Talk · ○ Listen · ⊗ both. Filter rows (panels) and columns (conferences),
  or restrict to physical panels only.
- **Conferences** — pick a conference (or group) and see every member, its type,
  and its Talk/Listen direction.
- **Panels** — pick a panel/port and see every conference it has a key to, with
  its direction.

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

The viewer has **no connection to the intercom system**. Its only input is the
config prints engineers upload, so there is nothing on the intercom network it
could read from or change. Every upload is kept as a **version**. The newest is
the current matrix, and any two versions can be diffed. Open browsers pick up a
newly uploaded print when the tab regains focus (with a 60-second background
check), so nobody has to press refresh.

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
and each system (with whether it has a print yet) on boot. Stop it with Ctrl-C; nothing is
written outside the project directory (state lives in `data/`, `systems.json`,
and `settings.json`, all gitignored).

### 3. First-run wizard

Open the URL in a browser. On a fresh install a four-step **first-run wizard**
walks you through it:

1. **Create the admin account** (scrypt-hashed locally; this is your way in).
2. **Add your first system**: name it and upload its config print (PDF or
   text). That gives you the full Matrix / Conferences / Panels views.
3. **Branding & theme** (optional — name, subtitle, dark/light).
4. **Finish** — a recap of the read-only / request→verify model, an optional
   *Require login* wall, and you're in.

The wizard only orchestrates the same endpoints the Settings panel uses, so
nothing it does is special — you can also configure everything by hand (below),
and an admin can replay it any time from **Settings → Access → Re-run setup**.

The wizard appears only until setup is marked complete; an install that already
has an admin, a configured system, or the login wall on is detected at boot and
skips it. To force the env bootstrap admin as the *only* first-admin path (e.g.
on an untrusted network), set `ONBOARDING_OPEN=0`.

### Manual setup (the file-based path)

Prefer files? Skip the wizard entirely by configuring `systems.json` up front:

```bash
cp systems.example.json systems.json     # then rename the systems you need
npm start                                 # → http://localhost:8080
```

Then upload each system's config print in **Settings → Systems**.

### systems.json

```json
[
  { "id": "studio-a",     "name": "Studio A" },
  { "id": "studio-b",     "name": "Studio B" },
  { "id": "control-room", "name": "Control Room", "topology": "topology/control-room.txt" }
]
```

`topology` is an optional path to a node-configuration tree (see below). `print`
is an optional path to a seed print, imported as version 1 on first boot. After
that, uploads made in the UI are the source. `systems.json` is gitignored; commit
only `systems.example.json`. Entries from older versions that still carry
`host` / `port` / `config` / `vsp` load fine: those fields are ignored and
dropped the next time the file is saved.

### Environment

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8080` | HTTP port to serve on |
| `SYSTEMS_FILE` | `./systems.json` | path to the systems definition |
| `SETTINGS_FILE` | `./settings.json` | path to the deployment settings (see below) |
| `ONBOARDING_OPEN` | `on` | allow the first-run wizard to create the first admin without auth (locks once one exists). Set `0` to require the env bootstrap admin instead |
| `PRINTS_DIR` | `./prints` (`/data/prints` in Docker) | where uploaded config prints (versioned) and topology trees are kept until replaced or cleared — removing a system keeps them (gitignored) |

See [`.env.example`](.env.example) for the full list, including the
authentication and cookie variables.

### Run with Docker (simplest — no Node, no clone, no build)

The app is published as a ready-to-run image with the PDF tool (`pdftotext`)
already inside. If you have Docker, one command runs everything:

```bash
docker run -d --name intercom-matrix -p 8080:8080 \
  -v intercom-data:/data \
  ghcr.io/maxajbarlow/intercom-matrix
```

Then open **http://localhost:8080** — the first-run wizard does the rest. The
`intercom-data` volume keeps the request and login databases **and every uploaded
print and topology** across restarts and image updates.

**No Docker yet?** Install it once, then run the command above:

- **Windows / macOS** — install [Docker Desktop](https://www.docker.com/products/docker-desktop/), open it, then run the command.
- **Linux** — `curl -fsSL https://get.docker.com | sh`

**Update** to the latest version any time:

```bash
docker pull ghcr.io/maxajbarlow/intercom-matrix
docker rm -f intercom-matrix          # then re-run the docker run command above
```

#### Options

Add any of these to the `docker run` command:

| Goal | Add |
|------|-----|
| Pre-defined systems | `-v "$PWD/systems.json:/app/systems.json"` |
| Break-glass admin | `-e LOCAL_ADMIN_USER=admin -e LOCAL_ADMIN_PASS='change-me'` |
| Behind a TLS proxy | `-e COOKIE_SECURE=1` |
| Different port | `-p 9000:8080` |

A `HEALTHCHECK` polls `/api/systems` (200 even with zero systems).

#### Build it yourself instead

Prefer to build from source rather than pull the published image?

```bash
docker build -t intercom-matrix .
docker run -d --name intercom-matrix -p 8080:8080 -v intercom-data:/data intercom-matrix
```

### Production checklist

- **TLS:** serve behind a TLS-terminating reverse proxy and set `COOKIE_SECURE=1`
  so session cookies carry the `Secure` flag. The app deliberately does **not**
  trust `X-Forwarded-*` headers (see the note in `server.js`).
- **At-rest key:** set a stable `IMX_SECRET_KEY` (32 bytes, base64) so in-app
  LDAP/SAML secrets survive a redeploy; otherwise one is generated at
  `data/.secret-key` on first run.
- **Break-glass admin:** provide `LOCAL_ADMIN_USER` / `LOCAL_ADMIN_PASS` so you
  always have a way in, then turn on **Require login** (Settings → Access) if the
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

- **`systems.json`**: the systems list. Add / rename / reorder / delete
  systems, upload each one's config prints (with version history and diffs) and
  optional topology tree, right from the UI. The system **id** is fixed once
  created (it keys stored prints & requests).
- **`settings.json`**: everything else, in four groups:
  - **Branding**: site name, subtitle, logo, default system, default landing view.
  - **Display defaults**: theme (dark/light), matrix defaults, date format.
    Applied to every client on first load; each viewer can still override
    in-session.
  - **Access**: the **Require login** wall (forced on once customer groups
    exist) and the re-run-setup button.
  - **Users**: local username/password accounts (admin-managed) and the
    read-only status of the LDAP and SAML sign-in paths.

Customer groups live in **Settings → Customers** (see
[Customer groups](#customer-groups-scoped-channel-views)).

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

### Customer groups (scoped channel views)

Show each customer only the channels that matter to them. In **Settings →
Customers**, an admin creates a group (e.g. *FIA Race Control*, *SysOps*) and
ticks the **source panels** that customer owns, per system. Those panels are the
source of truth:

- The group sees **every conference hosted on its source panels**, whether the
  panel is a member or holds a key to it. The live *Resolves to* preview shows
  exactly which ones.
- Nothing is stored as a conference list. The set is worked out from the current
  data on every request, so **a conference added to an FIA panel appears for FIA
  with the next print upload**, with no one editing the group.
- Matrix rows are everyone on those conferences, but each panel's memberships
  are cut to the group's conferences. A shared panel never reveals the rest.
- Members are local **usernames** and/or **LDAP/SAML directory groups** (DN or
  group claim). A directory group mapped to a customer also lets its members
  sign in as viewers.

Rules: only **viewers** are scoped. Admins and editors always see everything.
Once any group exists, **login is enforced** (an anonymous visitor can't be
scoped), and a viewer in no group sees no data. Scoping is enforced
**server-side** on every data route, the Excel export, print diffs and change
requests. Customers can only raise requests on their own channels, and only see
requests about them. The logic is in `lib/customer-scope.js` (pure derivation)
and `lib/customer-access.js` (applied per request).

## Node / Card grouping (optional)

Load a controller **node-configuration tree** (`Net → Node → Card/Bay → Port`) per
system to group and filter the views by node and card. It's joined to the
print's panels by name (and fills in panel names the print truncated). Once
loaded, the **Matrix** and **Panels** views gain **Node** and **Card/Bay**
dropdowns. Load it via the topology **Upload** button in Settings → Systems, or
set a `topology` path in `systems.json`. An upload is kept across restarts and
wins over the configured path until it's replaced or cleared. See `topology/README.md`. (Trees hold
the full port inventory and are not committed.)

## Updating the data

Upload a new config print whenever the configuration changes. It becomes the
current matrix, is kept as a new version (diffable against earlier ones), and
reconciles open change requests. Open browsers pick it up when the tab regains
focus, or within a minute in the background.

## API (most take `?system=<id>`)

The matrix/snapshot endpoints are read-only. The change-request endpoints write
only to the local request DB. Nothing ever talks to the intercom system.

| Endpoint | Returns |
|---|---|
| `GET /api/systems` | list of systems + status |
| `GET /api/status` | whether a print is loaded, counts, print timestamp |
| `GET /api/snapshot` | full model (matrix + conferences + panels) |
| `GET /api/matrix` | rows / cols / sparse cells |
| `GET /api/conferences` | conferences & groups with members |
| `GET /api/panels` | panels with their conference memberships |
| `GET /api/export.xlsx` | the current snapshot as a 3-sheet Excel workbook (Matrix / Conferences / Panels) |
| `POST /api/print-file` | upload a config print (PDF or text) as a new version (editor) |
| `GET /api/print-versions` · `GET /api/print-diff` | version history and a diff between two versions |
| `POST /api/topology-file` | upload a node/card topology tree (editor) |
| `GET /api/requests` | change requests + status counts |
| `POST /api/requests` | create a request (membership change or new conference) |
| `GET /api/requests/:id` | one request: changes, validation, comments, history |
| `POST /api/requests/:id/transition` | move a request through its lifecycle |
| `POST /api/requests/:id/comments` | add a comment |
| `GET /api/pending` | actionable pending changes (the overlay feed) |
| `GET /api/work-order` | pending changes grouped by conference for the engineer |
| `POST /api/requests-reconcile` | reconcile open requests against the current print |
| `POST /api/requests-backup` | write a timestamped copy of the request DB |
| `GET /api/customers` | customer groups with source panels + members (admin) |
| `POST /api/customers` · `PATCH`/`DELETE /api/customers/:id` | manage customer groups (admin) |
| `POST /api/customers/preview` | dry-run: which conferences a set of source panels resolves to (admin) |

For a customer-scoped viewer, every data endpoint above returns only their
channels (see *Customer groups*).

## What it is (and isn't)

A config print lists, for every conference and group, the panel keys assigned
to it and their Talk/Listen direction. So the matrix shows exactly what the
configuration says: who talks to and listens on which conference. It's as current
as the latest uploaded print. It is not a live view of crosspoint state, and
changes made in the config tool appear only once a new print is uploaded.

## License

[MIT](LICENSE).

## Trademarks

This is an independent, unaffiliated project. Any product, protocol, or company
names referenced (for example, RRCS) are the property of their respective
owners; they are used only nominatively to describe interoperability and do not
imply any affiliation with or endorsement by those owners.
