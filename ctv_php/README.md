# PHP version: installation and deployment

The PHP/SQLite backend serves the shared `ctv_web` frontend on a conventional
hosting account. It reads existing local MP4 archives such as Reolink FTP/FTPS
uploads without Composer, Python, FFmpeg, FFprobe or a daemon. The Python
backend and its Docker/Home Assistant deployment remain available separately.

## What is supported

| Feature | PHP version |
| --- | --- |
| Camera configuration, source browsing, timeline and search | Supported |
| Native MP4 playback and byte-range seeking | Supported |
| Ordinary and Reolink fragmented MP4 duration | Parsed in PHP; zero duration headers patched during delivery |
| Timeline thumbnails | Nearby uploaded JPG/JPEG snapshots |
| Date partitions and full-directory indexing | Web requests and CLI |
| Password protection | Required Basic Authentication with bcrypt `.htpasswd` |
| Guided installation | CLI and one-time browser wizard; no `htpasswd` utility required |
| Balanced/Fast profiles and codec conversion | Unavailable |
| Home Assistant events | Unavailable |
| Background watcher, live updates and generated thumbnails | Unavailable; use cron for indexing and refresh the selected day |

H.264/AAC MP4 is the practical choice for browser playback. H.265/HEVC depends
on the browser/OS codec support. PHP cannot convert an unsupported recording.
Original recordings and snapshots are read only; streaming patches do not
modify the MP4 files on disk.

## Requirements

- 64-bit PHP 8.2 or later, with `pdo_sqlite`; CI covers 8.2, 8.4 and 8.5.
- Apache 2.4 or compatible LiteSpeed with rewrite rules enabled.
- HTTPS enabled on the viewer's domain before entering credentials.
- Read access for PHP to the archive and password file.
- Write access for both web PHP and cron PHP to the same data directory.
- Enough PHP execution time and memory for the requested directory scan.
- For browser setup, writable PHP sessions and write access to `ctv_php`.

CLI checks:

```bash
php -v
php -r 'echo PHP_INT_SIZE === 8 ? "64-bit PHP\n" : "64-bit PHP required\n"; print_r(PDO::getAvailableDrivers());'
```

The driver list must include `sqlite`. The PHP version/extensions selected for
the website and the `php` executable used by cron can differ on shared hosting.

## 1. Upload the application and configure the domain

Clone or upload the **complete repository**, including dotfiles. For example:

```bash
git clone https://github.com/azine/cctv-timeline-viewer-core.git
cd cctv-timeline-viewer-core
```

Choose a revision containing the PHP backend. Before PR #1 is merged, the
branch is `php-shared-host-backend`; after merging, use `main`.

Set the addon/subdomain document root in your hosting control panel to:

```text
/home/USER/apps/cctv-timeline-viewer-core/ctv_php/public
```

`ctv_web`, `ctv_php/src`, `ctv_php/config.php`, the password file and the data
directory stay outside that document root. PHP serves the frontend itself, so
do not copy `ctv_web` into `public` or expose the repository root as a website.
Enable the domain's TLS certificate and redirect HTTP visitors to HTTPS using
the hosting provider's settings.

### Deploy from a local checkout over SSH

`ctv_php/deploy.sh` deploys the PHP backend and shared frontend without
copying the server's private configuration, password file or SQLite data. From
the repository root, create a local, untracked `.env.prod.local` file:

```bash
REMOTE_HOST=example.com
REMOTE_USER=deploy-user
REMOTE_DIR=/home/deploy-user/apps/cctv-timeline-viewer-core
```

`REMOTE_DIR` is the server-side repository directory and must be absolute.
`REMOTE_PORT=22`, `PHP_BIN=php` and `INDEX_DAYS=1` are optional. `INDEX_DAYS`
controls how many recent date partitions are indexed after deployment; it
defaults to one. Run:

```bash
ctv_php/deploy.sh
```

When `ctv_php/config.php` already exists on the server, the script asks whether
to open `setup.php` interactively. Choosing no leaves the current settings and
credentials in place. It then discovers camera directories and runs the CLI
indexer. The SSH account must be able to create and write `REMOTE_DIR`; PHP
must be available to that account on the server.

