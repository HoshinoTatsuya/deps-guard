import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import type { Lockfile } from '../types/lockfile.type';

/**
 * Каталоги проектов workspace по шаблонам самого менеджера: pnpm — `packages`
 * из pnpm-workspace.yaml, npm и yarn — `workspaces` корневого package.json.
 * Проверяется каталог, а не список из lock-файла: проект, которого lock-файл
 * не знает (yarn 1 не хранит проекты вовсе, устаревший lock pnpm/npm), иначе
 * не судит ни одно правило.
 *
 * Поддержаны `*`, `?`, `**` и исключение `!шаблон`; прочий синтаксис glob,
 * `\\` (на Windows — разделитель, на POSIX — экранирование), шаблон вне корня
 * (`../x`, `/x`) — отказ, а не «ничего не совпало». `*` и `**` не заходят в
 * скрытые каталоги, а явный сегмент `.tools/*` — заходит (так у менеджеров);
 * `node_modules` не обходится никогда, у pnpm — ещё `bower_components`,
 * `test` и `tests` (так ищет проекты сам pnpm).
 *
 * На диске обходятся и скрытые каталоги (как в списке файлов git-ревизии
 * базы: иначе база и рабочее дерево судились бы разными выборками). Каталог-
 * ссылка и каталог глубже {@link WorkspaceDirs.MAX_DEPTH}, до которых
 * дотягивается шаблон, — «не прочитано»: что в них увидит менеджер, гейт не
 * проверял.
 */
export class WorkspaceDirs {
  public static readonly MAX_DEPTH = 32;

