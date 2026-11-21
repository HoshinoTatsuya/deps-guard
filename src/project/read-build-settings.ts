import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import type { BuildSettings } from '../types/build-settings.type';
import type { Lockfile } from '../types/lockfile.type';
import type { Manifest } from '../types/manifest.type';
import { RcFile } from './rc-file';
import { YarnrcYml } from './yarnrc-yml';

/**
 * Решения о install-скриптах — ровно из тех источников, которые читает
 * менеджер этой версии (замер на pnpm 9.15, 11.1, 12.4 и yarn 1.22):
 *
 * - npm — `ignore-scripts=true` в `.npmrc`;
 * - yarn 1 — `ignore-scripts true` в `.yarnrc` (`.npmrc` yarn 1 для этого НЕ
 *   читает и выполняет postinstall);
 * - pnpm < 10 — поле `pnpm` package.json (`onlyBuiltDependencies`,
 *   `onlyBuiltDependenciesFile`, `neverBuiltDependencies`) и `ignore-scripts`
 *   в `.npmrc`; pnpm-workspace.yaml эти версии для настроек не читают;
 * - pnpm 11+ — только pnpm-workspace.yaml: `allowBuilds`,
 *   `dangerouslyAllowAllBuilds`, `ignoreScripts`. Поле `pnpm` package.json,
 *   `.npmrc` и ключи `onlyBuiltDependencies`/`neverBuiltDependencies`/
 *   `ignoredBuiltDependencies` они не читают;
 * - pnpm 12.11+ — ещё `permissions.<ключ>.build` (true/false): запись того же
 *   ключа, что в `allowBuilds`, перекрывает его; разные ключи одного пакета
 *   (`имя` и `имя@версия`) — запрет сильнее (замер pnpm 12.11.0 и 12.21.0);
 *   строка вместо булева — решения нет; pnpm 12.10 и младше `permissions` не
 *   читают (предупреждение «not recognized»);
 * - pnpm 10 и незафиксированная версия — все источники разом;
 * - yarn 2+ — `enableScripts` в `.yarnrc.yml` (false — скрипты остальных
 *   запрещены) и `dependenciesMeta.<пакет[@версия]>.built` корневого
 *   package.json (true — разрешён и при `enableScripts: false`, false —
 *   запрещён); замер на yarn 4.0.2–4.18.1. Без `enableScripts` решает формат
 *   yarn.lock: 9+ пишет yarn 4.14+, у которого скрипты по умолчанию запрещены
 *   (а младший yarn в CI такой файл не примет — `--immutable` откажет); 8 и
 *   младше — скрипты разрешены (yarn 4.14+ на таком файле сам дописывает
 *   `enableScripts: true`). При `enableImmutableInstalls: false` формат
 *   поколение yarn не доказывает. `.npmrc` и `.yarnrc` yarn 2+ не читает.
 *
 * Заданный, но не читаемый этой версией ключ решением не считается и
 * называется в находке. Из `.npmrc` и `.yarnrc` читаются только названные
 * ключи: там же лежат токены реестров.
 */
export class ReadBuildSettings {
  private static readonly ALL_KEYS = [
    'allowBuilds',
    'onlyBuiltDependencies',
    'onlyBuiltDependenciesFile',
    'ignoredBuiltDependencies',
    'neverBuiltDependencies',
    'dangerouslyAllowAllBuilds',
    'ignoreScripts',
    'permissions',
  ] as const;

  private static readonly PNPM9_KEYS = [
    'onlyBuiltDependencies',
    'onlyBuiltDependenciesFile',
    'neverBuiltDependencies',
  ] as const;

  private static readonly PNPM11_KEYS = [
    'allowBuilds',
    'dangerouslyAllowAllBuilds',
    'ignoreScripts',
  ] as const;

  /** pnpm 12.11+: `permissions` (решение `build` перекрывает `allowBuilds`). */
  private static readonly PNPM12_11_KEYS = [...ReadBuildSettings.PNPM11_KEYS, 'permissions'] as const;

