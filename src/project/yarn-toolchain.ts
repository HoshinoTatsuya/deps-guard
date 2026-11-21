import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import { PackageOrigin } from '../lockfile/package-origin';
import type { YamlDocument } from '../types/yaml-document.type';
import type { YamlObject } from '../types/yaml-object.type';
import { YamlSubset } from '../yaml/yaml-subset';
import { YamlSubsetError } from '../yaml/yaml-subset.error';
import { DependencyIdentity } from './dependency-identity';

/**
 * Код и зависимости, которые вносит в установку `.yarnrc.yml` yarn 2+, — как
 * прямые зависимости (их судит `new-dependency` относительно базы):
 *
 * - `yarnPath` — файл yarn из репозитория: его исполняет ЛЮБАЯ команда yarn;
 * - `plugins` — файлы плагинов (запись строкой или `path:`): тоже исполняются
 *   любой командой, `checksum` записи yarn 4.0.2 не сверяет (замер);
 * - `packageExtensions.<селектор>.dependencies` — зависимости, которые yarn
 *   добавляет чужому пакету (в yarn.lock они видны пакетами дерева, а у
 *   расширяемого пакета — нет).
 *
 * Предмет файла — `yarnPath@<путь>#sha256=<хэш>` / `plugin@<путь>#sha256=<хэш>`:
 * смена пути ИЛИ содержимого — новый предмет. Путь вне репозитория, файл,
 * который не прочитан, плагин без `path` (yarn его не загрузит: `spec` по
 * адресу он не скачивает — замер), запись не по форме — «не прочитано».
 */
export class YarnToolchain {
  public static readonly FILE = '.yarnrc.yml';

  /**
   * Предметы `.yarnrc.yml` с текстом `text`; `read` — содержимое файла
   * репозитория по пути от корня (`undefined` — нет или не прочитан).
   */
  public static entries(
    text: string | undefined,
    read: (path: string) => string | undefined,
    label: string = YarnToolchain.FILE,
  ): Array<{ name: string; line?: number; what: string }> {
    if (text === undefined) {
      return [];
    }
    let document: YamlDocument;
    try {
      document = YamlSubset.parseFailsafe(text);
    } catch (error) {
      if (error instanceof YamlSubsetError) {
        throw new InputUnreadableError(label, error.detail, error.line);
      }
      throw error;
    }
    const settings = YarnToolchain.object(document.value) ?? {};
    const found: Array<{ name: string; line?: number; what: string }> = [];
    const add = (name: string, line: number | undefined, what: string): void => {
      found.push({ name, ...(line === undefined ? {} : { line }), what });
    };
    const fail = (detail: string, line: number | undefined): never => {
      throw new InputUnreadableError(label, detail, line);
    };
    if (Object.hasOwn(settings, 'yarnPath')) {
      const line = document.lineOf(settings, 'yarnPath');
      const path = settings.yarnPath;
      if (typeof path !== 'string' || path === '') {
        fail('yarnPath: ожидался путь к файлу', line);
      }
      add(
        YarnToolchain.fileSubject('yarnPath', path as string, read, label, line),
        line,
        `yarnPath: ${String(path)} — исполняется любой командой yarn`,
      );
    }
    const plugins = settings.plugins;
    if (plugins !== undefined && plugins !== null) {
      if (!Array.isArray(plugins)) {
        fail('plugins: ожидался список', document.lineOf(settings, 'plugins'));
      }
      const line = document.lineOf(settings, 'plugins');
      for (const plugin of plugins as unknown[]) {
        const body = YarnToolchain.object(plugin);
        const path = typeof plugin === 'string' ? plugin : body?.path;
        if (typeof path !== 'string' || path === '') {
          fail(
            typeof body?.spec === 'string'
              ? `plugins: плагин «${body.spec}» без path — yarn его не загрузит (spec не скачивается); запишите path к файлу в репозитории`
              : 'plugins: ожидалась строка-путь или { path: … }',
            line,
          );
        }
        add(
          YarnToolchain.fileSubject('plugin', path as string, read, label, line),
          line,
          `plugins: ${String(path)} — исполняется любой командой yarn`,
        );
      }
    }
    const extensions = settings.packageExtensions;
    if (extensions !== undefined && extensions !== null) {
      const table =
        YarnToolchain.object(extensions) ??
        fail('packageExtensions: ожидалось отображение', document.lineOf(settings, 'packageExtensions'));
      for (const [selector, extension] of Object.entries(table)) {
        const line = document.lineOf(table, selector);
        const body =
          YarnToolchain.object(extension) ??
          fail(`packageExtensions["${selector}"]: ожидалось отображение`, line);
        for (const key of Object.keys(body)) {
          if (!['dependencies', 'peerDependencies', 'peerDependenciesMeta'].includes(key)) {
            fail(`packageExtensions["${selector}"].${key}: поле не разобрано`, line);
          }
        }
        const deps = body.dependencies;
        if (deps === undefined || deps === null) {
          continue;
        }
        const map =
          YarnToolchain.object(deps) ??
          fail(`packageExtensions["${selector}"].dependencies: ожидалось отображение`, line);
        for (const [name, specifier] of Object.entries(map)) {
          if (typeof specifier !== 'string') {
            fail(
              `packageExtensions["${selector}"].dependencies.${name}: ожидалась строка`,
              document.lineOf(map, name) ?? line,
            );
          }
          add(
            DependencyIdentity.of(name, specifier as string, '.', Object.create(null)),
            document.lineOf(map, name) ?? line,
            `packageExtensions["${selector}"].dependencies: ${name}@${String(specifier)} — yarn добавляет её пакету`,
          );
        }
      }
    }
    return found;
  }

  /** Предметы `.yarnrc.yml` рабочего дерева (файлы — с диска, только внутри корня). */
  public static onDisk(root: string): Array<{ name: string; line?: number; what: string }> {
    const path = join(root, YarnToolchain.FILE);
    return YarnToolchain.entries(
      existsSync(path) ? readFileSync(path, 'utf8') : undefined,
      YarnToolchain.diskReader(root),
    );
  }

  /** Файл репозитория по пути от корня; ссылка, ведущая за пределы корня, — не прочитан. */
  public static diskReader(root: string): (path: string) => string | undefined {
    return (path) => {
      try {
        const base = realpathSync(root);
        const full = realpathSync(join(root, path));
        return full.startsWith(`${base}${sep}`) ? readFileSync(full, 'utf8') : undefined;
      } catch {
        return undefined;
      }
    };
  }

  private static fileSubject(
    kind: 'yarnPath' | 'plugin',
    raw: string,
    read: (path: string) => string | undefined,
    label: string,
    line: number | undefined,
  ): string {
    const path = posix.normalize(raw.replace(/\\/g, '/'));
    if (PackageOrigin.isAbsolute(raw) || path === '..' || path.startsWith('../')) {
      throw new InputUnreadableError(label, `${kind}: ${raw} — вне репозитория: гейт его не видит`, line);
    }
    const text = read(path);
    if (text === undefined) {
      throw new InputUnreadableError(label, `${kind}: файл ${path} не прочитан`, line);
    }
    return `${kind}@${path}#sha256=${createHash('sha256').update(text).digest('hex')}`;
  }

  private static object(value: unknown): YamlObject | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as YamlObject)
      : undefined;
  }
}