  public static patterns(
    kind: Lockfile['kind'],
    rootManifest: Readonly<Record<string, unknown>>,
    pnpmSettings: Readonly<Record<string, unknown>>,
    labels: { manifest: string; workspace: string } = {
      manifest: 'package.json',
      workspace: 'pnpm-workspace.yaml',
    },
  ): string[] {
    const [raw, label, key] =
      kind === 'pnpm'
        ? [pnpmSettings.packages, labels.workspace, 'packages']
        : [WorkspaceDirs.npmWorkspaces(rootManifest.workspaces), labels.manifest, 'workspaces'];
    if (raw === undefined || raw === null) {
      return [];
    }
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
      throw new InputUnreadableError(label, `${key}: ожидался список шаблонов каталогов`);
    }
    for (const pattern of raw as string[]) {
      const body = pattern.replace(/^!/, '');
      if (
        /[[\]{}()\\]/.test(body) ||
        body === '' ||
        body.startsWith('/') ||
        /^[A-Za-z]:/.test(body) ||
        posix.normalize(body).split('/')[0] === '..'
      ) {
        throw new InputUnreadableError(
          label,
          `${key}: шаблон «${pattern}» вне поддерживаемого подмножества (*, ?, **, !исключение; путь внутри корня, разделитель «/»)`,
        );
      }
    }
    return raw as string[];
  }

  /** Каталоги из `dirs`, подходящие под шаблоны (корень `.` не входит: он проверяется всегда). */
  public static match(
    kind: Lockfile['kind'],
    patterns: readonly string[],
    dirs: readonly string[],
  ): string[] {
    const include = patterns.filter((pattern) => !pattern.startsWith('!')).map(WorkspaceDirs.split);
    const exclude = patterns
      .filter((pattern) => pattern.startsWith('!'))
      .map((pattern) => WorkspaceDirs.split(pattern.slice(1)));
    const ignored = WorkspaceDirs.ignored(kind);
    return dirs.filter((dir) => {
      const path = dir.split('/');
      return (
        dir !== '.' &&
        !path.some((segment) => ignored.includes(segment)) &&
        include.some((pattern) => pattern.length > 0 && WorkspaceDirs.matches(pattern, path)) &&
        !exclude.some((pattern) => WorkspaceDirs.matches(pattern, path))
      );
    });
  }

  /**
   * Каталоги с package.json на диске (относительно корня) и каталоги, которые
   * не прочитаны: ссылки (не открываются) и глубже {@link MAX_DEPTH}.
   * `node_modules` и `.git` не обходятся.
   */
  public static onDisk(root: string): { dirs: string[]; unread: string[] } {
    const found: string[] = [];
    const unread: string[] = [];
    const walk = (relative: string, depth: number): void => {
      for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isSymbolicLink() && WorkspaceDirs.isDirectory(join(root, child))) {
          unread.push(child);
          continue;
        }
        if (!entry.isDirectory()) {
          continue;
        }
        if (depth >= WorkspaceDirs.MAX_DEPTH) {
          unread.push(child);
          continue;
        }
        if (WorkspaceDirs.isFile(join(root, child, 'package.json'))) {
          found.push(child);
        }
        walk(child, depth + 1);
      }
    };
    walk('', 0);
    return { dirs: found.sort(), unread: unread.sort() };
  }

  /** Каталоги из `dirs`, в которые (или под которые) дотягивается шаблон включения. */
  public static reachable(
    kind: Lockfile['kind'],
    patterns: readonly string[],
    dirs: readonly string[],
  ): string[] {
    const include = patterns.filter((pattern) => !pattern.startsWith('!')).map(WorkspaceDirs.split);
    const ignored = WorkspaceDirs.ignored(kind);
    return dirs.filter((dir) => {
      const path = dir.split('/');
      return (
        !path.some((segment) => ignored.includes(segment)) &&
        include.some((pattern) => pattern.length > 0 && WorkspaceDirs.reaches(pattern, path))
      );
    });
  }

  /** Каталоги с package.json по списку файлов (ревизия git). */
  public static fromFiles(files: readonly string[]): string[] {
    return files
      .filter((file) => file.endsWith('/package.json'))
      .map((file) => file.slice(0, -'/package.json'.length))
      .sort();
  }

  private static npmWorkspaces(value: unknown): unknown {
    // yarn 1 допускает и форму `{ "packages": [...], "nohoist": [...] }`.
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { packages?: unknown }).packages
      : value;
  }

  private static split(pattern: string): string[] {
    return posix
      .normalize(pattern)
      .replace(/^\.\//, '')
      .replace(/\/$/, '')
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.');
  }

  private static ignored(kind: Lockfile['kind']): readonly string[] {
    return kind === 'pnpm' ? ['node_modules', 'bower_components', 'test', 'tests'] : ['node_modules'];
  }

  /** Шаблон совпадает с `path` или с каким-то каталогом под ним. */
  private static reaches(pattern: readonly string[], path: readonly string[]): boolean {
    const [head, ...rest] = pattern;
    if (path.length === 0) {
      return true;
    }
    if (head === '**') {
      // `**` не заходит в скрытые каталоги, но дальше шаблона может стоять явный сегмент на «.».
      return !path.some((segment) => segment.startsWith('.')) || WorkspaceDirs.reaches(rest, path);
    }
    const name = path[0] as string;
    return (
      head !== undefined && WorkspaceDirs.segment(head, name) && WorkspaceDirs.reaches(rest, path.slice(1))
    );
  }

  private static isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  private static isFile(path: string): boolean {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  }

  private static matches(pattern: readonly string[], path: readonly string[]): boolean {
    const [head, ...rest] = pattern;
    if (head === undefined) {
      return path.length === 0;
    }
    if (head === '**') {
      for (let skip = 0; skip <= path.length; skip += 1) {
        if (skip > 0 && (path[skip - 1] as string).startsWith('.')) {
          return false;
        }
        if (WorkspaceDirs.matches(rest, path.slice(skip))) {
          return true;
        }
      }
      return false;
    }
    const name = path[0];
    return (
      name !== undefined && WorkspaceDirs.segment(head, name) && WorkspaceDirs.matches(rest, path.slice(1))
    );
  }

  private static segment(pattern: string, name: string): boolean {
    if (name.startsWith('.') && !pattern.startsWith('.')) {
      return false;
    }
    const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
      char === '*' ? '[^/]*' : char === '?' ? '[^/]' : `\\${char}`,
    );
    return new RegExp(`^${source}$`).test(name);
  }
}