  public static read(
    root: string,
    rootManifest: Manifest,
    kind: Lockfile['kind'],
    pnpmSettings: Readonly<Record<string, unknown>> = {},
    berryFormat?: number,
  ): BuildSettings {
    const allow = new Set<string>();
    const deny = new Set<string>();
    const sources: string[] = [];
    const unread: string[] = [];
    let hasOnlyBuiltDependencies = false;
    let allowAll = false;
    let ignoreScripts = false;
    const npmrc = RcFile.read(
      root,
      '.npmrc',
      (key) => key === 'ignore-scripts' || key === 'dangerously-allow-all-builds',
    );
    const npmrcFlag = (key: string): boolean => npmrc.get(key)?.value === 'true';
    if (kind === 'npm') {
      ignoreScripts = npmrcFlag('ignore-scripts');
      return {
        manager: kind,
        allow,
        deny,
        hasOnlyBuiltDependencies,
        allowAll,
        ignoreScripts,
        sources,
        unread,
      };
    }
    if (kind === 'yarn-berry') {
      return ReadBuildSettings.berry(root, rootManifest, npmrc.has('ignore-scripts'), berryFormat);
    }
    if (kind === 'yarn') {
      const yarnrc = RcFile.read(root, '.yarnrc', (key) => key === 'ignore-scripts');
      ignoreScripts = yarnrc.get('ignore-scripts')?.value === 'true';
      if (npmrc.has('ignore-scripts')) {
        unread.push('.npmrc: ignore-scripts (yarn 1 его не читает — нужен ignore-scripts true в .yarnrc)');
      }
      return {
        manager: kind,
        allow,
        deny,
        hasOnlyBuiltDependencies,
        allowAll,
        ignoreScripts,
        sources,
        unread,
      };
    }
    const version = ReadBuildSettings.pnpmVersion(rootManifest.json);
    const major = version?.major;
    const label = version === undefined ? '?' : `${version.major}.${version.minor}`;
    // allowBuilds и permissions.<ключ>.build — одна таблица: запись permissions перекрывает тот же ключ.
    const decisions = new Map<string, boolean>();
    const fromPermissions = new Set<string>();
    const apply = (
      settings: Readonly<Record<string, unknown>>,
      path: string,
      keys: readonly string[],
    ): void => {
      const fail = (detail: string): never => {
        throw new InputUnreadableError(path, detail);
      };
      let used = false;
      for (const key of ReadBuildSettings.ALL_KEYS) {
        if (!Object.hasOwn(settings, key) || settings[key] === undefined || settings[key] === null) {
          continue;
        }
        if (!keys.includes(key)) {
          unread.push(
            key === 'permissions'
              ? `${path}: permissions (pnpm ${label} его не читает — нужен 12.11+)`
              : `${path}: ${key} (pnpm ${major ?? '?'} его не читает)`,
          );
          continue;
        }
        used = true;
        const value = settings[key];
        if (key === 'allowBuilds') {
          if (typeof value !== 'object' || Array.isArray(value)) {
            fail('allowBuilds: ожидалось отображение «пакет: true|false»');
          }
          for (const [name, decision] of Object.entries(value as Record<string, unknown>)) {
            if (typeof decision === 'string') {
              // Заглушка pnpm 11+ «set this to true or false» (и любая строка) — решения нет:
              // пакет судится как пакет без решения, а не как непрочитанная настройка.
              unread.push(
                `${path}: allowBuilds.${name} = «${decision}» — решения нет (нужно true или false)`,
              );
              continue;
            }
            if (decision !== true && decision !== false) {
              fail(`allowBuilds.${name}: ожидалось true или false`);
            }
            if (!fromPermissions.has(name)) {
              decisions.set(name, decision as boolean);
            }
          }
        } else if (key === 'permissions') {
          if (typeof value !== 'object' || Array.isArray(value)) {
            fail('permissions: ожидалось отображение «пакет: { build: true|false }»');
          }
          for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
              fail(`permissions.${name}: ожидалось отображение возможностей (build, skills)`);
            }
            const build = (entry as Record<string, unknown>).build;
            if (build === undefined || build === null) {
              continue;
            }
            if (typeof build === 'string') {
              unread.push(
                `${path}: permissions.${name}.build = «${build}» — решения нет (нужно true или false)`,
              );
              continue;
            }
            if (build !== true && build !== false) {
              fail(`permissions.${name}.build: ожидалось true или false`);
            }
            decisions.set(name, build as boolean);
            fromPermissions.add(name);
          }
        } else if (key === 'dangerouslyAllowAllBuilds' || key === 'ignoreScripts') {
          if (typeof value !== 'boolean') {
            fail(`${key}: ожидалось true или false`);
          }
          allowAll ||= key === 'dangerouslyAllowAllBuilds' && value === true;
          ignoreScripts ||= key === 'ignoreScripts' && value === true;
        } else {
          const list =
            key === 'onlyBuiltDependenciesFile' ? ReadBuildSettings.listFile(root, value, path) : value;
          if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
            fail(`${key}: ожидался список имён`);
          }
          hasOnlyBuiltDependencies ||= key === 'onlyBuiltDependencies' || key === 'onlyBuiltDependenciesFile';
          for (const name of list as string[]) {
            (key === 'onlyBuiltDependencies' || key === 'onlyBuiltDependenciesFile' ? allow : deny).add(name);
          }
        }
      }
      if (used) {
        sources.push(path);
      }
    };
    const modern = major !== undefined && major >= 11;
    const legacy = major !== undefined && major < 10;
    const permissions =
      version !== undefined && (version.major > 12 || (version.major === 12 && version.minor >= 11));
    const workspaceKeys = permissions
      ? ReadBuildSettings.PNPM12_11_KEYS
      : modern
        ? ReadBuildSettings.PNPM11_KEYS
        : legacy
          ? []
          : ReadBuildSettings.ALL_KEYS;
    const fieldKeys = modern ? [] : legacy ? ReadBuildSettings.PNPM9_KEYS : ReadBuildSettings.ALL_KEYS;
    apply(pnpmSettings, 'pnpm-workspace.yaml', workspaceKeys);
    const pnpmField = rootManifest.json.pnpm;
    if (typeof pnpmField === 'object' && pnpmField !== null && !Array.isArray(pnpmField)) {
      apply(pnpmField as Record<string, unknown>, `${rootManifest.path} (pnpm)`, fieldKeys);
    }
    for (const key of ['ignore-scripts', 'dangerously-allow-all-builds']) {
      const readable = !modern && (key === 'ignore-scripts' || !legacy);
      if (!npmrc.has(key)) {
        continue;
      }
      if (!readable) {
        unread.push(`.npmrc: ${key} (pnpm ${major} его не читает)`);
        continue;
      }
      ignoreScripts ||= key === 'ignore-scripts' && npmrcFlag(key);
      allowAll ||= key === 'dangerously-allow-all-builds' && npmrcFlag(key);
    }
    for (const [name, decision] of decisions) {
      (decision ? allow : deny).add(name);
    }
    return {
      manager: kind,
      ...(version === undefined ? {} : { pnpmMajor: version.major, pnpmVersion: label }),
      allow,
      deny,
      hasOnlyBuiltDependencies,
      allowAll,
      ignoreScripts,
      sources,
      unread,
    };
  }

  private static berry(
    root: string,
    rootManifest: Manifest,
    npmrcIgnore: boolean,
    format: number | undefined,
  ): BuildSettings {
    const allow = new Set<string>();
    const deny = new Set<string>();
    const unread: string[] = [];
    const sources: string[] = [];
    const yarnrc = YarnrcYml.read(root);
    const enable = YarnrcYml.flag(yarnrc, 'enableScripts');
    // Формат 9+ пишет yarn 4.14+; младший yarn в CI его не примет, пока установка неизменяемая.
    let modern = format !== undefined && format >= 9;
    if (modern) {
      const immutable = YarnrcYml.flag(yarnrc, 'enableImmutableInstalls');
      if (immutable === false || immutable === 'env') {
        modern = false;
        if (enable === undefined) {
          unread.push(
            `${YarnrcYml.FILE}: enableImmutableInstalls ${immutable === 'env' ? 'из переменной окружения' : 'false'} — yarn младше 4.14 поставит yarn.lock формата ${format}, переписав его, и выполнит скрипты всех: умолчание yarn 4.14+ не подтверждено`,
          );
        }
      }
    }
    let blocked = false;
    let blockedByDefault = false;
    if (enable === 'env') {
      unread.push(`${YarnrcYml.FILE}: enableScripts из переменной окружения — гейт её не видит`);
    } else if (enable !== undefined) {
      sources.push(YarnrcYml.FILE);
      blocked = !enable;
    } else if (modern) {
      blocked = true;
      blockedByDefault = true;
    }
    const meta = rootManifest.json.dependenciesMeta;
    if (meta !== undefined && meta !== null) {
      if (typeof meta !== 'object' || Array.isArray(meta)) {
        throw new InputUnreadableError(rootManifest.path, 'dependenciesMeta: ожидалось отображение');
      }
      for (const [name, entry] of Object.entries(meta as Record<string, unknown>)) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          throw new InputUnreadableError(
            rootManifest.path,
            `dependenciesMeta.${name}: ожидалось отображение`,
          );
        }
        if (!Object.hasOwn(entry, 'built')) {
          continue;
        }
        const built = (entry as Record<string, unknown>).built;
        if (typeof built !== 'boolean') {
          throw new InputUnreadableError(
            rootManifest.path,
            `dependenciesMeta.${name}.built: ожидалось true или false`,
          );
        }
        (built ? allow : deny).add(name);
        if (!sources.includes(rootManifest.path)) {
          sources.push(rootManifest.path);
        }
      }
    }
    if (npmrcIgnore) {
      unread.push(
        '.npmrc: ignore-scripts (yarn 2+ .npmrc не читает — нужен enableScripts: false в .yarnrc.yml)',
      );
    }
    if (RcFile.read(root, '.yarnrc', (key) => key === 'ignore-scripts').has('ignore-scripts')) {
      unread.push(
        '.yarnrc: ignore-scripts (yarn 2+ .yarnrc не читает — нужен enableScripts: false в .yarnrc.yml)',
      );
    }
    return {
      manager: 'yarn-berry',
      allow,
      deny,
      // Как onlyBuiltDependencies: остальные запрещены, а разрешённые списком выполняются.
      hasOnlyBuiltDependencies: blocked,
      allowAll: false,
      ignoreScripts: false,
      execGated: modern,
      ...(blockedByDefault ? { blockedByDefault } : {}),
      sources,
      unread,
    };
  }

  /**
   * Версия pnpm (мажор и минор): `packageManager: pnpm@X.Y.Z`, иначе
   * `devEngines.packageManager` с версией `X.Y.Z`/`^X.Y.Z` (у `^` — нижняя
   * граница: решение читается, только если его читает КАЖДАЯ допустимая версия).
   */
  private static pnpmVersion(
    json: Readonly<Record<string, unknown>>,
  ): { major: number; minor: number } | undefined {
    const manager = json.packageManager;
    if (typeof manager === 'string') {
      const match = /^pnpm@(\d+)\.(\d+)\.\d+/.exec(manager);
      return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
    }
    const engines = (json.devEngines as { packageManager?: unknown } | undefined)?.packageManager;
    const list = Array.isArray(engines) ? engines : engines === undefined ? [] : [engines];
    for (const entry of list) {
      const { name, version } = (entry ?? {}) as { name?: unknown; version?: unknown };
      const match = typeof version === 'string' ? /^\^?(\d+)\.(\d+)\.\d+$/.exec(version) : null;
      if (name === 'pnpm' && match !== null && Number(match[1]) > 0) {
        return { major: Number(match[1]), minor: Number(match[2]) };
      }
    }
    return undefined;
  }

  private static listFile(root: string, value: unknown, path: string): unknown {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InputUnreadableError(path, 'onlyBuiltDependenciesFile: ожидался путь к JSON-списку');
    }
    try {
      return JSON.parse(readFileSync(join(root, value), 'utf8').replace(/^\uFEFF/, '')) as unknown;
    } catch (error) {
      throw new InputUnreadableError(
        value,
        `onlyBuiltDependenciesFile не прочитан (${(error as Error).message})`,
      );
    }
  }
}
