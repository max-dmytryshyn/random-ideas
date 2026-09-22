import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const HOME = GLib.get_home_dir();
const SESSIONS_DIR = HOME + '/.claude/sessions';
const CREDENTIALS = HOME + '/.claude/.credentials.json';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const SESSION_POLL = 2;
const MEMORY_POLL = 3;
const LIMITS_POLL = 300;
const LIMITS_MIN_INTERVAL = 60;

const MENU_METER_WIDTH = 240;

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

function formatBytes(kib) {
    const gib = kib / 1048576;
    if (gib >= 1)
        return gib.toFixed(1) + ' GiB';
    return Math.round(kib / 1024) + ' MiB';
}

function resetText(iso) {
    if (!iso)
        return '';
    const at = Date.parse(iso);
    if (isNaN(at))
        return '';
    const seconds = Math.round((at - Date.now()) / 1000);
    if (seconds <= 0)
        return 'resetting';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours >= 24)
        return 'resets in ' + Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
    if (hours > 0)
        return 'resets in ' + hours + 'h ' + minutes + 'm';
    return 'resets in ' + minutes + 'm';
}

function clamp(fraction) {
    if (isNaN(fraction))
        return 0;
    return Math.max(0, Math.min(1, fraction));
}

function levelColor(fraction) {
    if (fraction < 0.6)
        return [0.30, 0.68, 0.38];
    if (fraction < 0.85)
        return [0.92, 0.62, 0.14];
    return [0.87, 0.27, 0.27];
}

function trackColor(area) {
    const fg = area.get_theme_node().get_foreground_color();
    return [fg.red / 255, fg.green / 255, fg.blue / 255];
}

function paintBar(area, fraction) {
    const [width, height] = area.get_surface_size();
    const cr = area.get_context();
    const track = trackColor(area);

    cr.setSourceRGBA(track[0], track[1], track[2], 0.18);
    cr.rectangle(0, 0, width, height);
    cr.fill();

    const value = clamp(fraction);
    if (value > 0) {
        const color = levelColor(value);
        cr.setSourceRGBA(color[0], color[1], color[2], 1.0);
        cr.rectangle(0, 0, Math.max(1, width * value), height);
        cr.fill();
    }

    cr.$dispose();
}

function paintVerticalBar(area, fraction) {
    const [width, height] = area.get_surface_size();
    const cr = area.get_context();
    const track = trackColor(area);

    cr.setSourceRGBA(track[0], track[1], track[2], 0.18);
    cr.rectangle(0, 0, width, height);
    cr.fill();

    const value = clamp(fraction);
    if (value > 0) {
        const color = levelColor(value);
        const filled = Math.max(1, height * value);
        cr.setSourceRGBA(color[0], color[1], color[2], 1.0);
        cr.rectangle(0, height - filled, width, filled);
        cr.fill();
    }

    cr.$dispose();
}

const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(name, iconName, interval) {
        super._init(0.5, name);

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (iconName) {
            this._box.add_child(new St.Icon({
                icon_name: iconName,
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._label);
        this.add_child(this._box);

        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this.connect('destroy', () => this._onDestroy());
    }

    _addMeter(width, height, paint) {
        const area = new St.DrawingArea({
            width: width,
            height: height,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-right: 4px;',
        });
        area.connect('repaint', () => paint(area));
        this._box.insert_child_below(area, this._label);
        return area;
    }

    _textRow(text, dim) {
        const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
        if (dim)
            item.label.set_style('font-size: 0.85em; opacity: 0.7;');
        this.menu.addMenuItem(item);
    }

    _meterRow(label, value, fraction) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const column = new St.BoxLayout({ vertical: true, x_expand: true });

        const header = new St.BoxLayout({ x_expand: true });
        header.add_child(new St.Label({ text: label, x_expand: true }));
        header.add_child(new St.Label({ text: value, style: 'opacity: 0.7;' }));
        column.add_child(header);

        const meter = new St.DrawingArea({
            width: MENU_METER_WIDTH,
            height: 6,
            style: 'margin-top: 4px;',
        });
        meter.connect('repaint', () => paintBar(meter, fraction));
        column.add_child(meter);

        item.add_child(column);
        this.menu.addMenuItem(item);
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = null;
        }
    }
});

