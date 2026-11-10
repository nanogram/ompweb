# ompweb · nanogram

[![node version](https://img.shields.io/badge/node-%3E%3D24-44cc11?logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/github/license/nanogram/ompweb.svg?color=44cc11)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/nanogram/ompweb.svg?logo=github)](https://github.com/nanogram/ompweb/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/nanogram/ompweb/pulls)

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

Community: [Join the OMPWEB Discord](https://discord.gg/evqgGzRfM5)

A clean, modern web UI for the [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) coding agent. It reads your local omp sessions and gives you a browser workspace to chat with the agent, browse projects, manage settings, and preview files.

This is the [nanogram fork](https://github.com/nanogram/ompweb) of
[kahme247/ompweb](https://github.com/kahme247/ompweb), version
`0.6.0-n1`. The sidebar badge, version popup, browser title and default
installed-app name identify the fork. An explicit `OMP_WEB_NAME` still wins.
The npm name `@kahme247/ompweb` is retained for compatibility, but its registry
releases are upstream builds, **not this fork**.

See the [November 10 release notes](notes/session-logs/2026-11-10-ompweb-main-release.md)
for the GUI customization, Director, responsiveness and composer changes.

Registry application and daemon updates cannot replace these patches. In
**Settings → System → ompweb application**, choose **Main (upstream)** or
**nanogram fork**. The app stages/builds the selected version in the background;
it does not change the running web server until you restart OMPweb. The explicit
**Restart OMPweb** action and a normal tray/launcher restart use that ready
selection. A failed candidate launch restores the previous web build.

Main is the actual `kahme247/ompweb` GitHub `main` source, pinned to its fetched
commit, with only the shared channel-control UI/API added so you can switch back.
It is not the fork relabeled and not an older npm release. Preparing Main needs
Git, Node 24+, npm, network access and disk space for a separate source build.
The fork target is the installed fork that owns the supervisor. Direct Bun/dev
or compiled-binary launches show why channel switching is unavailable; use the
production Node launcher (including `npm start` or the Windows tray).

Channel switches restart **only the web server**. Keep the separate host daemon
running; its OMP sessions are not restarted. A web version incompatible with that
daemon's protocol is refused before selection. OMP runtime updates remain
independent and available.

![ompweb — live session demo](docs/demo.gif)

<details>
<summary>Screenshots (light / dark)</summary>

![ompweb — light theme](docs/screenshot-light.png)

![ompweb — dark theme](docs/screenshot-dark.png)

</details>

## Requirements

- [omp](https://github.com/can1357/oh-my-pi) installed and available on your `PATH` (or specified via `OMP_WEB_OMP_BIN`)
- Node.js `>= 24`. The server runs on [Bun](https://bun.sh), which installs automatically as a dependency of the npm package (a Bun on your `PATH` is used if the bundled one is missing)

The **Steer** action on a queued follow-up requires an omp runtime with the `promote_queued_message` RPC command (not available in omp 18.1.16). Older runtimes report an error and leave the message queued as a follow-up; ompweb does not send a duplicate steering message.

Queue **Delete** and **Edit** additionally require `remove_queued_message`. Deletion is confirmed by OMP before the chip disappears; editing recalls text only after cancellation succeeds. Unsupported runtimes or messages that are no longer pending leave the queue unchanged and display a notice.

The queue panel shows omp's own queue (`queuedMessages` in `get_state` and `queue_update` events, omp 18.4.4 or later), so every device viewing a session sees the same queued messages. **Stop** moves the text of messages still waiting in the queue back into the composer instead of letting the agent run them; a steer the model already picked up through live steering still runs. Older omp runtimes show no queue panel, and Stop cannot take queued messages back.

## App installation behind authentication

To install the web app, sign in first and use your browser's installation menu.
The single manifest link requests `/api/manifest` with credentials; that endpoint
uses the existing web-password guard and private, revalidating caching. Its
192×192 and 512×512 PNG icons are embedded from the packaged assets because
Android's native installer fetches ordinary icon URLs without authentication
cookies. The app still launches at `/` with scope `/`. Its `theme_color` and
`background_color` come from the manifest link's `?theme=` parameter: Chrome
refreshes an installed app's manifest without cookies, so the server renders the
selected theme's color (remembered in the `omp-theme-color` cookie) into the
link. Chrome 153 and later color an installed app's Android navigation bar from
it after Chrome next checks the app for manifest updates.

Keep Cloudflare Access and application authentication enabled; no public
manifest exception or Access bypass rule is needed. This does not add offline
support. Local Chromium verification covered cookie-gated metadata with HTTP
icon URLs blocked (zero installability errors). The owner also confirmed that
installation on a physical phone works as expected behind Cloudflare Access.

Skill startup notices require an OMP runtime with `get_skill_diagnostics`,
`set_skill_startup_diagnostics`, and `skill_diagnostics_update`. Conflicts and
redundant installations appear above the composer when its OMP session starts;
an empty new-chat page does not start OMP just for diagnostics. **Details** shows
the resolved default, variants, identical copies, backing paths, sources, and
selection reason. The **×** button dismisses the notice for that session until
the diagnostic report changes. **Turn off** and **Settings →
Interface & Behavior → Skill startup notices** use OMP's persisted
`skills.showStartupDiagnostics` preference, not a separate browser setting.
**Settings → Extensions & Tools → Skills → View skill diagnostics** remains
available for a selected running session when notices are off. Inspection does
not resume stopped sessions. Missing support or no running session is unavailable,
not a clean result.

## Conversation controls

**Settings → Interface & Behavior** controls the conversation outline: a desktop
minimap rail, floating button or hidden outline, plus a separate mobile floating
button. Outline entries and search jumps use the same rendered transcript.

**Classic** keeps the existing transcript presentation. Optional **Focused** mode
folds completed progress before the final reply, while live, incomplete and
failed output stays visible. Search reveals folded matches. **Expand Process
details by default** applies in either mode.

**Reopen last chat on startup** is off by default. Enable it to restore this
browser's last-viewed chat in a new tab or on reload; explicit session/workspace
links take priority. Unavailable hosts remain retryable instead of erasing the
saved destination.

Sidebar status marks reflect the outcome: red for errors or exhausted usage,
a static amber question mark for input, and green only for a successful finish
you have not viewed. Viewing the chat clears its green mark. Folder status marks
use the highest descendant priority: error, question, then unread completion;
ordinary idle or running descendants do not add a folder status mark.

Chat history initially loads the newest 50 messages, with a soft 256 KiB page
budget; **Load older messages** prepends earlier pages without losing your place.
Normal browsing indexes only the latest 128 MiB of canonical JSONL. Older bytes
remain saved, and OMP's agent context, exports and edits are not truncated.
An optional browser cache can show recent messages while HTTP revalidates them;
it never restores live controls or authorizes sending before revalidation.

`/goal` uses OMP's native goal state, with pause, resume and drop controls shared
across clients. Native slash commands require support from the installed OMP;
an unsupported command reports an error rather than creating a browser-only goal.
The composer queue shows only messages still waiting in OMP. Once consumed,
a steer or follow-up leaves that panel and appears in the chat transcript,
without a second running/completed copy above the input. A later message with
the same text remains a separate queued submission.

The slow-mode snail button is hidden by default. Enable **Settings → Interface
& Behavior → Show slow-mode button** for this browser. Hiding it does not turn
off native slow mode or hide provider usage-limit warnings.

The composer combines models and reasoning in one picker. Its button shows the
current effort circle beside the model name. Models appear on the left and the
selected model's supported reasoning levels on the right, on desktop and mobile.
Choosing a model keeps the picker open; effort selection waits for OMP to confirm
the model change. Choose a level to close it, or press Escape without changing it.
The picker uses your saved model visibility selection, without a search box,
repeated model caption, prompt hint or provider footer. Manage providers and
visible models in Settings. Opening the picker focuses the selected model;
arrow keys move between models and reasoning.
The popup sits above the entire input box, not its lower model button. It follows
composer resizing and shrinks to the space above it on short/mobile viewports.

Native clients can discover capabilities at `/api/app-info`, request a heartbeat
on their event stream, and search local user/assistant messages with
`/api/sessions/messages/search?q=...&limit=...&cursor=...`. Search is bounded and
cursor-paged, excluding linked hosts, reasoning, tool output, lines above 1 MiB
and files above 64 MiB; inspect `partial`, `cursor` and `skippedFiles`.

## Director

The **Director** entry above Workspaces opens one persistent, real OMP chat.
Its first opening selects the current project. The management panel starts collapsed
on desktop and mobile; click or tap its mode/status row to expand it. **Watched
projects** changes scope, and **Pause / Resume** and **Review now** control
automation. Errors remain visible even while the management panel is collapsed.

The web server watches selected sessions without an open browser. Completion,
errors, pending input and a possible 15-minute lack of progress can trigger
recommendations in the Director chat. It reads bounded status metadata and small
assistant excerpts from already-running sessions, not full worker histories.
Tell the Director your goals and constraints in that chat.

Director starts **observe-only**. Enable **Control sessions in watched projects**
in its chat to grant it server-owned `director_sessions` and `director_control`
tools. It can discover every selected session through bounded pagination, open
an existing native runtime, send a new instruction, steer a running turn, queue a
follow-up or stop the current turn. These tools work without a browser.

Control is checked against the saved project/host scope before each operation.
Pause blocks control, and turning the switch off revokes it without stopping
workers. Pending questions require the human; Director cannot answer approvals,
run shell commands, directly edit files, create/delete chats or control itself.
Its private workspace still disables native tools, extensions and context files
on creation and resume. The global cross-session tools setting is unchanged.

Automatic reviews keep a five-minute cooldown by default; Review now bypasses
pause/cooldown. There is no daily review-count or dollar cap. Today's review
count and OMP-reported cost remain informational, and unavailable cost accounting
does not stop reviews. Quota/error pauses, selected-project authorization and
duplicate-review protection still apply.

Identity, scope and review reservations live under
`<agent-dir>/omp-web/director/`. Web-only restarts rejoin the same native chat;
keep the host daemon and desktop awake. An obsolete Director role reloads only
its own idle native child, retaining its conversation and waiting for pending
preparation or a running turn. Worker sessions and the daemon are not restarted.
An ambiguous creation or delivery is preserved without spawning a replacement
or blindly replaying a review or control command.

## Notifications

Turn on notifications in **Settings → Notifications**. Each browser keeps its own
settings: which events notify (task finished, waiting for input, run failed,
model switched automatically) and what happens while you use omp-web in another
tab (an in-app toast, or always a system notification). Nothing is shown for the
session you are viewing. Clicking a notification opens its session.

- **Push** reaches the browser even when no omp-web tab is open. It needs a
  secure context (HTTPS through your reverse proxy, or `localhost`), and the
  omp-web server needs outbound HTTPS access to the browser vendors' push
  services. omp-web generates its push (VAPID) keys on first use and stores them,
  with the device list and the notification history, in its data directory
  (owner-only), so they survive restarts.
- On **iPhone and iPad** (iOS 16.4 or later), push works only in the app added
  to the Home Screen.
- In a secure context without push support, system notifications appear while
  an omp-web tab is open. Over plain HTTP on a non-localhost address, browsers
  allow no system notifications: only the in-app toasts shown while you use
  omp-web remain.
- Desktop browsers show notifications through the operating system's
  notification center. Push delivery needs the browser process running.

Completion notifications use omp's `prompt_result` and `session_settled` RPC
frames (omp 18.3.1 or later).

Where the browser supports notification actions, confirmations and small
two-choice dialogs can be answered from the notification. Other questions open
the chat. Answers target only the live pending request; answering twice cannot
repeat the action. Connected clients dismiss notifications after settlement.
Offline Apple push notifications cannot be silently retracted without risking
push permission, so they can remain visible until opened or dismissed.


## Quick Start

Build and run the fork from its source checkout (the commands below run from
that directory):

```bash
git clone https://github.com/nanogram/ompweb.git
cd ompweb
npm ci
npm run build
node bin/omp-web.js --no-open
```

In a second terminal, from the same checkout:

```bash
node bin/omp-web.js host
```

Keep that checkout in place while services use it. Do not use
`npx @kahme247/ompweb@latest` or an upstream release to install/update this fork.
For a compiled fork build, see [Single binary](#single-binary).

Open [http://127.0.0.1:30177](http://127.0.0.1:30177) in your browser.

**Migrating an older Next.js installation:** pushing GitHub does not change an
installed tray or service. An old web server owns its OMP children directly;
its first shutdown interrupts them, and the new daemon cannot adopt those
processes. Wait until those runs are finished before replacing the installation.
After the fork's separate daemon owns sessions, restarting only the web server
does not stop them. Never restart the daemon to refresh just the web UI.

Before the first upgraded web/daemon start, explicitly choose upload retention.
Set `"uploadRetentionDays": null` in the server's `omp-web-settings.json` to
retain existing sent uploads rather than applying the 30-day default. Preserve
any retention policy you already selected. Canonical chat histories are separate.

### CLI Options

```bash
ompweb --port 8080                         # Custom port
ompweb --hostname 0.0.0.0                  # Listen on network
ompweb hash-password                       # Print the value for OMP_WEB_PASSWORD_HASH
ompweb --no-open                           # Don't auto-open the browser
ompweb --install-tray                      # Install Windows System Tray service & Desktop shortcuts
ompweb --uninstall-tray                    # Uninstall Windows System Tray service & shortcuts
ompweb --tray                              # Start background System Tray manager
ompweb systemd install                     # Install Linux systemd user services (web + ompweb-host daemon)
ompweb launchd install                     # Install the macOS launchd agents (web + ompweb-host daemon)
ompweb --help                              # Show help
ompweb --version                           # Show version
```

### Password protection

omp-web **never passes a plaintext password to the server**, because every
`omp` session inherits the server's environment: an agent running `env` would
print the password into its session file and send it to the model provider.
`--password` stops `ompweb` at startup. An `OMP_WEB_PASSWORD` still works for
now: `ompweb` hashes it at startup, keeps it out of the server's environment,
and logs a warning with the hash to put in `OMP_WEB_PASSWORD_HASH` instead.
Switch soon: agents can still read the plaintext from the `ompweb` launcher
process, and each start makes a new hash, so every restart signs all browsers
out. Setting both variables stops `ompweb`; remove `OMP_WEB_PASSWORD`.

Generate a hash instead and give that to the server:

```bash
ompweb hash-password                       # asks twice, input hidden
echo "a-long-random-password" | ompweb hash-password   # or pipe it in

OMP_WEB_PASSWORD_HASH='scrypt$15$8$1$…' ompweb
```

`ompweb hash-password` reads the password from stdin — never from a command
line argument — so it stays out of your shell history and out of `ps` output.
The hash is scrypt (N = 2^15, r = 8, p = 1) with a fresh 16-byte salt, printed
in the self-describing form `scrypt$<ln>$<r>$<p>$<salt>$<digest>`. Anyone who
reads the hash cannot sign in with it, and it cannot be turned back into the
password.

Sessions are not signed with the password hash. A random signing key is created
on first start in `~/.omp/agent/omp-web/web-auth-secret.json` (mode `0600`) and
mixed with the hash, so changing the password still signs everyone out while the
stored hash alone is never enough to forge a session.

The service installers (`ompweb systemd install`, `ompweb-launchd install`, the
Linux tray, and the Windows service) still accept `OMP_WEB_PASSWORD` at install
time and hash it before writing it to their configuration. Only the hash is
stored.

On Windows, the tray and background service read `OMP_WEB_PASSWORD_HASH` from
your user or system environment (for example `setx OMP_WEB_PASSWORD_HASH
"scrypt$…"`) each time they start the server, not from the environment they were
started with. Changing or removing the hash takes effect at the next server
restart, without signing out of Windows.

### Behind a reverse proxy

Forward WebSocket upgrades on `/api/events/link` (browsers) and `/api/hosts/link` (hosts); without the upgrade, a browser falls back to server-sent events after a few seconds. In nginx that means `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade;`, `proxy_set_header Connection "upgrade";`, and a `proxy_read_timeout` well above 30 s.

### Two services: the web server and the local daemon

ompweb runs this machine's `omp` sessions through a small daemon, `ompweb host`,
linked to the web server over loopback. The service installers (`ompweb systemd install`,
`ompweb launchd install`, `ompweb --install-tray`) install both: the web
service and `ompweb-host`. Uninstall removes both.

**Running from source** (`node bin/omp-web.js`) installs no service: keep
`node bin/omp-web.js host` running in a second terminal.
Without it "This machine" stays offline. The web server writes
the daemon's link when it starts, so start the web server first.

- **Restarting or redeploying the web server does not interrupt runs.** The daemon
  keeps the omp processes running; the restarted web server takes them over, with
  no resume prompt, and dialogs or tool calls omp was waiting on reappear.
- **Restarting the daemon does end runs** (it owns the omp processes). With auto-resume
  on, sessions that were running resume once. `ompweb systemd restart` restarts the
  web service only; upgrades restart the daemon only when its link protocol version
  is outside the range the new release supports.
- **First start after an upgrade:** if no daemon has linked after about 90 seconds,
  ompweb shows a banner with the install command for your platform. It never installs
  services itself. Until the daemon runs, "This machine" shows offline and new
  sessions on it cannot start.
- **It is a host like any other.** Rename "This machine" in **Settings → Hosts**
  (clear the name to reset it); it cannot be revoked. The web server writes the
  daemon's link (`~/.omp/agent/omp-web/host.json`, mode `600`) at startup, only
  for a loopback bind address.
- **Development:** `npm run dev` does not take the daemon (see
  [Development](#development)).

### Single binary

Build this fork with `npm run build:binary` (or pass
`-- --target bun-<os>-<arch>` for another supported platform). The output is one
compiled program with its web files beside it, packaged as
`ompweb-linux-x64.tar.gz`, `ompweb-linux-arm64.tar.gz`,
`ompweb-darwin-x64.tar.gz`, `ompweb-darwin-arm64.tar.gz` or
`ompweb-windows-x64.zip`. These need no Node, npm or Bun; only omp must be
installed. The x64 builds use Bun's baseline runtime for CPUs without AVX2.
Each archive includes its dependency licenses in `licenses/`.
Upstream release downloads do not contain this fork's patches.

```bash
tar -xzf ompweb-linux-x64.tar.gz -C ~/.local/share   # unpacks ompweb-linux-x64/
~/.local/share/ompweb-linux-x64/ompweb               # the web server: same options and environment variables as above
~/.local/share/ompweb-linux-x64/ompweb host          # the local daemon, in a second terminal
```

- **Keep `ompweb` in its directory.** It serves `dist/`, `public/` and the other
  files from the directory it is in (a symlink to it on your `PATH` works), or
  from `OMP_WEB_PACKAGE_DIR` when that is set.
- **macOS** quarantines downloads: run `xattr -dr com.apple.quarantine ompweb-darwin-arm64`
  once before the first start.
- **macOS 15 and later** ask before an app may reach your local network. If
  `ompweb host` on a Mac reports `ECONNREFUSED` for a server on your LAN while
  `curl` reaches it, allow your terminal (or `ompweb`) under System Settings →
  Privacy & Security → Local Network. A server reached over a VPN such as
  Tailscale, or a host started from an SSH session, is not affected.
- **No tray, service installers or in-app update.** To update, wait for daemon
  sessions to finish, stop both processes, replace the fork build directory and
  start both again. Settings links the fork source for manual updates.
  Your sessions and settings live in `~/.omp`, not in that directory.
- **As systemd user services**, write the two units yourself (adjust the paths;
  add omp's directory to `PATH`, or set `OMP_WEB_OMP_BIN`):

```ini
# ~/.config/systemd/user/ompweb.service
[Unit]
Description=ompweb web service

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb --no-open
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
# OMP_WEB_PASSWORD_HASH, PORT and OMP_WEB_HOSTNAME go here, as for ompweb-systemd.
EnvironmentFile=-%h/.omp/agent/web-service.env
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/ompweb-host.service
[Unit]
Description=ompweb host daemon
# It exits until the web server has written its link: keep restarting.
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.omp/agent/web-service.env
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb ompweb-host
```

  On macOS, two launchd agents (`ProgramArguments` `…/ompweb --no-open` and
  `…/ompweb host`, with `RunAtLoad` and `KeepAlive`) do the same; on Windows, two
  Task Scheduler tasks that run `ompweb.exe --no-open` and `ompweb.exe host` at logon.

### Run as a Windows Service (System Tray)

Install ompweb as a Windows background service with a system tray icon and autostart at login:

```bash
ompweb --install-tray
```

Manage it from **Settings → System → Windows Background Service**, or via CLI:

```bash
ompweb --tray          # Start the tray manager
ompweb --uninstall-tray
```

Shortcuts are created on the Desktop and Start Menu. The service restarts automatically and shows the current port and status in the tray. The install also registers the [local daemon](#two-services-the-web-server-and-the-local-daemon) as a second scheduled task (`ompweb host`); the tray shows both states.

### Run as a macOS Service (launchd)

Install ompweb as a launchd user agent that starts at login and restarts on crash:

```bash
node bin/omp-web-launchd.js install
```

Manage it with:

```bash
node bin/omp-web-launchd.js status      # Show service state
node bin/omp-web-launchd.js uninstall   # Stop and remove
```

The fork's default service target is this local build, not an upstream npm
package. Keep the checkout in place. All
[environment variables](#environment-variables) are read at install time and
baked into the plist; `OMP_WEB_PKG` or a positional argument can explicitly
select another package target.
As a service, the browser is **not** auto-opened by default — install with
`OMP_WEB_NO_OPEN=0` to restore that.

```bash
OMP_WEB_PASSWORD=secret node bin/omp-web-launchd.js install
```

`OMP_WEB_PASSWORD` is hashed at install time; the plist holds the hash, never
the password. Pass `OMP_WEB_PASSWORD_HASH` to install a hash you generated with
`ompweb hash-password`.

When binding to a non-loopback host, require authentication (`OMP_WEB_PASSWORD_HASH`
or equivalent access control) and HTTPS through a trusted reverse proxy or VPN.
Never expose the unauthenticated web UI or send its password/session cookie over
plaintext HTTP.

Logs go to `~/Library/Logs/ompweb/ompweb.log` (web) and
`~/Library/Logs/ompweb/ompweb-host.log` (the
[local daemon](#two-services-the-web-server-and-the-local-daemon)). The plists live at
`~/Library/LaunchAgents/com.kahme247.ompweb.plist` (mode 600; the password
hash — not the password — is stored there) and
`~/Library/LaunchAgents/com.kahme247.ompweb-host.plist`.

### Run as a Linux Service (systemd)

Install ompweb as a systemd **user** service that starts at login and restarts
on crash:

```bash
node bin/omp-web-systemd.js install
```
The installer creates `~/.omp/agent/web-service.env` automatically with mode
`600`; no manual file creation is required.

To bind the service to all IPv4 interfaces for LAN access, set a password while
installing:

```bash
OMP_WEB_HOSTNAME=0.0.0.0 OMP_WEB_PASSWORD='change-me' \
  node bin/omp-web-systemd.js install
```

The password is hashed before it is written to `web-service.env`.

Manage it with:

```bash
node bin/omp-web-systemd.js status    # Show service state
node bin/omp-web-systemd.js restart   # start / stop / restart
node bin/omp-web-systemd.js uninstall # Stop and remove
```

The service runs the locally installed `ompweb` binary resolved at install time
(override with `OMP_WEB_SYSTEMD_BIN`). Runtime configuration lives in
`~/.omp/agent/web-service.env` — the tray (or any editor) can change the port,
hostname, and password hash there and just restart the service; no reinstall
needed.
Install-time [environment variables](#environment-variables) are baked into
that file. As a service, the browser is **not** auto-opened by default. The
units live at `~/.config/systemd/user/ompweb.service` and
`~/.config/systemd/user/ompweb-host.service` (the
[local daemon](#two-services-the-web-server-and-the-local-daemon)); logs go to
the journal:

```bash
journalctl --user -u ompweb -u ompweb-host -f
```

On a headless server, enable user lingering if the service must keep running
after the last login session ends:

```bash
loginctl enable-linger "$USER"
```

### Linux System Tray (KDE Plasma and compatible)

On Linux, `ompweb-tray` registers a StatusNotifierItem tray icon with a context
menu: open the web UI, copy its URL, start/stop/restart the systemd service,
view logs, expose the web UI to the network, change the port, set the web
password, toggle autostart, and quit the tray.

```bash
node bin/omp-web-tray.js --install      # Icons + autostart + start tray
node bin/omp-web-tray.js --status       # Tray and service status
node bin/omp-web-tray.js --uninstall    # Remove autostart, stop tray
```

**Expose to Network** rebinds the service from `127.0.0.1` to `0.0.0.0` so the
web UI is reachable from your LAN or VPN (e.g. Tailscale). Leaving loopback
requires a web password — the tray prompts for one via `kdialog`/`zenity` when
needed, and stores its hash. **Change Port…** and **Set Web Password…** edit
`~/.omp/agent/web-service.env` and restart the service. When binding to a
non-loopback host, use HTTPS through a trusted reverse proxy or VPN for remote
access.

"Start with Plasma" in the tray menu toggles a desktop autostart entry at
`~/.config/autostart/ompweb-tray.desktop`. Requires a running StatusNotifierItem
host (KDE Plasma, and most Wayland/X11 desktops).

## Run sessions on another machine

One ompweb can start and watch omp sessions on other machines. Each machine keeps
its own `omp` install, `~/.omp/agent` directory, sessions, and credentials;
ompweb only routes. The remote machine needs `omp` and either Node 24 with a fork checkout or
the [single binary](#single-binary), and must be able to reach the ompweb server over
HTTP(S). It dials out, so it can sit behind NAT.

1. On the ompweb server, open **Settings → Hosts → Add host**, enter a name, and copy
   the token. The token is shown once; only its hash is stored.
2. On the remote machine, save the link. The token is read from stdin, never from
   an argument, so it does not show up in `ps`:

   ```bash
   node bin/omp-web.js host login --url https://your-ompweb.example.com
   ```

   Paste the token when prompted (or pipe it in). It is saved to
   `~/.omp/agent/omp-web/host.json` with mode `600`.
3. Start the link and leave it running:

   ```bash
   node bin/omp-web.js host
   ```

   The host shows **online** in Settings → Hosts, the sidebar gets a group for it,
   and the new-session screen gets a host picker.

**Settings → Hosts** shows the daemon and OMP runtime versions for each machine,
including **This machine**. This fork disables automatic daemon installation
and links its source for manual updates; application updates follow the same
policy in **Settings → System**. OMP checks and updates still run independently
on the selected host. Existing OMP processes keep their loaded runtime until
they restart.

Update fork web servers before their daemons so link protocol versions remain
compatible. Wait until a daemon has no active sessions or subagents before
stopping it for a manual upgrade; stop external restart loops too. If the web
server and daemon share one installation, coordinate both against the same fork
build. Never replace the directory while either process is still using it.

`https://` is required. Plain `http://` is accepted only for loopback addresses, or
with `--allow-http` (for example on a tailnet):

```bash
node bin/omp-web.js host login --url http://100.64.0.1:30177
node bin/omp-web.js host --allow-http
```

If the connection drops, the daemon reconnects by itself (1 s backoff doubling to
60 s; 3 s at most for the web server on the same machine). After a failed dial it
re-reads its saved link, so a web server that came back on another port is found
without restarting the daemon. After a network drop, runs keep going on the remote machine; the chat shows
an offline banner and the runs reattach when the link returns. A laptop that goes
to sleep (closing the lid, usually) pauses the daemon and its omp runs along with
everything else on it: they resume when it wakes, and the link returns then. A
docked or no-sleep setup keeps running with the lid closed. Revoking a host in
Settings closes its link and the daemon stops its omp processes.

A reverse proxy must forward the upgrade on `/api/hosts/link`; see [Behind a reverse proxy](#behind-a-reverse-proxy).

Update ompweb on the server before its hosts: a host from before this version shows **needs upgrade** until it is updated.

Notes:

- **Service helpers:** `ompweb systemd install` and `ompweb launchd install` set up
  this machine's own daemon next to its web server (see
  [Two services](#two-services-the-web-server-and-the-local-daemon)). On the other
  machine you only need the daemon, so use
  [Keep a host running as a service](#keep-a-host-running-as-a-service) instead.
  The daemon exits with code `1` when the server revokes its token or when its
  link protocol version is outside the range the server supports (older than the
  server's oldest supported version, or newer than the server: update ompweb on
  the older side), and `0` when a newer link for the same host replaces it.
  SIGTERM or SIGINT stops the daemon and its omp processes.
  A link is one-per-host, so never run two daemons with the same token.
- **The server's agent directory holds the host list** (`omp-web/hosts.json`).
  Starting the ompweb server with a different `PI_CODING_AGENT_DIR`, or losing
  that file, makes every host token unknown: each daemon is told it was revoked,
  stops its omp processes and exits.
- **Trust:** a linked host runs omp with full tool access on that machine for
  whoever controls the ompweb server or the token. Keep the token private and
  revoke it when a machine is retired.
- **Workspace files on every host:** Explorer, previews, downloads, file search,
  @-mentions and live file watching use the owning machine's daemon, including
  This machine. Explorer uploads accept up to 2 GiB per file with no 100 MiB batch
  cap; preview limits remain 256 KiB for text and 10 MiB for images/DOCX.
  Video previews stream MP4/M4V, MOV, WebM and OGV with byte-range support instead
  of using the text limit. Playback depends on browser codec support; downloads
  remain available when a format cannot play.
  File tabs retain their source host when you switch chats. An unavailable or
  older daemon reports offline or asks for an update; main never substitutes its
  own filesystem.
- **Git and worktrees on every host:** status, diffs, GitHub issue links, and
  worktree creation, selection and removal run on the owning daemon. Dirty
  worktrees still require explicit force confirmation. Switching a worktree
  changes where new sessions start, not an open conversation.
- **Directory browsing and cloning on every host:** the Add workspace picker
  navigates that host's directories and clones HTTPS/SSH repositories there.
  Cancelling waits for the clone process and safe cleanup; interrupted connections
  report an unknown outcome rather than pretending the clone was cancelled.
  If the destination changes during cleanup, captured data is preserved in a
  private quarantine and the error gives its location; inspect it before removing
  or restoring anything.
- **Not available on remote hosts yet:** session archiving and the Skills,
  Plugins, Agents and MCP settings. Transcript search still scans this machine.
- **Agent-started sessions:** with agent tools enabled, an agent can pass a `host`
  to `new_session` (it defaults to the agent's own host). A remote host asks for
  confirmation each time unless **Agents can start sessions here without asking**
  is switched on for it in Settings → Hosts. An agent running on a remote host
  always asks before it starts or messages a session on this machine.

### Keep a host running as a service

These run the [single binary](#single-binary) in host mode. On Linux and Windows a
service keeps the link up across logouts and reboots; on macOS a script keeps it
running in a terminal (see below for why). Unpack the release for the machine first,
then save the link once with `ompweb host login --url …` as in step 2 (with the
binary's path in place of `node bin/omp-web.js`). Each setup starts
`ompweb host` again 10 seconds after it fails, but not after exit 0: that means a
newer link with the same token replaced it, and restarting would take the link back
every 10 seconds. Add `--allow-http` after `host` if
the server URL is plain `http://`, and set `PI_CODING_AGENT_DIR` in the service too
if you saved the link with it set. A machine links to one server: do not also run an
ompweb web server on it, which writes the same link file for its own daemon. To
update, stop the service, replace the release directory, and start it again. After
revoking a host, stop and remove its service: it otherwise keeps retrying.

**Linux (systemd user service).** Create `~/.config/systemd/user/ompweb-host.service`
(adjust the release path, and add omp's directory to `PATH` or set `OMP_WEB_OMP_BIN`):

```ini
[Unit]
Description=ompweb host
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h
ExecStart=%h/.local/share/ompweb-linux-x64/ompweb host
Environment=PATH=%h/.local/bin:%h/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
# Exit 0: a newer link for this host replaced it. Restarting would take the link back.
RestartPreventExitStatus=0
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now ompweb-host
loginctl enable-linger "$USER"            # keep it running while you are logged out
journalctl --user -u ompweb-host -f       # logs
```

**macOS (from a terminal).** No launchd job can run a host that omp sessions can
fully use: a LaunchDaemon has no login keychain or SSH agent, which sessions need
for SSH keys and commit signing, and a LaunchAgent cannot reach LAN addresses. A
process started from a terminal inherits the terminal's keychain and SSH agent, so
run the host there, in tmux so it outlives the window.

tmux does not keep the terminal's Local Network permission, though: the tmux server
detaches from the terminal app, and macOS Local Network privacy then blocks the
ad-hoc signed `ompweb` binary from LAN addresses (`connect` fails with "No route to
host", which the daemon reports as `ECONNREFUSED`; Apple's own tools such as `curl`
are not blocked, so a `curl` test passes). Link the host to a URL that does not
resolve to a LAN address, for example the server's public URL, or its VPN or
tailnet name (a Tailscale MagicDNS name served by your reverse proxy with its own
certificate). Save this as `~/.local/bin/ompweb-host-run` (adjust `DIR`) and make
it executable with `chmod +x`:

```sh
#!/bin/sh
# Keeps `ompweb host` running in this terminal, which lends it its keychain and SSH agent.
# Restarts it 10 s after a crash; stops when the token is revoked or the link protocol is
# unsupported (exit 1), or on exit 0: a newer link replaced it, or it was stopped (Ctrl-C).
DIR=${OMPWEB_DIR:-$HOME/.local/share/ompweb-darwin-arm64}
# A tmux started over SSH sees the login keychain locked: unlock it while a terminal can ask.
security show-keychain-info login.keychain-db 2>/dev/null || security unlock-keychain login.keychain-db || exit 1
while :; do
	(cd "$DIR" && exec ./ompweb host)
	rc=$?
	case $rc in 0 | 1) exit "$rc" ;; esac
	echo "ompweb host exited $rc; restarting in 10 s" >&2
	sleep 10
done
```

Run `ompweb-host-run` in a tmux window; Ctrl-C stops the daemon and its sessions.
Start it again after a reboot or logout. If the login keychain locks itself after
inactivity or on sleep, SSH key passphrases and signing fail until you restart it.

**Windows (scheduled task at logon).** In PowerShell, with `$dir` set to the
unpacked release:

```powershell
$dir = "$env:LOCALAPPDATA\ompweb-windows-x64"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.omp\agent\logs" | Out-Null
Set-Content "$dir\ompweb-host.ps1" @'
# Starts `ompweb host` again 10 s after it fails, and stops on exit 0 (a newer link replaced it).
# Output goes to ~\.omp\agent\logs\ompweb-host.log, moved to .log.1 past 10 MB (checked between restarts).
# For a plain http:// server URL, put --allow-http after `host` below.
$log = "$env:USERPROFILE\.omp\agent\logs\ompweb-host.log"
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item $log "$log.1" -Force }
  & "$PSScriptRoot\ompweb.exe" host 2>&1 | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 $log
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep 10
}
'@
Register-ScheduledTask -TaskName ompweb-host -Force `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME") `
  -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\ompweb-host.ps1`"") `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries)
Start-ScheduledTask ompweb-host
```

Stop it with `Stop-ScheduledTask ompweb-host`, then end the running host with
`Get-Process ompweb | Where-Object Path -eq "$env:LOCALAPPDATA\ompweb-windows-x64\ompweb.exe" | Stop-Process`
(only this release's `ompweb.exe`; adjust the path as for `$dir`). Remove it with
`Unregister-ScheduledTask ompweb-host`.

## Features

- **Interactive Chat**: Real-time streaming conversation with your local `omp` agent — tool calls, thinking levels, token counts, cost, context gauge, queue controls, and interrupt & retry.
- **Message Copy**: Copy user messages and completed assistant replies as rendered plain text using the Copy button below each message. Thinking, tool output, and message controls are excluded. Oversized messages that use the raw-text viewer copy their full source.
- **Queue Deletion Confirmation**: Preview and confirm before cancelling queued follow-ups or steered messages in OMP. Requires native `remove_queued_message` support; already-delivered messages cannot be recalled.
- **Session Management**: Browse past conversations by project, fork sessions, branch within a session, archive/restore, import session files, and deep-link via URL.
- **Draft Recovery**: Unsent text stays scoped to its conversation or new-session workspace and is restored after Back/Forward navigation or reload in the same tab when browser storage is available (up to 50 drafts). Images and file attachments remain in memory only.
- **Automatic Composer**: Running sessions use a compact status/Stop bar by default; idle sessions and pending questions/approvals show the full input area. Click the compact bar to write a follow-up. Expansion lasts for that run, and drafts/attachments remain mounted through visibility changes. No manual collapse arrow is needed.
- **Live Plans & Subagents**: Collapsible panels pinned above the composer track live todo phases and running subagents (status, tool, retries, tokens/cost, nested tasks) with transcript dialogs and history recovery. Their summary bars stay bottom-aligned while details expand upward; active panels share the row, and a sole panel fills it.
- **Tool Preset Picker**: Choose the toolset for new sessions in the composer — `none` / `default` (`read,bash,edit,write`) / `full` (all tools including subagents). Persists to localStorage.
- **File Explorer & Previews**: Browse workspaces side-by-side with chat; preview code, markdown, Mermaid, images, audio, video, PDFs, DOCX, and diffs with allow-listed access.
- **Desktop File Actions**: Right-click supported local document/media links in chat, tool rows or Markdown file previews to choose **Open in system app**, **Preview in OMPweb**, or **Download file**. File viewers also have a system-app toolbar button. Native opening uses the default application on the computer running OMPweb—not a remote browser's device—and requires a graphical desktop/file association. Linked-host files and executable/script/shortcut types cannot use native opening. Shift-right-click preserves the browser menu; phone links keep their normal behavior.
- **Git Worktree Support**: Create, switch, and manage Git worktrees directly from the sidebar; sessions and file roots stay grouped by project.
- **Remote Hosts**: Link other machines (for example a MacBook) and run sessions there from one ompweb. The sidebar groups sessions by host. See [Run sessions on another machine](#run-sessions-on-another-machine).
- **Usage & Analytics**: Dashboard in **Settings → Usage** for tokens, costs, cache savings, and breakdowns by provider / model / day / project with SQLite persistence.
- **Windows System Tray & Service**: Background service, tray icon, logon autostart, and Desktop/Start Menu shortcuts (Windows).
- **macOS launchd Service**: LaunchAgent that starts at login, restarts on crash, and logs under `~/Library/Logs/ompweb`.
- **Linux systemd Service & Tray**: User service that starts at login and restarts on crash, plus a StatusNotifierItem tray icon with service controls (KDE Plasma and compatible desktops).
- **Notifications**: Desktop and mobile (PWA) notifications for finished tasks, questions waiting for an answer, failed runs, and automatic model switches, with Web Push when served over HTTPS. See [Notifications](#notifications).
- **Web-based Settings** (11 tabs): Interface & Behavior, Safety & Approvals, AI Model Defaults, API Keys & Providers, Usage, Agent & Intelligence (advisor, memory, compaction), Agents, Extensions & Tools (MCP, skills, plugins), Hosts, Notifications, System.
- **Slash Commands & Shortcuts**: Quick prompts (`/plan`, `/review`, `/fix`, `/test`, etc.), `⌘K` / `Ctrl+K` palette, and model/reasoning cycling.
- **UI Themes & Localization**: Warm paper light/dark themes plus an omp.sh-inspired midnight (`omp`) theme, chat font size & interface scale, with full English, Simplified Chinese (简体中文), Traditional Chinese (繁體中文), and Japanese (日本語) translations.

## Environment Variables

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Server port | `30177` |
| `OMP_WEB_HOSTNAME` | Server bind host | `127.0.0.1` |
| `OMP_WEB_PASSWORD_HASH` | Optional scrypt hash of the web login password, from `ompweb hash-password`. Required for a non-loopback bind | _None (auth disabled)_ |
| `OMP_WEB_TRUSTED_HEADER_SHA256` | SHA-256 hex digest of the secret a trusted reverse proxy sends in `X-Omp-Web-Auth` to skip the password for that request; see [Skipping the password on trusted networks](#skipping-the-password-on-trusted-networks) | _None (disabled)_ |
| `OMP_WEB_NO_OPEN` | Set to `1` to prevent auto-opening browser | `0` |
| `OMP_WEB_DISABLE_AUTOUPDATE` | Set to `1` to disable OMP runtime checks and updates too; fork application/daemon updates are always manual. Restart after changing | `0` |
| `OMP_WEB_NAME` | Name shown in browser tabs and installed-app names. `url`, `host` or `domain` (any case) uses the connected hostname without its port; localhost and IP addresses keep the default fork name. Any other value is used as-is. Restart after changing | `omp web · nanogram` |
| `OMP_WEB_OMP_BIN` | Path to `omp` binary if not on `PATH` | _auto-detected_ |
| `PI_CODING_AGENT_DIR` | Custom omp agent directory | `~/.omp/agent` |
| `OMP_WEB_STT_ENDPOINT` | OpenAI-compatible transcription endpoint URL. Leave unset to transcribe with `OMP_WEB_STT_MODEL` through omp's own credentials | _None_ |
| `OMP_WEB_STT_KEY` | Optional API key for the STT endpoint | _None_ |
| `OMP_WEB_STT_MODEL` | Model name for the STT endpoint. Without an endpoint: an omp speech-to-text model run with omp's logins, such as `openai-codex/codex-transcribe` (ChatGPT subscription; needs an omp version with that model) | _None (disabled without an endpoint)_ |

**`OMP_WEB_NAME` and installed apps.** An installed app (PWA) is usually named after the page it was installed from. If you later change `OMP_WEB_NAME`, or reach omp-web through a different address while `OMP_WEB_NAME` is `url`, `host` or `domain`, your operating system may rename the installed app as well. Leave `OMP_WEB_NAME` empty, or set a name that identifies this omp-web server whatever domain name or address is used to reach it.

## Skipping the password on trusted networks

omp-web cannot see the client's address itself, so it leaves the decision to
your reverse proxy. The proxy sends a secret in the `X-Omp-Web-Auth` header,
and omp-web holds only that secret's SHA-256 digest in
`OMP_WEB_TRUSTED_HEADER_SHA256`. A request whose header hashes to that digest
is treated as signed in. Everyone else still signs in with the password whose
hash is in `OMP_WEB_PASSWORD_HASH`; without a password there is nothing to
skip, and the header is ignored. Keep omp-web bound to `127.0.0.1` so only the
proxy reaches it.

Generate the secret and its digest without typing the secret on a command line,
so it never lands in your shell history. This writes a random secret straight
into an nginx include file readable only by root and nginx, and prints only the
digest:

```bash
secret=$(openssl rand -hex 32)
printf 'map $ompweb_trusted $ompweb_auth {\n    1        "%s";\n    default  "";\n}\n' "$secret" \
  | sudo install -m 0640 -o root -g www-data /dev/stdin /etc/nginx/ompweb-auth.conf
printf %s "$secret" | sha256sum | cut -d' ' -f1
unset secret
```

Use your nginx group in place of `www-data` (`nginx` on some distributions).
Set the printed digest as `OMP_WEB_TRUSTED_HEADER_SHA256`. The command history
holds only the commands, never the secret. On Windows, the tray and background
service read it from your user or system environment, like
`OMP_WEB_PASSWORD_HASH`.

Always generate the secret this way; do not reuse a password or another chosen
value. omp-web stores only a fast, unsalted SHA-256 digest, which is safe only
for a long random secret: anyone who reads the digest could recover a short or
guessable one with a dictionary attack.

With nginx, send the secret only to the address ranges you trust:

```nginx
# http {} context
geo $ompweb_trusted {
    default       0;
    10.0.0.0/16   1;
}
include /etc/nginx/ompweb-auth.conf;  # the map written above

# the location that proxies to omp-web
proxy_set_header X-Omp-Web-Auth $ompweb_auth;
```

Always set the header, as above: the empty value for other clients replaces any
`X-Omp-Web-Auth` a client sends itself. nginx only inherits `proxy_set_header`
from outer blocks when a block sets none of its own, so put this line next to
the location's other `proxy_set_header` lines.

Serve omp-web only for its own hostname: give its `server` block an explicit
`server_name`, and add a `default_server` block that answers every other
hostname with `return 444;`. Otherwise a web page that a trusted browser visits
can point its own domain name at your nginx (DNS rebinding) and have nginx add
the secret to its requests.

`geo` checks `$remote_addr`, the address that connected to nginx. When clients
reach nginx through another proxy, use the
[`realip` module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) to
replace it with the real client address. It does so only for connections from
addresses you list in `set_real_ip_from`:

- **Cloudflare (proxied DNS):** trust `CF-Connecting-IP`, and only from
  Cloudflare. List every range from <https://www.cloudflare.com/ips-v4/> and
  <https://www.cloudflare.com/ips-v6/>, and keep them up to date. Use this only
  when Cloudflare is really in front.

  ```nginx
  set_real_ip_from 173.245.48.0/20;  # ...one line per Cloudflare range
  real_ip_header   CF-Connecting-IP;
  ```

  Also refuse connections that come neither from Cloudflare nor from your
  trusted ranges. `$realip_remote_addr` is the address that actually
  connected, before `realip` replaced it:

  ```nginx
  geo $realip_remote_addr $ompweb_peer_allowed {
      default          0;
      173.245.48.0/20  1;  # ...every Cloudflare range
      10.0.0.0/16      1;
  }
  # in the server block
  if ($ompweb_peer_allowed = 0) { return 403; }
  ```

- **Cloudflare Tunnel (`cloudflared`):** the tunnel connects to nginx from
  `cloudflared`'s address (`127.0.0.1` when it runs on the same machine), so
  trust `CF-Connecting-IP` from there: `set_real_ip_from 127.0.0.1;` and
  `real_ip_header CF-Connecting-IP;`. Any local process can then send its own
  `CF-Connecting-IP` to nginx and claim a trusted address, and a local
  connection without that header keeps `127.0.0.1`, so listing `127.0.0.1` in
  `$ompweb_trusted` trusts every local process that connects to nginx.
- **Any other proxy or load balancer:**

  ```nginx
  set_real_ip_from  <proxy address or range>;
  real_ip_header    X-Forwarded-For;
  real_ip_recursive on;
  ```

  `real_ip_recursive on` reads `X-Forwarded-For` from the right and skips the
  hops listed in `set_real_ip_from`. Addresses a client adds itself are
  ignored.

## Development

```bash
git clone https://github.com/nanogram/ompweb.git
cd ompweb
npm ci
npm run dev
```

The dev server runs at [http://127.0.0.1:30178](http://127.0.0.1:30178).

A normal dev server does not take over the local daemon: only the production web
server writes the daemon's `host.json`, so "This machine" shows offline in `npm run dev`
and the daemon stays linked to your installed ompweb. The explicit GUI-only
workflow below adds a secondary link instead.

`npm run dev` runs the server with Bun hot reload. `npm run build` bundles the browser app into `dist/`, and `npm start` serves it on port 30177 (`npm run smoke` checks the result). `npm run dev:lan` binds the dev server to all interfaces. `npm run build:binary` builds the [single binary](#single-binary) for this machine into `release/` (`-- --target bun-linux-arm64` and the like for another platform; `npm run smoke -- --binary release/ompweb-linux-x64/ompweb` checks it).

### Live GUI customization without interrupting sessions

With the normal web server and its separate host daemon already running, use a
full source checkout with dependencies installed:

```bash
npm run dev:ui
# Optional: another checkout or free loopback port
npm run dev:ui -- --source /path/to/ompweb --port 30179
```

Open the printed preview URL (default `http://127.0.0.1:30178`). It shares the
existing daemon and native sessions; it does not start, restart or stop either.
The installed production web app stays untouched.

For phone access through an HTTPS VPN endpoint, name its exact trusted origin:

```bash
npm run dev:ui -- --public-url https://ompweb.example.ts.net:8446 --proxy-port 30179
# Route that HTTPS endpoint to http://127.0.0.1:30179, not the Bun port 30178.
```

The optional loopback ingress admits only that Host. It translates same-origin
headers only for Bun's reserved `/_bun/` assets and HMR socket, working around
[Bun 1.4.4's named-host restriction](https://github.com/oven-sh/bun/issues/47325).
API authentication, cookies and CSRF checks retain the original public Host and
Origin. Other browser origins
cannot use the privileged HMR translation. The default ingress port is the
preview port plus one (65534 when the preview uses 65535).

The trusted ingress streams gzip for Bun's JavaScript and CSS assets instead of
transferring the uncompressed development bundle to phones. Browser-cached assets
revalidate against Bun's current ETag: unchanged files return 304 without another
body, while changed GUI revisions load immediately. This does not cache API
responses, buffer whole bundles per client, or change HMR socket/origin checks.

Keep the endpoint on a trusted VPN with the same access protections as
production. Development assets expose source code; never expose this workflow
to the public internet or configure a wildcard public origin.

The launcher makes a private, temporary source snapshot, links installed
dependencies and coalesces filesystem changes at 750 ms intervals, without
recursively rescanning an idle checkout. Only these display paths
are published as complete, staged files into the running preview:

- CSS under `app/` (except `app/api/`), `components/` and `public/`.
- `components/MarkdownBody.tsx`, `MarkdownCode.tsx`, `MessageView.tsx`,
  `MessageView-*.tsx`, `MessageView-tool-format.ts`, `MessageCopyActions.tsx`
  and `ChatInput-banners.tsx`, plus `ComposerPanels.tsx` and `TodoList.tsx`.
- `lib/markdown.ts` and `lib/syntax-highlight.ts`.
- New or existing `components/display/**/*.{ts,tsx,js,jsx,css}` and
  `lib/display/**/*.{ts,tsx,js,jsx}`.

This covers new **display syntax**: put its parser/formatter in `lib/display/`,
its presentation in `components/display/`, and import it statically from an
allowed renderer. Keep the existing Markdown sanitization and link policies.
Changing OMP's commands, events, protocol or execution semantics is **not** a
display change.

API, RPC, host/session execution, transport/workers, outbox, hooks, shell,
composer input/control, package/config and all other modules remain frozen at startup.
**Settings → System → GUI live customization** lists applied revisions,
source-copy errors and deferred files; it only polls while that settings panel
is open and visible. Deferred changes require explicitly stopping and restarting
only this preview; nothing automatically restarts. Bun reports display compile
errors in its normal browser overlay; fix the source to recover.
Replacing a top-level runtime source directory, or losing its watcher, stops only
the preview with an explanation; explicitly restart the preview to reattach it.

Replacement normally uses one atomic rename. When Windows/Bun holds a mapped
module, the launcher moves the old complete file aside before publishing the
new one, restoring it if publication fails. That Windows fallback has a brief
missing-path window; it never truncates a served module or restarts the backend.

UI mode serializes asynchronous CSS replacements per stylesheet, respecting
[Firefox's CSSOM modification lock](https://bugzilla.mozilla.org/show_bug.cgi?id=1932508#c3)
during rapid hot updates. Genuine stylesheet errors remain visible, and production
mode does not patch browser stylesheet APIs.

Bun's browser HMR runs **without `--hot` or `--watch`** on the server. Existing
draft storage owns unsent text and attachments; an HMR-scoped guard preserves
composer focus, selection and scroll across eligible React remounts without
sending or cancelling anything. Arbitrary React edits can still force a full
page reload, which loses memory-only images, text-file attachments and unfinished
uploads. Finish or remove those attachments before a deliberate full reload.

Stop with Ctrl+C: cleanup removes only this secondary link, web subtree and
temporary snapshot. The production link, daemon, native tasks, checkout and
dependencies remain. A forced kill can leave a disposable snapshot or secondary
link; do not remove a primary link to clean it up.

This is a trusted-developer workflow, not a code sandbox. Source symlinks,
traversal, test artifacts, private state files and `.env` files are not copied.
It requires the full checkout, not an npm package or single-binary archive.
Production builds keep this mode off. Never rebuild `dist/` inside a running
installation to publish GUI edits; review and deploy the finished changes
separately.

### Automating the Windows GUI service

Run these commands from a full checkout with Node.js 24+, installed dependencies,
and the .NET 8 SDK when rebuilding the native tray:

```bash
npm run ui:build -- --verify     # Native/client build, typecheck, lint, tests and smoke
npm run ui:stage                # Build and create a verified, content-addressed package
npm run ui:deploy -- --dry-run  # Inspect promotion without changing the running app
npm run ui:deploy              # Promote this checkout as the normal GUI service
npm run ui:status              # Health, active channel, source and installed package
npm run ui:launch              # Launch saved configuration; already-running is a no-op
npm run ui:rollback -- --dry-run
npm run ui:rollback            # Restore the previous web-only deployment
```

The normal service must already have its independent host daemon and valid
primary link. Deployment reuses that exact link/token without modifying it,
saves `mode: "ui"` and this checkout's `uiSource` in `web-service.json`, and
replaces only the matching web supervisor. The daemon, native OMP processes and
host autostart task are not stopped or reinstalled. The first cutover still
requires browsers to refresh once; eligible later GUI edits use HMR.

For an **existing** trusted Tailscale Serve HTTPS endpoint:

```bash
npm run ui:deploy -- --public-url https://ompweb.example.ts.net:8445 --proxy-port 30179 --dry-run
npm run ui:deploy -- --public-url https://ompweb.example.ts.net:8445 --proxy-port 30179
```

Only that endpoint's existing loopback root proxy is changed; unrelated routes
are preserved and Funnel is refused. The ingress survives Main/fork switches.
Main remains the normal upstream build, while the fork uses GUI HMR. Saved mode,
source, bind and ingress settings survive ordinary tray, in-app and logon
restarts. Only a complete checkout can be `uiSource`; keep it and its installed
dependencies available while the service uses them.
The saved `autoRestart` policy still handles web-process failures; eligible GUI
edits themselves never restart that process. A failure-triggered service restart,
like an explicit restart, takes a new snapshot of the checkout.

`ui:deploy` builds before touching live state, stages a hashed runtime outside the
checkout, retargets the existing global package **junction**, and updates only
matching web shortcuts/task registrations. It refuses an ordinary directory
instead of deleting it. Private per-profile receipts retain the previous
configuration, registrations and route for guarded automatic/manual rollback.
Rollback refuses to overwrite subsequent unrelated changes.

Use `--config <absolute-file>` for a different profile. A custom-config deploy
also requires `--service-root <owned-package-junction>` so a fixture cannot
silently replace the normal global installation. `ui:launch`/`ui:status` accept
the same explicit junction. Rollback gets its junction from its receipt;
`--deployment <receipt-id>` selects an older receipt.

Native builds are reused only when their inputs and executable hashes match.
Build/stage receipts and intermediate files live under ignored
`build/ui-release/`; release checks run in an isolated temporary profile.
Staged runtime files are immutable, but `node_modules` deliberately shares this
checkout's dependency directory. Do not change dependencies in a running
installation. Forced Windows process termination can leave a disposable GUI
snapshot; never remove an active snapshot or a primary host link to clean it up.

Publishing is a separate, explicit operation:

```bash
npm run ui:publish -- --dry-run
# Review and commit source plus the rebuilt tracked tray executable first.
npm run ui:publish -- --reviewed-head <full-commit-sha>
```

Publication always runs the complete checks, requires an unchanged clean commit,
and pushes only that commit to `main` in the GitHub fork declared by
`package.json`. An upstream `origin` is never used as the destination. An
explicit `--remote` must match the declared fork. It does not commit, force-push,
create tags, publish to npm, or deploy. All `--dry-run` commands leave files,
services, routes and publication untouched.


### Checks

```bash
npm run typecheck   # Type check (TypeScript)
npm run lint        # ESLint
npm test            # File-isolated Bun tests, one worker and one concurrent case
```

## License & Credits

- Forked from [agegr/pi-web](https://github.com/agegr/pi-web) (MIT) and adapted for [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).
- Released under the [MIT License](./LICENSE).
