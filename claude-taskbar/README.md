# Claude Taskbar

Three GNOME top bar indicators, sitting together just left of the system menu.

| Indicator | Shows | Source |
|---|---|---|
| Usage | Two progress lines — 5h window on top, 7d below. Click for exact percentages and reset times. | `api.anthropic.com/api/oauth/usage` |
| RAM | Vertical bar + percentage. Click for used/total, available, cached, swap. | `/proc/meminfo` |
| Sessions | `▶2 ❗1 ⏸1` — working / needs you / idle. Interactive and `--bg` sessions alike. Click for each session's name, state and folder. | `~/.claude/sessions/*.json` |

## Install

```bash
git clone https://github.com/max-dmytryshyn/random-ideas.git
cd random-ideas/claude-taskbar
./install.sh
```

`install.sh` picks the right variant for your GNOME version, copies it into
`~/.local/share/gnome-shell/extensions/`, and prints the two steps it will not do for you:
restart the shell, then enable the extension.

### Restarting the shell — read this

**Never run `gnome-shell --replace`.** On a GDM-managed session it wins the `org.gnome.Shell`
bus name, then gnome-session's own respawn fails with
`org.gnome.Shell already exists on bus and --replace not specified`, hits its retry limit,
and tears down the session. Every open window dies. This is how the extension was written —
it cost a full desktop session and a reboot.

The two supported ways:

- **X11** — `Alt+F2`, type `r`, Enter. Restarts the shell in place; windows survive.
- **Wayland** — log out and log back in. There is no in-place restart.

Then:

```bash
gnome-extensions enable claude-taskbar@maksumus.local
```

If `gnome-extensions enable` says the extension does not exist, the shell has not rescanned yet —
restart it first, then enable.

## GNOME versions

GNOME 45 dropped the legacy `imports.*` extension API for ES modules, so there are two variants:

- `gnome42/` — GNOME 42–44 (legacy API). Verified on Ubuntu 22.04 / GNOME 42.9 / X11.
- `gnome45/` — GNOME 45–48 (ESM). Generated from `gnome42/extension.js` by swapping the import
  header and the `enable`/`disable` footer; the bodies are identical. Built but not run on hardware.

Fix bugs in `gnome42/extension.js` and regenerate, or apply the same edit to both.

## What it reads

The usage indicator reads your Claude OAuth access token from `~/.claude/.credentials.json`
and sends it to `api.anthropic.com/api/oauth/usage` — the same endpoint `/usage` uses inside
Claude Code. The token is passed to `curl` through a config file on stdin, so it never appears
in the process list. Nothing is written, logged, cached to disk, or sent anywhere else.

The other two read `/proc/meminfo` and `~/.claude/sessions/*.json`, both local and read-only.
A session file is ignored unless `/proc/<pid>/cmdline` still names a Claude process, so dead
sessions do not linger as ghosts. Checking `cmdline` rather than `comm` matters: a `claude --bg`
session execs the version-named binary, so its `comm` reads e.g. `2.1.278`, and matching on
`comm` silently hides every background session.

The result matches `claude agents --json` exactly, without spawning the CLI on every poll.
Two things are deliberately absent, as they are from that listing too: pre-warmed **spares**
(`"spare": true`, hex names, permanently idle — not real work), and **in-process subagents**,
which run inside their parent's process and have no PID or session file of their own. A busy
subagent shows up as its parent session being busy.

Polling: sessions 2s, RAM 3s, usage 5 min (plus at most once a minute when you open its menu —
the usage endpoint returns HTTP 429 if you ask more often than that).

## Uninstall

```bash
gnome-extensions disable claude-taskbar@maksumus.local
rm -rf ~/.local/share/gnome-shell/extensions/claude-taskbar@maksumus.local
```

Disable takes effect immediately, no restart needed.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing appears after restarting | `gsettings get org.gnome.shell disable-user-extensions` is `true`. GNOME sets this itself after a shell crash and it silently disables every extension. Set it to `false`. |
| Usage shows `?` | Open its menu — it names the HTTP code. `429` means rate-limited; it clears on its own. |
| Widgets are split apart by other tray icons | Other extensions insert at a fixed low index. This one anchors itself next to the system menu to avoid that; if it still happens, restart the shell so it re-anchors. |
