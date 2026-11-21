import { InputUnreadableError } from '../input-unreadable.error';
import type { LockedPackage } from '../types/locked-package.type';
import type { Lockfile } from '../types/lockfile.type';
import { PackageOrigin } from './package-origin';

/**
 * yarn.lock версии 1 (yarn classic). Формат yarn 2+ (`__metadata`) — отказ.
 * yarn не хранит ни прямых зависимостей проекта, ни признака install-скрипта:
 * сверка с package.json идёт по селекторам `имя@спецификатор`, скрипты — из
 * метаданных реестра.
 *
 * Имя пакета — настоящее, а не ключ алиаса (`"lodash@npm:lodahs@1.0.0"` —
 * пакет `lodahs`); запись без `resolved` (так yarn пишет `file:` и `link:`)
 * судится по спецификатору, а не считается реестровой.
 */
export class ParseYarnLock {
  public static parse(text: string, path: string): Lockfile {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (/^__metadata:/m.test(text)) {
      throw new InputUnreadableError(path, 'yarn.lock формата yarn 2+ не поддерживается (поддержан yarn v1)');
    }
    if (!lines.some((line) => /^# yarn lockfile v1\s*$/.test(line))) {
      throw new InputUnreadableError(path, 'нет заголовка «# yarn lockfile v1»');
    }
    const packages: LockedPackage[] = [];
    const selectors = new Set<string>();
    const keyOf = new Map<string, string>();
    const requires = new Map<string, string[]>();
    let current:
      | {
          selectors: string[];
          line: number;
          fields: Map<string, string>;
          block: string | undefined;
          requires: string[];
        }
      | undefined;
    const flush = (): void => {
      if (!current) {
        return;
      }
      const first = current.selectors[0] as string;
      const target = PackageOrigin.ofSelector(first);
      const version = current.fields.get('version');
      if (target === undefined || version === undefined) {
        throw new InputUnreadableError(path, `запись «${first}»: нет имени или version`, current.line);
      }
      for (const selector of current.selectors.slice(1)) {
        if (PackageOrigin.ofSelector(selector)?.name !== target.name) {
          throw new InputUnreadableError(
            path,
            `запись «${first}»: селектор «${selector}» другого пакета в той же записи`,
            current.line,
          );
        }
      }
      const integrity = current.fields.get('integrity');
      const resolved = current.fields.get('resolved');
      const key = current.selectors.join(', ');
      for (const selector of current.selectors) {
        keyOf.set(selector, key);
      }
      requires.set(key, current.requires);
      packages.push({
        name: target.name,
        version,
        key,
        line: current.line,
        source:
          resolved === undefined
            ? PackageOrigin.fromSpecifier(target.specifier)
            : PackageOrigin.fromUrl(resolved),
        ...(integrity === undefined ? {} : { integrity }),
      });
      current = undefined;
    };
    lines.forEach((line, index) => {
      const no = index + 1;
      if (line.trim() === '' || line.startsWith('#')) {
        return;
      }
      if (!line.startsWith(' ')) {
        flush();
        if (!line.endsWith(':')) {
          throw new InputUnreadableError(path, 'ожидалась строка селекторов, оканчивающаяся «:»', no);
        }
        const list = line
          .slice(0, -1)
          .split(/,\s*/)
          .map((selector) => ParseYarnLock.unquote(selector.trim(), path, no));
        for (const selector of list) {
          selectors.add(selector);
        }
        current = { selectors: list, line: no, fields: new Map(), block: undefined, requires: [] };
        return;
      }
      if (!current) {
        throw new InputUnreadableError(path, 'поле вне записи', no);
      }
      const field = /^ {2}([A-Za-z]+)(?: (.+)|:)$/.exec(line);
      if (field?.[1] !== undefined) {
        current.block = field[2] === undefined ? field[1] : undefined;
        if (field[2] !== undefined) {
          if (current.fields.has(field[1])) {
            throw new InputUnreadableError(path, `поле «${field[1]}» повторено`, no);
          }
          current.fields.set(field[1], ParseYarnLock.unquote(field[2], path, no));
        }
        return;
      }
      if (!/^ {4,}\S/.test(line)) {
        throw new InputUnreadableError(path, `строка не разобрана: ${line.trim()}`, no);
      }
      if (current.block === 'dependencies' || current.block === 'optionalDependencies') {
        const dep = /^ {4}("(?:[^"\\]|\\.)*"|[^\s"]+) ("(?:[^"\\]|\\.)*"|[^\s"]+)$/.exec(line);
        if (dep?.[1] === undefined || dep[2] === undefined) {
          throw new InputUnreadableError(path, `${current.block}: строка не разобрана: ${line.trim()}`, no);
        }
        current.requires.push(
          `${ParseYarnLock.unquote(dep[1], path, no)}@${ParseYarnLock.unquote(dep[2], path, no)}`,
        );
      }
    });
    flush();
    // Рёбра: зависимость записи `имя "диапазон"` — запись с селектором `имя@диапазон`
    // (у алиаса — `db@npm:цель@диапазон`, запись цели). Peer-зависимости yarn 1 не ставит.
    const linked = packages.map((pkg): LockedPackage => {
      const deps = [
        ...new Set(
          (requires.get(pkg.key) ?? [])
            .map((selector) => keyOf.get(selector))
            .filter((key): key is string => key !== undefined && key !== pkg.key),
        ),
      ];
      return deps.length === 0 ? pkg : { ...pkg, dependencies: deps };
    });
    return { kind: 'yarn', path, packages: linked, selectors };
  }

  private static unquote(value: string, path: string, no: number): string {
    if (!value.startsWith('"')) {
      return value;
    }
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new InputUnreadableError(path, `строка в кавычках не разобрана: ${value}`, no);
    }
  }
}