const SessionsIndicator = GObject.registerClass(
class SessionsIndicator extends ClaudeIndicator {
    _init() {
        super._init('Claude Sessions', null, SESSION_POLL);
        this.refresh();
    }

    _read() {
        const sessions = [];
        let children;
        try {
            children = Gio.File.new_for_path(SESSIONS_DIR).enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return sessions;
        }

        let info;
        while ((info = children.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.endsWith('.json'))
                continue;
            const text = readText(SESSIONS_DIR + '/' + name);
            if (text === null)
                continue;

            let session;
            try {
                session = JSON.parse(text);
            } catch (e) {
                continue;
            }
            if (typeof session.pid !== 'number' || session.spare === true)
                continue;

            const cmdline = readText('/proc/' + session.pid + '/cmdline');
            if (cmdline === null || !cmdline.includes('claude'))
                continue;

            sessions.push(session);
        }
        children.close(null);
        return sessions;
    }

    _state(session) {
        if (session.status === 'busy')
            return { bucket: 'busy', text: 'working' };
        if (session.status === 'waiting')
            return { bucket: 'waiting', text: session.waitingFor || 'waiting for you' };
        if (session.status === 'idle')
            return { bucket: 'idle', text: 'idle' };
        return { bucket: 'idle', text: session.status || 'running' };
    }

    refresh() {
        const sessions = this._read();
        const counts = { busy: 0, waiting: 0, idle: 0 };

        sessions.sort((a, b) => (b.statusUpdatedAt || b.startedAt || 0) - (a.statusUpdatedAt || a.startedAt || 0));

        this.menu.removeAll();
        for (const session of sessions) {
            const state = this._state(session);
            counts[state.bucket] += 1;

            const name = session.name || GLib.path_get_basename(session.cwd || 'session');
            const mark = state.bucket === 'busy' ? '▶' : state.bucket === 'waiting' ? '❗' : '⏸';
            const origin = session.kind === 'bg' ? 'background · ' : '';
            this._textRow(mark + '  ' + name + ' — ' + state.text);
            this._textRow('      ' + origin + (session.cwd || ''), true);
        }
        if (sessions.length === 0)
            this._textRow('No Claude sessions running');

        const parts = [];
        if (counts.busy)
            parts.push('▶' + counts.busy);
        if (counts.waiting)
            parts.push('❗' + counts.waiting);
        if (counts.idle)
            parts.push('⏸' + counts.idle);
        this._label.set_text(parts.length ? parts.join(' ') : '0');
    }
});

const MemoryIndicator = GObject.registerClass(
class MemoryIndicator extends ClaudeIndicator {
    _init() {
        super._init('RAM Usage', 'utilities-system-monitor-symbolic', MEMORY_POLL);
        this._bar = this._addMeter(8, 16, area => paintVerticalBar(area, this._fraction || 0));
        this.refresh();
    }

    refresh() {
        const text = readText('/proc/meminfo');
        if (text === null) {
            this._label.set_text('?');
            this.menu.removeAll();
            this._textRow('/proc/meminfo unreadable');
            return;
        }

        const values = {};
        for (const line of text.split('\n')) {
            const match = /^(\w+):\s+(\d+) kB$/.exec(line);
            if (match)
                values[match[1]] = parseInt(match[2], 10);
        }

        const total = values.MemTotal || 0;
        const available = values.MemAvailable || 0;
        if (total === 0) {
            this._label.set_text('?');
            this.menu.removeAll();
            this._textRow('MemTotal missing from /proc/meminfo');
            return;
        }

        const used = total - available;
        const fraction = used / total;

        this._fraction = fraction;
        this._label.set_text(Math.round(fraction * 100) + '%');
        if (this._bar)
            this._bar.queue_repaint();

        this.menu.removeAll();
        this._meterRow('Memory', formatBytes(used) + ' of ' + formatBytes(total), fraction);
        this._textRow('Available ' + formatBytes(available), true);
        this._textRow('Cached ' + formatBytes((values.Cached || 0) + (values.Buffers || 0)), true);

        if (values.SwapTotal) {
            const swapUsed = values.SwapTotal - (values.SwapFree || 0);
            this._meterRow('Swap', formatBytes(swapUsed) + ' of ' + formatBytes(values.SwapTotal),
                swapUsed / values.SwapTotal);
        }
    }
});

