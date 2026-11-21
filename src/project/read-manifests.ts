import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import type { Lockfile } from '../types/lockfile.type';
import type { Manifest } from '../types/manifest.type';
import { WorkspaceDirs } from './workspace-dirs';

/**
 * package.json каждого проекта: корень, проекты lock-файла и каталоги
 * workspace по шаблонам менеджера ({@link WorkspaceDirs}). Нет файла или
 * битый JSON — отказ: прямые зависимости этого проекта иначе не проверены ни
 * одним правилом.
 */
export class ReadManifests {
  public static read(
    root: string,
    lock: Lockfile,
    pnpmSettings: Readonly<Record<string, unknown>> = {},
  ): Manifest[] {
    const rootManifest = ReadManifests.readOne(root, '.');
    const patterns = WorkspaceDirs.patterns(lock.kind, rootManifest.json, pnpmSettings);
    const importers = new Set<string>(Object.keys(lock.importers ?? {}));
    // Только корень (`packages: ['.']`) обходить диск не требует.
    if (patterns.some((pattern) => !/^!?\.?\/?$/.test(pattern))) {
      const disk = WorkspaceDirs.onDisk(root);
      const unread = WorkspaceDirs.reachable(lock.kind, patterns, disk.unread);
      if (unread.length > 0) {
        throw new InputUnreadableError(
          unread[0] as string,
          `каталог под шаблоном workspace не прочитан (ссылка или глубже ${WorkspaceDirs.MAX_DEPTH} уровней): ${unread.slice(0, 5).join(', ')}`,
        );
      }
      for (const dir of WorkspaceDirs.match(lock.kind, patterns, disk.dirs)) {
        importers.add(dir);
      }
    }
    importers.delete('.');
    return [rootManifest, ...[...importers].map((importer) => ReadManifests.readOne(root, importer))];
  }

  public static readOne(root: string, importer: string): Manifest {
    const path = importer === '.' ? 'package.json' : posix.join(importer, 'package.json');
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      throw new InputUnreadableError(path, `package.json не прочитан (${(error as Error).message})`);
    }
    return ReadManifests.fromText(importer, path, text);
  }

  public static fromText(importer: string, path: string, text: string): Manifest {
    let json: unknown;
    try {
      // BOM в начале npm отбрасывает (как и прочие разборщики package.json).
      json = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new InputUnreadableError(path, `не JSON: ${(error as Error).message}`);
    }
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new InputUnreadableError(path, 'ожидался объект');
    }
    return { importer, path, json: json as Record<string, unknown>, lines: ReadManifests.lines(text) };
  }

  /** `поле/имя` → строка объявления зависимости. */
  private static lines(text: string): Map<string, number> {
    const lines = new Map<string, number>();
    let field: string | undefined;
    text.split(/\r?\n/).forEach((line, index) => {
      const open = /^\s*"([A-Za-z]+Dependencies|dependencies)"\s*:\s*\{\s*(\}\s*,?)?\s*$/.exec(line);
      if (open?.[1] !== undefined) {
        field = open[2] === undefined ? open[1] : undefined;
        return;
      }
      if (field !== undefined && /^\s*\}/.test(line)) {
        field = undefined;
        return;
      }
      const entry = /^\s*"((?:[^"\\]|\\.)+)"\s*:/.exec(line);
      if (field !== undefined && entry?.[1] !== undefined) {
        lines.set(`${field}/${entry[1]}`, index + 1);
      }
    });
    return lines;
  }
}
