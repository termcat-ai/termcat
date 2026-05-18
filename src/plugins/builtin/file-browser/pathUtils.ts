/**
 * Platform-aware path helpers for the file browser.
 *
 * SSH connections are always POSIX. Local connections follow the host OS:
 * Windows uses drive letters and '\' separators, everything else uses '/'.
 * All helpers are pure and driven by an `isWin` flag so the same component
 * works for both.
 */

export interface PathOps {
  isWin: boolean;
  /** True when `p` is the top of the tree (a drive root on Windows, '/' on POSIX). */
  atTop(p: string): boolean;
  /** Join a directory and a child name. */
  join(dir: string, name: string): string;
  /** Parent directory. Returns the same path when already at the top. */
  parent(p: string): string;
  /** Level-by-level ancestor paths of `target`, e.g. C:\a\b → [C:\, C:\a, C:\a\b]. */
  ancestors(target: string): string[];
  /** True when `ancestor` is `path` itself or one of its ancestors. */
  isAncestorOrSelf(ancestor: string, path: string): boolean;
}

const isDriveRoot = (p: string): boolean => /^[A-Za-z]:[\\/]?$/.test(p);

const normalizeDrive = (p: string): string =>
  /^[A-Za-z]:$/.test(p) ? p + '\\' : p;

export function createPathOps(isWin: boolean): PathOps {
  if (!isWin) {
    return {
      isWin: false,
      atTop: (p) => p === '/' || p === '',
      join: (dir, name) => (dir === '/' || dir === '' ? `/${name}` : `${dir}/${name}`),
      parent: (p) => {
        if (p === '/' || p === '') return '/';
        const i = p.lastIndexOf('/');
        return i <= 0 ? '/' : p.slice(0, i);
      },
      ancestors: (target) => {
        if (target === '/' || target === '') return [];
        const parts = target.split('/').filter(Boolean);
        return parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/'));
      },
      isAncestorOrSelf: (a, p) => p === a || p.startsWith(a === '/' ? '/' : a + '/'),
    };
  }

  return {
    isWin: true,
    atTop: (p) => isDriveRoot(p),
    join: (dir, name) => {
      const base = normalizeDrive(dir.replace(/[\\/]+$/, ''));
      return base.endsWith('\\') ? base + name : base + '\\' + name;
    },
    parent: (p) => {
      if (isDriveRoot(p)) return normalizeDrive(p);
      const s = p.replace(/[\\/]+$/, '');
      const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
      if (i < 0) return s;
      const head = s.slice(0, i);
      return normalizeDrive(head) || s;
    },
    ancestors: (target) => {
      const m = target.match(/^([A-Za-z]:)[\\/]?(.*)$/);
      if (!m) return [];
      const driveRoot = m[1] + '\\';
      const rest = m[2].split(/[\\/]+/).filter(Boolean);
      const out = [driveRoot];
      let acc = driveRoot;
      for (const seg of rest) {
        acc = acc.endsWith('\\') ? acc + seg : acc + '\\' + seg;
        out.push(acc);
      }
      return out;
    },
    isAncestorOrSelf: (a, p) => {
      if (p === a) return true;
      const an = a.replace(/[\\/]+$/, '');
      return p.startsWith(an + '\\') || p.startsWith(an + '/');
    },
  };
}