The included `public/.htaccess` routes assets and application requests through
PHP authentication, disables directory listings and blocks dotfile URLs. It
also forwards the Authorization header for CGI/FastCGI. Apache must permit
these directives (`AllowOverride FileInfo Options`, or the provider's equivalent).

## 2. Run the setup wizard

The installer saves `ctv_php/config.php`, creates a bcrypt password file and
optionally discovers cameras from the archive roots. It asks for **every PHP
configuration setting**: archive directories, SQLite data directory, frontend
directory, timezone, upload settle time, thumbnail matching distance, password
file path and the shared administrator/view-only role. It also asks for the
login username and password. `alex` is an example username; choose your own
username and a password of 12–72 bytes. No default password is provided.

### With SSH or a terminal

Run from the repository root:

```bash
php ctv_php/setup.php
```

Alternatively, run `php setup.php` from inside `ctv_php`.

Press Enter to accept the shown defaults. Enter absolute server paths; separate
multiple archive roots with `;`. The archive directories must already exist and
be readable. Each root can contain camera folders or be a camera folder itself.
Both `/home/USER/reolink-backup` and `/home/USER/reolink-backup/Wand1` are supported.
The wizard creates the data directory if necessary; the chosen
password file's parent directory must already exist. Terminal password input is
hidden. Review the settings, then confirm saving.

The wizard validates PHP/SQLite, paths, directory permissions, timezone and
numeric settings, and refuses to put archives, data or passwords under
`ctv_php/public` or `ctv_web`. It writes the configuration and password file
with permissions `0640`. Use the hosting account that also runs web PHP, or set
the appropriate group so web PHP and cron can read these private files.

Run `php ctv_php/setup.php` again to update an existing installation. The wizard asks
before replacing the configuration, can keep existing credentials unchanged,
and retains other users when adding a user or changing a password. Existing
camera timezones are not changed by updating the default timezone.

If `CTV_PHP_*` environment overrides are active, remove them before using the
wizard; otherwise they would override the settings it saves. Environment-based
configuration remains available for manual deployments below.

### After uploading, without SSH

1. Upload the **complete repository**, including `ctv_php/setup.php` and dotfiles, and
   set the HTTPS site's document root to `ctv_php/public` as described above.
2. Open `https://YOUR-DOMAIN/YOUR-PATH/setup.php`. This runs
   `ctv_php/public/setup.php`; it creates a random, private one-time token at
   `ctv_php/.setup-token` without displaying it to visitors.
3. In the hosting file manager, enable hidden files, open `.setup-token`, and
   copy its contents into the wizard. Access to this private file proves you
   control the hosting account. Do not put the token into a URL.
4. Complete the form, entering one archive directory per line, choose the login
   credentials and role, then click **Save settings and enable password
   protection**.
5. Open the viewer and sign in. Review the discovered cameras, or add cameras
   in **Cameras**. Select a date to index its recordings.

The browser wizard requires HTTPS and the correct public document root. On
success it removes the one-time token and **closes whenever `config.php`
exists**, including for authenticated viewer users. Later changes use the CLI
wizard or the private configuration file. If you already copied a configuration
file manually, use those methods rather than browser setup.

Optional discovery recognizes camera roots containing date directories, or
adds the camera subfolders of their parent, with the default
`{YYYY}/{MM}/{DD}` pattern; it does not scan video files. For other archive
layouts, use administrator access until camera configuration is complete.
Large initial scans and cron setup are described below.

### Manual configuration alternative

You can still configure the application without the wizard:

```bash
cp ctv_php/config.example.php ctv_php/config.php
mkdir -p ctv_php/var
```

Edit `ctv_php/config.php`. A typical Reolink configuration is:

```php
<?php
return [
    'source_roots' => ['/home/USER/reolink-backup'],
    'data_dir' => __DIR__ . '/var',
    'web_root' => dirname(__DIR__) . '/ctv_web',
    'timezone' => 'Europe/Zurich',
    'password_file' => __DIR__ . '/.htpasswd',
    'file_settle_seconds' => 30,
    'snapshot_max_distance_seconds' => 90,
    'admin' => true,
];
```

| Setting | Meaning |
| --- | --- |
| `source_roots` | Allowed archive directories: camera folders or their parents; camera sources and served files must stay inside them |
| `data_dir` | Writable SQLite directory; separate from any Python backend database |
| `web_root` | Path to the repository's shared `ctv_web` frontend |
| `timezone` | Default camera timezone; stored individually when cameras are created |
| `password_file` | Absolute path to a readable bcrypt `.htpasswd`, outside any public directory |
| `file_settle_seconds` | Skip newly modified MP4 files until uploads have settled |
| `snapshot_max_distance_seconds` | Maximum timestamp distance for an uploaded JPEG thumbnail |
| `admin` | `true` permits camera changes, manual scans and rebuilding; `false` makes configuration read only |

All password-file users share the configured `admin` role. Read-only viewers
can still prepare the requested date partitions to view footage. There are no
per-user camera restrictions or separate administrator passwords.

Environment variables override matching file settings:
`CTV_PHP_SOURCE_ROOTS` (semicolon/newline separated), `CTV_PHP_DATA_DIR`,
`CTV_PHP_WEB_ROOT`, `CTV_PHP_TIMEZONE`, `CTV_PHP_PASSWORD_FILE` and
`CTV_PHP_ADMIN` (`1`/`0`). Prefer `config.php` when cron does not inherit the
website's environment. Local configuration, passwords and data are ignored by
git.

Keep the raw recording archive outside **all** public document roots. If an
existing FTP upload target is web-accessible, deny HTTP access there through
the hosting control panel or a `Require all denied` Apache rule. Protecting the
viewer cannot protect a separate website that exposes the same MP4s directly.

## 3. Manage password protection

The setup wizard creates the bcrypt password file itself; no external utility
is needed. For manual installation, run this from the repository root; the
command prompts for a password:

```bash
htpasswd -cB -C 10 ctv_php/.htpasswd alex
chmod 640 ctv_php/.htpasswd
```

`-B` is required: PHP verifies bcrypt hashes. The default Apache MD5 format is
not supported. `-c` creates/replaces the file; use it **only for initial setup**.
Add a user or change an existing password without `-c`:

```bash
htpasswd -B -C 10 ctv_php/.htpasswd sam
```

To manage users without `htpasswd`, run `php ctv_php/setup.php` and choose to add a user
or change a password. You can also create the bcrypt file on a local machine
with Apache's password utility and upload it to the configured private
location. Set its owner/group so web PHP can read it; do not make the password
file or the data directory world-writable.

Password verification runs in PHP before database access on every request,
including direct `/video/ID` requests, thumbnails and byte ranges. It does not
depend on enabling the hosting provider's Directory Privacy feature. Missing,
unreadable or unsupported password files produce **503**; missing or incorrect
credentials produce **401** and a browser password prompt. No default user or
password is shipped. Removing a user or changing a password takes effect on the
next request. Browsers cache Basic credentials; closing the browser/session is
the usual way to leave a login.

Administrative API calls require `X-CTV-Request: 1` as well as credentials.
The frontend supplies it automatically. Cross-site forms and cross-site fetches
cannot use an authenticated browser to change cameras or rebuild the index.
For a scripted request, supply that header yourself; there is no CORS API.

## 4. Discover cameras and index recordings

If your archive paths are like this:

```text
~/reolink-backup/
  FishEye1/2026/09/30/FishEye 1_00_20260930001821.mp4
  FishEye1/2026/09/30/FishEye 1_00_20260930001819.jpg
  FishEye2/2026/09/30/...
  Wand1/2026/09/30/...
```

Set `source_roots` to `~/reolink-backup`, then run:

```bash
php ctv_php/bin/index.php --discover
```

This discovers cameras and indexes **all existing dates**, including old recordings.
If cameras are already configured, run `php ctv_php/bin/index.php --all`.
The plain command without options also scans the whole archive.

Discovery adds a camera for each first-level source directory, or uses the
configured root itself when it contains date directories. For example, a root
ending in `Wand1` is discovered as `Wand1`, not as a camera named `2026`.
Cameras use date partitions with the pattern `{YYYY}/{MM}/{DD}` and the configured timezone.
Filename timestamps such as `YYYYMMDDHHMMSS` are interpreted in that camera's
timezone. Nearby timestamped JPEGs become thumbnails. Cameras with other layouts
can be configured in the **Cameras** view after logging in.

Whole-archive indexing finds matching date directories rather than guessing a
start date. It scans one partition at a time, skips invalid calendar dates and
paths outside the camera/archive, and revisits previously indexed dates to mark
removed recordings missing. Custom patterns support literal directories and
`{YYYY}`, `{YY}`, `{MM}` and `{DD}` tokens; two-digit years mean 2000–2099.

Use `--date` or `--days` for a smaller scan. With `--days` alone, the range ends
today in each camera's timezone. Opening another day in the viewer still indexes
that day synchronously. Examples:

```bash
php ctv_php/bin/index.php --date=2026-09-30
php ctv_php/bin/index.php --days=2
php ctv_php/bin/index.php --camera=1 --date=2026-09-30 --days=7
```

| Option | Meaning |
| --- | --- |
| `--discover` | Discover camera roots or subfolders, then index |
| `--camera=ID` | Index one camera |
| `--all` | Index every existing or previously indexed date; also the default without `--date`/`--days` |
| `--date=YYYY-MM-DD` | Last date of a limited scan |
| `--days=N` | Number of dates ending on that date |
| `--help` | Display usage |

`--all` cannot be combined with `--date` or `--days`.
Full-directory cameras reconcile their entire source and ignore `--date` and
`--days`. Unchanged MP4s are not parsed again. Failed camera scans are reported
to stderr and return a nonzero exit status; other cameras continue. The settle
window reduces the chance of indexing an unfinished FTP upload but cannot prove
an upload is complete.

## 5. Schedule cron

Use the hosting account's PHP CLI path and absolute repository path. Every
five minutes, including yesterday, is a reasonable starting point:

```cron
*/5 * * * * /usr/local/bin/php /home/USER/apps/cctv-timeline-viewer-core/ctv_php/bin/index.php --days=2 >>/home/USER/cctv-index.log 2>&1
```

Include `--days=2` in cron: a command without a date range scans the whole archive.

Keep the log private. If a scan can last longer than the interval and `flock` is
available, use it to prevent overlapping cron runs:

```cron
*/5 * * * * /usr/bin/flock -n /home/USER/cctv-index.lock /usr/local/bin/php /home/USER/apps/cctv-timeline-viewer-core/ctv_php/bin/index.php --days=2 >>/home/USER/cctv-index.log 2>&1
```

The web application has no persistent worker or live-update connection.
Refresh/reselect the day to load recordings indexed by cron. Initial or large
full-directory scans are best run from the CLI to avoid web request timeouts.

## 6. Check the deployment

Visit the HTTPS URL in a private browser window. A password prompt should appear
before the viewer loads. Without credentials, `/api/session`, a known
`/video/ID` URL and `/api/recordings/ID/thumbnail` must also refuse access.

After login, confirm camera discovery, opening an older date, native playback,
seeking and thumbnails. With `admin => false`, camera changes, manual scans and
rebuilding return 403. PHP streams footage using private, non-stored responses;
frontend assets revalidate after deployments.

## Updates, backups and troubleshooting

Update the whole repository so `ctv_php` and `ctv_web` stay compatible. Preserve
`config.php`, `.htpasswd`, the data directory and the original archive. Pause
cron while deploying. To back up the SQLite index, pause cron and viewer requests
before copying the database; do not copy a live database during writes.
The index can be rebuilt from the archive; never point PHP at the Python
backend's database. **Rebuild index** clears metadata and leaves originals intact.

| Symptom | Check |
| --- | --- |
| Browser setup reports that it is closed (410) | `config.php` already exists; use `php ctv_php/setup.php` or edit the private configuration |
| Browser setup cannot save settings | PHP account can write to `ctv_php`, the password file's parent and data directory; PHP sessions are writable |
| Setup token did not match | Copy the complete value from private `ctv_php/.setup-token`; if resetting an unfinished install, remove that file in the hosting file manager and reload |
| 503 password configuration message | Password path, web PHP permissions, and bcrypt `htpasswd -B` hashes |
| Login repeatedly fails | Username/password; Authorization forwarding in CGI/FastCGI; password-file readability |
| Apache 500 before any JSON response | `.htaccess` uploaded, rewrite module enabled, allowed `Options`/rewrite directives; hosting error log |
| Root loads but API/assets return 404 | Rewrite rules active and document root exactly `ctv_php/public` |
| PHP 500 | PHP error log; `pdo_sqlite`, data permissions, configured timezone |
| No footage | Correct source root, camera timezone/pattern/date; run CLI scan and inspect its log |
| Cameras are named `2026` and scans show zero files | Earlier discovery treated a year folder as a camera. Correct each camera's name/source to the directory above the year, e.g. `Wand1`, or run updated `--discover --all` and remove the old empty year-camera entries in Cameras |
| No thumbnails | JPEG filenames contain timestamps and fall within the configured matching distance |
| Video will not play | Client codec support, upload completion and file readability |
| Scan times out or SQLite is busy | Use CLI for initial scans, avoid overlapping jobs, reduce selected cameras/range or increase hosting limits |

Streaming occupies one PHP worker per active video request. The native-only
implementation suits a modest archive with a few viewers; concurrency and
bandwidth remain subject to the hosting account's limits.

## Development checks

```bash
find ctv_php -name '*.php' -print0 | xargs -0 -n1 php -l
php ctv_php/tests/run.php
python3 ctv_php/tests/test_http.py
python3 ctv_php/tests/test_setup.py
python3 ctv_php/tests/test_indexer.py
node --check ctv_web/js/app.js
node ctv_php/tests/frontend.js
```

HTTP and setup tests use temporary archives, repository copies, SQLite
databases and test-only credentials. They start PHP's local development server
and require Python 3; neither Python nor those test credentials are needed on
the production hosting account.
