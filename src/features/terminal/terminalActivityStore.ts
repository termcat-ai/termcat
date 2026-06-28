/**
 * Terminal Activity & Bell Store
 *
 * Tracks per-backend ephemeral terminal status used to drive tab indicators:
 *  - activity:  output is currently flowing (a CLI such as `claude code` /
 *               `codex` is actively working and redrawing).
 *  - attention: the program rang the terminal bell (BEL) and needs the user.
 *
 * Keyed by `backend.id` (SSH connectionId / local ptyId) — the only stable
 * identifier available where terminal output is observed. App.tsx bridges this
 * id to Session/tab via `Session.connectionId`.
 *
 * Performance: `noteOutput` runs on the hot output path. It only broadcasts on
 * activity edges (idle -> active, active -> idle), never per chunk, so React
 * subscribers re-render at most a few times per second (see CLAUDE.md perf rules).
 */

import { EventEmitter } from '@/core/ai-agent/EventEmitter';

export interface TabActivityStatus {
  /** Output is flowing right now (blue pulse). */
  activity: boolean;
  /** Terminal bell received, waiting to be seen (orange blink). */
  attention: boolean;
}

/** Output must pause at least this long before "activity" turns off. */
const IDLE_MS = 800;

interface Entry {
  activity: boolean;
  attention: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const EMPTY: TabActivityStatus = { activity: false, attention: false };

class TerminalActivityStore extends EventEmitter {
  private entries = new Map<string, Entry>();
  private version = 0;

  private ensure(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { activity: false, attention: false, idleTimer: null };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** Advance the snapshot version and notify subscribers of a state change. */
  private bump(): void {
    this.version++;
    this.emit('change');
  }

  /**
   * Report an output chunk. Cheap on the hot path: while activity is already
   * on, this only resets the idle timer and does not broadcast.
   */
  noteOutput(id: string): void {
    if (!id) return;
    const entry = this.ensure(id);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.activity) {
        entry.activity = false;
        this.bump();
      }
    }, IDLE_MS);
    if (!entry.activity) {
      entry.activity = true;
      this.bump();
    }
  }

  /**
   * Raise attention on a terminal and notify the app. Only the rising edge
   * (false -> true) broadcasts and emits 'notify', which naturally debounces
   * repeated signals into a single attention episode until acknowledged.
   * `message` carries the app-supplied text (OSC 9); undefined for a bare bell.
   */
  private raiseAttention(id: string, message?: string): void {
    if (!id) return;
    const entry = this.ensure(id);
    if (!entry.attention) {
      entry.attention = true;
      this.bump();
      this.emit('notify', id, message);
    }
  }

  /**
   * Report a desktop-notification request parsed from the output stream (OSC 9,
   * e.g. "Claude needs your permission"). Carries the message to the app.
   */
  noteNotification(id: string, message: string): void {
    this.raiseAttention(id, message);
  }

  /** Report a real terminal bell (BEL). Fallback signal with no message. */
  noteBell(id: string): void {
    this.raiseAttention(id);
  }

  /** User has seen this terminal — clear its attention flag. */
  acknowledge(id: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.attention) {
      entry.attention = false;
      this.bump();
    }
  }

  /** Session closed — drop its entry and pending timer. */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.entries.delete(id);
    if (entry.activity || entry.attention) this.bump();
  }

  getState(id: string): TabActivityStatus {
    const entry = this.entries.get(id);
    if (!entry) return EMPTY;
    return { activity: entry.activity, attention: entry.attention };
  }

  /** Monotonic snapshot value for useSyncExternalStore. */
  getVersion = (): number => this.version;

  /** Subscribe to any state change. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.on('change', listener);
    return () => {
      this.off('change', listener);
    };
  };

  /**
   * Subscribe to attention rising edges (OSC 9 notification or bell). The
   * listener receives the backend id and the app-supplied message, if any.
   * Returns an unsubscribe function.
   */
  onNotify(listener: (id: string, message?: string) => void): () => void {
    this.on('notify', listener);
    return () => {
      this.off('notify', listener);
    };
  }
}

export const terminalActivityStore = new TerminalActivityStore();
