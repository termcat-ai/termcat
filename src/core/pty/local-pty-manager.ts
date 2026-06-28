/**
 * Local PTY service
 *
 * Manages local terminal processes in Main process, parallel and independent with ssh-service.ts.
 */

import * as pty from 'node-pty';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { logger, LOG_MODULE } from '../../base/logger/logger';

const log = logger.withFields({ module: LOG_MODULE.TERMINAL });

export interface ShellInfo {
  name: string;
  path: string;
  args?: string[];
}

interface PtyInstance {
  id: string;
  process: pty.IPty;
  shell: string;
  cwd: string;
  webContents: Electron.WebContents;
  createdAt: number;
}

export class LocalPtyService {
  private instances = new Map<string, PtyInstance>();

  // Current working directory parsed from each PTY's shell prompt.
  // This is the only reliable cwd source on Windows (no /proc, no lsof).
  private trackedCwd = new Map<string, string>();
  private cwdBuffer = new Map<string, string>();

  // Warm PTY pool: pre-spawned shell ready for instant use
  private warmPool: Array<{ process: pty.IPty; shell: string; cwd: string; createdAt: number; bufferedData: string[] }> = [];
  private warmPoolSize = 1;

  /**
   * Pre-spawn a shell process so it's ready when user opens a terminal.
   * Call this after app startup (e.g., after window is ready).
   */
  prewarm(): void {
    if (this.warmPool.length >= this.warmPoolSize) return;
    const defaultShell = this.getDefaultShell();
    const shell = defaultShell.path;
    const args = defaultShell.args || [];
    const cwd = os.homedir();

    log.info('pty.prewarm.start', 'Pre-warming PTY pool', { shell, cwd });

    try {
      const cleanEnv = this.buildCleanEnv();
      const p = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env: cleanEnv,
      });
      const bufferedData: string[] = [];
      p.onData((data) => { bufferedData.push(data); });
      this.warmPool.push({ process: p, shell, cwd, createdAt: Date.now(), bufferedData });
      log.info('pty.prewarm.done', 'PTY pre-warmed successfully');
    } catch (err) {
      log.warn('pty.prewarm.failed', 'Failed to pre-warm PTY', { error: String(err) });
    }
  }

  async detectShells(): Promise<ShellInfo[]> {
    if (process.platform === 'win32') {
      return this.detectWindowsShells();
    }
    return this.detectUnixShells();
  }

  getDefaultShell(): ShellInfo {
    if (process.platform === 'win32') {
      const pwsh = this.findExecutable('pwsh.exe');
      if (pwsh) return { name: 'PowerShell 7', path: pwsh };
      return { name: 'PowerShell', path: 'powershell.exe' };
    }
    const shell = process.env.SHELL || '/bin/sh';
    // macOS/Linux: launch as login shell to ensure full PATH is loaded (consistent with Terminal.app behavior)
    return { name: path.basename(shell), path: shell, args: ['-l'] };
  }

  /**
   * Build a "change directory then clear screen" command for a reused
   * pre-warmed PTY. Syntax differs per shell:
   *   - PowerShell (5.1 / 7): ';' separator (5.1 lacks '&&'), single-quoted
   *     LiteralPath, no backslash escaping.
   *   - cmd.exe: 'cd /d' to also switch drive, '&&', 'cls' to clear.
   *   - POSIX (bash / sh / zsh / git-bash): original '&&' + 'clear' form.
   */
  private buildCdClearCommand(shell: string, cwd: string): string {
    const lower = shell.toLowerCase();
    const base = path.basename(lower);

    if (base.includes('powershell') || base.includes('pwsh')) {
      const escaped = cwd.replace(/'/g, "''");
      return `Set-Location -LiteralPath '${escaped}'; Clear-Host\r`;
    }

    if (base === 'cmd' || base === 'cmd.exe') {
      const escaped = cwd.replace(/"/g, '');
      return `cd /d "${escaped}" && cls\r`;
    }

    // POSIX shells — preserve previous behavior.
    return `cd ${cwd.replace(/(["$`\\!])/g, '\\$1')} && clear\n`;
  }

  create(options: {
    shell?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    cols: number;
    rows: number;
    webContents: Electron.WebContents;
  }): string {
    const ptyId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const defaultShell = this.getDefaultShell();
    const shell = options.shell || defaultShell.path;
    const args = options.args || defaultShell.args || [];
    const cwd = options.cwd || os.homedir();

    log.info('pty.creating', 'Creating local PTY', { pty_id: ptyId, shell, cwd });

    const cleanEnv = this.buildCleanEnv(options.env);

    // Try to claim a pre-warmed PTY (shell must match, cwd can differ — we'll cd)
    let ptyProcess: pty.IPty;
    let bufferedData: string[] = [];
    const warmIdx = this.warmPool.findIndex(w => w.shell === shell);
    if (warmIdx >= 0) {
      const warm = this.warmPool.splice(warmIdx, 1)[0];
      ptyProcess = warm.process;
      bufferedData = warm.bufferedData;
      ptyProcess.resize(options.cols, options.rows);
      // cd to target directory and clear screen if cwd differs.
      // The command syntax is shell-specific (PowerShell / cmd / POSIX).
      if (warm.cwd !== cwd) {
        ptyProcess.write(this.buildCdClearCommand(shell, cwd));
      }
      log.info('pty.warm_claimed', 'Using pre-warmed PTY', {
        pty_id: ptyId, warm_age_ms: Date.now() - warm.createdAt,
        cwd_changed: warm.cwd !== cwd,
      });
      // Replenish the pool in background
      setTimeout(() => this.prewarm(), 500);
    } else {
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd,
        env: cleanEnv,
      });
    }

    ptyProcess.onData((data) => {
      this.trackCwdFromPrompt(ptyId, data);
      if (!options.webContents.isDestroyed()) {
        options.webContents.send('local-pty-data', ptyId, data);
      }
    });

    // Flush pre-warmed buffered data to renderer
    if (bufferedData.length > 0) {
      for (const chunk of bufferedData) {
        if (!options.webContents.isDestroyed()) {
          options.webContents.send('local-pty-data', ptyId, chunk);
        }
      }
    }

    ptyProcess.onExit(({ exitCode, signal }) => {
      log.info('pty.exited', 'Local PTY exited', { pty_id: ptyId, exit_code: exitCode, signal });
      if (!options.webContents.isDestroyed()) {
        options.webContents.send('local-pty-close', ptyId, exitCode);
      }
      this.instances.delete(ptyId);
    });

    this.instances.set(ptyId, {
      id: ptyId,
      process: ptyProcess,
      shell,
      cwd,
      webContents: options.webContents,
      createdAt: Date.now(),
    });

    log.info('pty.created', 'Local PTY created', { pty_id: ptyId });
    return ptyId;
  }

  write(ptyId: string, data: string): boolean {
    const instance = this.instances.get(ptyId);
    if (!instance) {
      log.warn('pty.write.no_instance', 'PTY instance not found for write', { pty_id: ptyId });
      return false;
    }
    try {
      instance.process.write(data);
    } catch (err) {
      log.error('pty.write.error', 'Failed to write to PTY', { pty_id: ptyId, error: String(err) });
      return false;
    }
    return true;
  }

  resize(ptyId: string, cols: number, rows: number): boolean {
    const instance = this.instances.get(ptyId);
    if (!instance) return false;
    instance.process.resize(cols, rows);
    return true;
  }

  destroy(ptyId: string): void {
    const instance = this.instances.get(ptyId);
    if (!instance) return;
    log.info('pty.destroying', 'Destroying local PTY', { pty_id: ptyId });
    instance.process.kill();
    this.instances.delete(ptyId);
    this.trackedCwd.delete(ptyId);
    this.cwdBuffer.delete(ptyId);
  }

  destroyAll(): void {
    log.info('pty.destroying_all', 'Destroying all local PTY instances', { count: this.instances.size });
    for (const [id] of this.instances) {
      this.destroy(id);
    }
  }

  exists(ptyId: string): boolean {
    return this.instances.has(ptyId);
  }

  getPid(ptyId: string): number | null {
    const instance = this.instances.get(ptyId);
    return instance?.process.pid ?? null;
  }

  /**
   * Health check: verify the shell process is still alive. macOS sleep does
   * not invalidate node-pty file descriptors held in this process, so as long
   * as the shell pid responds to signal 0 the PTY is functional.
   *
   * Previously this used a DSR probe (`\x1b[5n` → expect `\x1b[0n`), but TUI
   * apps in alternate-screen mode (claude code, vim, htop, less, …) consume
   * the DSR without replying, which produced a false-negative that triggered
   * the destructive rebuild path and killed the user's session on every wake.
   */
  async healthCheck(ptyId: string): Promise<boolean> {
    const instance = this.instances.get(ptyId);
    if (!instance) return false;
    const pid = instance.process.pid;
    if (!pid) return false;
    try {
      // Signal 0: existence check, no signal delivered.
      process.kill(pid, 0);
      return true;
    } catch {
      log.warn('pty.health_check.proc_dead', 'Shell process gone', { pty_id: ptyId, pid });
      return false;
    }
  }

  /**
   * Rebuild a PTY: destroy old instance and create a new one with same cwd.
   * Used to recover from stale fd after system sleep.
   */
  async rebuild(ptyId: string, webContents: Electron.WebContents, cols: number, rows: number): Promise<{ newPtyId: string } | null> {
    const instance = this.instances.get(ptyId);
    if (!instance) return null;

    const cwd = await this.getCwd(ptyId) || instance.cwd;
    const shellPath = instance.shell;

    log.info('pty.rebuilding', 'Rebuilding PTY after health check failure', {
      old_pty_id: ptyId,
      shell: shellPath,
      cwd,
    });

    // Destroy old instance
    this.destroy(ptyId);

    // Create new instance with same parameters
    const newPtyId = this.create({
      shell: shellPath,
      cwd,
      cols,
      rows,
      webContents,
    });

    log.info('pty.rebuilt', 'PTY rebuilt successfully', {
      old_pty_id: ptyId,
      new_pty_id: newPtyId,
    });

    return { newPtyId };
  }

  /**
   * Parse the working directory from a shell prompt in the PTY data stream.
   * Supports Windows PowerShell ("PS C:\path>"), cmd ("C:\path>"),
   * Git-Bash ("...MINGW64 /c/path" or "~") and POSIX prompts.
   * The result is stored per-pty and surfaced via getCwd().
   */
  private trackCwdFromPrompt(ptyId: string, data: string): void {
    let buf = (this.cwdBuffer.get(ptyId) || '') + data;
    if (buf.length > 1500) buf = buf.slice(-1500);
    this.cwdBuffer.set(ptyId, buf);

    const clean = buf
      .replace(/\x1b\][0-9]*;[^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
      .replace(/\r/g, '');
    const lines = clean.split('\n');
    const last = lines[lines.length - 1] || '';
    const prev = lines.length > 1 ? lines[lines.length - 2] : '';

    let detected: string | null = null;

    // PowerShell: "PS C:\path>"
    let m = last.match(/PS\s+([A-Za-z]:\\[^\n>]*?)\s*>\s*$/) ||
            prev.match(/PS\s+([A-Za-z]:\\[^\n>]*?)\s*>\s*$/);
    if (m) detected = m[1];

    // cmd.exe: "C:\path>"
    if (!detected) {
      m = last.match(/(?:^|\n)\s*([A-Za-z]:\\[^\n>]*?)\s*>\s*$/) ||
          prev.match(/(?:^|\n)\s*([A-Za-z]:\\[^\n>]*?)\s*>\s*$/);
      if (m) detected = m[1];
    }

    // Git-Bash / MSYS: "...MINGW64 /c/path" or "...MINGW64 ~"
    if (!detected) {
      m = last.match(/(?:MINGW|MSYS|UCRT|CLANG)\d*\s+(~|\/[^\s]*?)\s*$/) ||
          prev.match(/(?:MINGW|MSYS|UCRT|CLANG)\d*\s+(~|\/[^\s]*?)\s*$/);
      if (m) {
        const raw = m[1];
        if (raw === '~') detected = os.homedir();
        else {
          const dm = raw.match(/^\/([A-Za-z])(\/.*)?$/);
          detected = dm ? `${dm[1].toUpperCase()}:${(dm[2] || '\\').replace(/\//g, '\\')}` : raw;
        }
      }
    }

    // POSIX: "user@host:/path$" / "/path$" / "~$"
    if (!detected && process.platform !== 'win32') {
      m = last.match(/[\w.-]+@[\w.-]+:([~/][^\s$#]*)[$#]\s*$/) ||
          prev.match(/[\w.-]+@[\w.-]+:([~/][^\s$#]*)[$#]\s*$/);
      if (m) {
        let p = m[1];
        if (p === '~' || p.startsWith('~/')) p = os.homedir() + p.slice(1);
        detected = p;
      }
    }

    if (detected) {
      this.trackedCwd.set(ptyId, detected);
      const inst = this.instances.get(ptyId);
      if (inst) inst.cwd = detected;
    }
  }

  /**
   * Get PTY subprocess current working directory
   */
  async getCwd(ptyId: string): Promise<string | null> {
    const instance = this.instances.get(ptyId);
    if (!instance) return null;
    const tracked = this.trackedCwd.get(ptyId) || null;
    const pid = instance.process.pid;
    try {
      if (process.platform === 'darwin') {
        // macOS: get cwd via lsof
        const { execSync } = require('child_process');
        const output = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 });
        const match = output.match(/\nn(.+)/);
        return match ? match[1] : tracked;
      } else if (process.platform === 'linux') {
        // Linux: read /proc/{pid}/cwd symlink
        return await fs.promises.readlink(`/proc/${pid}/cwd`);
      } else {
        // Windows: no /proc or lsof — use the prompt-parsed cwd.
        return tracked;
      }
    } catch {
      return tracked;
    }
  }

  private buildCleanEnv(extra?: Record<string, string>): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      // Skip Electron/Chromium internal vars that are useless in child shell
      if (k.startsWith('ELECTRON_') || k.startsWith('CHROME_') ||
          k === 'ORIGINAL_XDG_CURRENT_DESKTOP' || k === 'GDK_BACKEND' ||
          k === 'NODE_ENV' || k === 'VITE_DEV_SERVER_URL') continue;
      cleanEnv[k] = v;
    }
    cleanEnv.LANG = cleanEnv.LANG || 'en_US.UTF-8';
    cleanEnv.LC_CTYPE = cleanEnv.LC_CTYPE || 'UTF-8';
    cleanEnv.TERM = 'xterm-256color';
    // Present as iTerm2 so CLIs (claude code / codex) auto-detect a terminal that
    // supports OSC 9 desktop notifications and emit them. TermCat's onData parser
    // turns those OSC 9 sequences into native notifications. xterm.js ignores the
    // iTerm2-proprietary sequences this identity may also invite (OSC 1337 etc.).
    cleanEnv.TERM_PROGRAM = 'iTerm.app';
    cleanEnv.TERM_PROGRAM_VERSION = '3.5.0';
    cleanEnv.LC_TERMINAL = 'iTerm2';
    cleanEnv.LC_TERMINAL_VERSION = '3.5.0';
    if (extra) Object.assign(cleanEnv, extra);
    return cleanEnv;
  }

  private async detectUnixShells(): Promise<ShellInfo[]> {
    const shells: ShellInfo[] = [];
    try {
      const content = await fs.promises.readFile('/etc/shells', 'utf-8');
      const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      for (const shellPath of lines) {
        try {
          await fs.promises.access(shellPath, fs.constants.X_OK);
          shells.push({ name: path.basename(shellPath), path: shellPath });
        } catch { /* skip */ }
      }
    } catch {
      const fallback = process.env.SHELL || '/bin/sh';
      shells.push({ name: path.basename(fallback), path: fallback });
    }
    return shells;
  }

  private async detectWindowsShells(): Promise<ShellInfo[]> {
    const shells: ShellInfo[] = [];
    const candidates: Array<{ name: string; paths: string[]; args?: string[] }> = [
      { name: 'PowerShell 7', paths: ['pwsh.exe'] },
      { name: 'PowerShell', paths: ['powershell.exe'] },
      { name: 'CMD', paths: ['cmd.exe'] },
      { name: 'WSL', paths: ['wsl.exe'] },
      {
        name: 'Git Bash',
        paths: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'],
        args: ['--login', '-i'],
      },
    ];
    for (const candidate of candidates) {
      const found = this.findExecutableFromPaths(candidate.paths);
      if (found) {
        shells.push({ name: candidate.name, path: found, args: candidate.args });
      }
    }
    return shells;
  }

  private findExecutable(name: string): string | null {
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
      const fullPath = path.join(dir, name);
      try {
        fs.accessSync(fullPath, fs.constants.X_OK);
        return fullPath;
      } catch { continue; }
    }
    return null;
  }

  private findExecutableFromPaths(paths: string[]): string | null {
    for (const p of paths) {
      if (path.isAbsolute(p)) {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        } catch { continue; }
      }
      const found = this.findExecutable(p);
      if (found) return found;
    }
    return null;
  }
}

export const localPtyService = new LocalPtyService();