const LimitsIndicator = GObject.registerClass(
class LimitsIndicator extends ClaudeIndicator {
    _init() {
        super._init('Claude Code Limits', 'alarm-symbolic', LIMITS_POLL);
        this._bars = this._addMeter(30, 14, area => this._paintBars(area));
        this._label.hide();
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this.refresh();
        });
        this.refresh();
    }

    _paintBars(area) {
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        const track = trackColor(area);
        const values = this._headline || [0, 0];
        const barHeight = 5;
        const gap = 4;
        const top = Math.floor((height - (barHeight * 2 + gap)) / 2);

        values.forEach((value, index) => {
            const y = top + index * (barHeight + gap);
            cr.setSourceRGBA(track[0], track[1], track[2], 0.18);
            cr.rectangle(0, y, width, barHeight);
            cr.fill();

            const filled = clamp(value);
            if (filled > 0) {
                const color = levelColor(filled);
                cr.setSourceRGBA(color[0], color[1], color[2], 1.0);
                cr.rectangle(0, y, Math.max(1, width * filled), barHeight);
                cr.fill();
            }
        });

        cr.$dispose();
    }

    _token() {
        const text = readText(CREDENTIALS);
        if (text === null)
            return null;
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            return null;
        }
        const token = data.claudeAiOauth && data.claudeAiOauth.accessToken;
        if (typeof token !== 'string' || /["\\\r\n]/.test(token))
            return null;
        return token;
    }

    _limitLabel(limit) {
        if (limit.kind === 'session')
            return 'Session (5h)';
        if (limit.kind === 'weekly_all')
            return 'Weekly (all models)';
        if (limit.kind === 'weekly_scoped') {
            const model = limit.scope && limit.scope.model && limit.scope.model.display_name;
            return 'Weekly (' + (model || 'scoped') + ')';
        }
        return limit.kind;
    }

    _render(usage, note) {
        const limits = Array.isArray(usage.limits) ? usage.limits : [];

        this._usage = usage;
        this.menu.removeAll();
        for (const limit of limits) {
            this._meterRow(this._limitLabel(limit), limit.percent + '%', limit.percent / 100);
            const reset = resetText(limit.resets_at);
            if (reset)
                this._textRow('      ' + reset, true);
        }

        const extra = usage.extra_usage;
        if (extra && extra.is_enabled) {
            this._meterRow('Extra usage',
                extra.used_credits + ' of ' + extra.monthly_limit + ' ' + extra.currency,
                extra.used_credits / extra.monthly_limit);
        }

        if (limits.length === 0)
            this._textRow('No limit data');
        if (note)
            this._textRow(note, true);

        const session = limits.find(l => l.kind === 'session');
        const weekly = limits.find(l => l.kind === 'weekly_all');
        this._headline = [
            session ? session.percent / 100 : 0,
            weekly ? weekly.percent / 100 : 0,
        ];
        if (this._bars)
            this._bars.queue_repaint();
        this._label.hide();
    }

    _fail(message) {
        if (this._usage) {
            this._render(this._usage, message);
            return;
        }

        this._label.set_text('?');
        this._label.show();
        this._headline = [0, 0];
        if (this._bars)
            this._bars.queue_repaint();
        this.menu.removeAll();
        this._textRow(message);
    }

    refresh() {
        if (this._pending)
            return;

        const now = GLib.get_monotonic_time() / 1000000;
        if (this._lastFetch !== undefined && now - this._lastFetch < LIMITS_MIN_INTERVAL)
            return;
        this._lastFetch = now;

        const token = this._token();
        if (token === null) {
            this._fail('No Claude credentials found');
            return;
        }

        const config = [
            'url = "' + USAGE_URL + '"',
            'header = "Authorization: Bearer ' + token + '"',
            'header = "anthropic-beta: oauth-2025-04-20"',
            'fail',
            '',
        ].join('\n');

        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['curl', '--silent', '--show-error', '--max-time', '20', '--config', '-'],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._fail('curl not available');
            return;
        }

        this._pending = proc;
        this._cancellable = new Gio.Cancellable();

        proc.communicate_utf8_async(config, this._cancellable, (source, result) => {
            this._pending = null;
            if (this._destroyed)
                return;

            let stdout, stderr;
            try {
                [, stdout, stderr] = source.communicate_utf8_finish(result);
            } catch (e) {
                this._fail('Usage request failed');
                return;
            }

            if (!source.get_successful()) {
                const code = (stderr || '').match(/error: (\d{3})/);
                this._fail(code
                    ? 'Usage unavailable (HTTP ' + code[1] + ')'
                    : 'Usage request failed');
                return;
            }

            let usage;
            try {
                usage = JSON.parse(stdout);
            } catch (e) {
                this._fail('Unexpected usage response');
                return;
            }
            this._render(usage);
        });
    }

    _onDestroy() {
        super._onDestroy();
        if (this._cancellable)
            this._cancellable.cancel();
        this._pending = null;
    }
});

function anchorPosition() {
    const box = Main.panel._rightBox;
    const system = Main.panel.statusArea.quickSettings || Main.panel.statusArea.aggregateMenu;
    if (system) {
        const index = box.get_children().indexOf(system.container);
        if (index >= 0)
            return index;
    }
    return box.get_n_children();
}

export default class ClaudeTaskbarExtension extends Extension {
    enable() {
        this._indicators = [
            ['claude-limits', new LimitsIndicator()],
            ['claude-memory', new MemoryIndicator()],
            ['claude-sessions', new SessionsIndicator()],
        ];
        for (const [role, indicator] of this._indicators)
            Main.panel.addToStatusArea(role, indicator, anchorPosition(), 'right');
    }

    disable() {
        for (const [, indicator] of this._indicators || [])
            indicator.destroy();
        this._indicators = [];
    }
}
