import { posix } from 'node:path';

import { ParseYarnBerryLock } from '../lockfile/parse-yarn-berry-lock';
import { ConfigDependencies } from '../project/config-dependencies';
import { DirectDependencies } from '../project/direct-dependencies';
import { PnpmCatalog } from '../project/pnpm-catalog';
import { PnpmWorkspace } from '../project/pnpm-workspace';
import type { DirectDependency } from '../types/direct-dependency.type';
import type { Finding } from '../types/finding.type';
import type { Lockfile } from '../types/lockfile.type';
import type { RuleContext } from '../types/rule-context.type';
import type { RuleOutcome } from '../types/rule-outcome.type';

/**
 * Правило 6 (вторая половина). package.json и lock-файл согласованы: каждая
 * прямая зависимость записана в lock-файле с тем же спецификатором и в том же
 * поле, в lock-файле нет прямых зависимостей, которых нет в package.json, а
 * каждая записанная прямая зависимость указывает на пакет, который в
 * lock-файле есть. Расхождение значит, что ставится не то, что проверено:
 * `--frozen-lockfile` упадёт, а `install` без него перерешит дерево мимо гейта.
 *
 * Согласованным считается и то, что менеджер пишет иначе, чем package.json:
 * спецификатор из `overrides` lock-файла pnpm, ссылки `link:` при
 * `excludeLinksFromLockfile`, зависимость, объявленная в двух полях (менеджер
 * пишет её в одно из них), у yarn 1 — зависимость на пакет workspace (yarn
 * его не пишет в yarn.lock; совпадение диапазона с версией пакета проверяет
 * сам yarn при `--frozen-lockfile`).
 */
export class LockMismatchRule {
  public static readonly id = 'lock-mismatch' as const;

  public static run(context: RuleContext): RuleOutcome {
    const findings: Finding[] = [];
    let checked = 0;
    const lock = context.lock;
    const violation = (subject: string, reason: string, path: string, line?: number): void => {
      findings.push({
        rule: 'lock-mismatch',
        verdict: 'violation',
        path,
        ...(line === undefined ? {} : { line }),
        subject,
        reason,
      });
    };
    const workspaceNames = new Set(
      context.manifests.map((manifest) => manifest.json.name).filter((name) => typeof name === 'string'),
    );
    for (const manifest of context.manifests) {
      const declared = new Map<string, DirectDependency[]>();
      for (const dep of DirectDependencies.of(manifest)) {
        declared.set(dep.name, [...(declared.get(dep.name) ?? []), dep]);
      }
      if (!lock.importers) {
        for (const [name, deps] of declared) {
          checked += 1;
          const first = deps[0] as DirectDependency;
          if (
            !deps.some((dep) => lock.selectors?.has(`${name}@${dep.specifier}`)) &&
            !workspaceNames.has(name)
          ) {
            violation(
              name,
              `в ${lock.path} нет записи «${name}@${first.specifier}»: lock-файл устарел`,
              manifest.path,
              first.line,
            );
          }
        }
        continue;
      }
      const locked = Object.hasOwn(lock.importers, manifest.importer)
        ? lock.importers[manifest.importer]
        : undefined;
      // Корень без зависимостей pnpm v6 в importers не пишет; проект workspace — пишет всегда.
      if (locked === undefined && manifest.importer !== '.') {
        checked += 1;
        violation(
          manifest.importer,
          `проекта ${manifest.importer} (${manifest.path}) нет в ${lock.path}: lock-файл устарел`,
          manifest.path,
        );
      }
      for (const [name, deps] of declared) {
        checked += 1;
        const first = deps[0] as DirectDependency;
        const entry = locked !== undefined && Object.hasOwn(locked, name) ? locked[name] : undefined;
        if (!entry) {
          if (!(lock.linksOmitted && deps.every((dep) => /^link:/i.test(dep.specifier)))) {
            violation(
              name,
              `${first.field}: «${first.specifier}» нет в ${lock.path} (проект ${manifest.importer}): lock-файл устарел`,
              manifest.path,
              first.line,
            );
          }
          continue;
        }
        // yarn 2+ пишет прямые зависимости одним списком — поле не сравнивается.
        const same = lock.directFieldsMerged ? deps[0] : deps.find((dep) => dep.field === entry.field);
        if (!same) {
          violation(
            name,
            `поле расходится: package.json ${deps.map((dep) => dep.field).join(', ')}, ${lock.path} ${entry.field}`,
            manifest.path,
            first.line,
          );
        } else if (
          !deps.some((dep) => LockMismatchRule.sameAsLocked(lock, dep.specifier, entry.specifier)) &&
          !LockMismatchRule.overridden(lock, name, entry.specifier)
        ) {
          violation(
            name,
            `спецификатор расходится: package.json «${same.specifier}», ${lock.path} «${entry.specifier}»`,
            manifest.path,
            same.line,
          );
        }
      }
      for (const [name, entry] of Object.entries(locked ?? {})) {
        if (!declared.has(name)) {
          checked += 1;
          violation(
            name,
            `в ${lock.path} (проект ${manifest.importer}) есть, в ${manifest.path} нет`,
            lock.path,
            entry.line,
          );
        }
      }
    }
    const rootJson = context.manifests.find((manifest) => manifest.importer === '.')?.json ?? {};
    for (const dangling of lock.dangling ?? []) {
      if (
        LockMismatchRule.resolvedByBerryResolutions(lock, rootJson, dangling.name, dangling.version) ||
        LockMismatchRule.resolvedByBerryCatalog(context, dangling.name, dangling.version)
      ) {
        continue;
      }
      checked += 1;
      violation(
        dangling.name,
        `проект ${dangling.importer}: прямая зависимость указывает на «${dangling.version}», а такого пакета в ${lock.path} нет — дерево не проверено`,
        lock.path,
        dangling.line,
      );
    }
    checked += LockMismatchRule.configDependencies(context, violation);
    checked += LockMismatchRule.pnpmCatalogs(context, violation);
    return { findings, checked };
  }

  /**
   * Спецификатор package.json записан в lock-файле: как есть, а у yarn 2+ — и
   * в форме дескриптора (`^1.0.0` → `npm:^1.0.0`).
   */
  private static sameAsLocked(lock: Lockfile, declared: string, locked: string): boolean {
    return (
      declared === locked ||
      (lock.kind === 'yarn-berry' && ParseYarnBerryLock.descriptorRange(declared) === locked)
    );
  }

  /**
   * yarn 2+: прямая зависимость, которую `resolutions` корневого package.json
   * (ключ `имя` или `имя@диапазон`) подменяет дескриптором, записанным в
   * lock-файле, — не висячая (так yarn пишет `patch:` из resolutions).
   */
  private static resolvedByBerryResolutions(
    lock: Lockfile,
    rootJson: Readonly<Record<string, unknown>>,
    name: string,
    range: string,
  ): boolean {
    const resolutions = rootJson.resolutions;
    if (lock.kind !== 'yarn-berry' || typeof resolutions !== 'object' || resolutions === null) {
      return false;
    }
    const table = resolutions as Record<string, unknown>;
    const value = [`${name}@${range}`, name]
      .map((key) => (Object.hasOwn(table, key) ? table[key] : undefined))
      .find((entry) => typeof entry === 'string') as string | undefined;
    return (
      value !== undefined &&
      (lock.selectors?.has(`${name}@${value}`) === true ||
        lock.selectors?.has(`${name}@${ParseYarnBerryLock.descriptorRange(value)}`) === true)
    );
  }

  /**
   * yarn 4.10+: прямая зависимость `catalog:[имя]` записана в проекте как в
   * package.json, а пакет — под дескриптором диапазона из каталога
   * `.yarnrc.yml` (`catalog:` → `npm:^1.0.0`). Записи в каталоге нет или
   * дескриптора нет в lock-файле — висячая.
   */
  private static resolvedByBerryCatalog(context: RuleContext, name: string, specifier: string): boolean {
    const lock = context.lock;
    const catalogs = context.catalogs;
    if (lock.kind !== 'yarn-berry' || catalogs === undefined) {
      return false;
    }
    const range = PnpmCatalog.lookup(catalogs.settings, name, specifier, catalogs.file)?.range;
    return (
      range !== undefined &&
      (lock.selectors?.has(`${name}@${range}`) === true ||
        lock.selectors?.has(`${name}@${ParseYarnBerryLock.descriptorRange(range)}`) === true)
    );
  }

  /** Спецификатор lock-файла — подмена из `overrides` pnpm для этой зависимости. */
  private static overridden(lock: Lockfile, name: string, specifier: string): boolean {
    return Object.entries(lock.overrides ?? {}).some(
      ([selector, value]) =>
        (selector === name || (selector.startsWith(`${name}@`) && !selector.includes('>'))) &&
        LockMismatchRule.sameSpecifier(value, specifier),
    );
  }

  /** Равны, или пути `file:`/`link:` равны после нормализации (`file:./x` и `file:x`). */
  private static sameSpecifier(a: string, b: string): boolean {
    const path = /^(file|link):(.*)$/i;
    const left = path.exec(a);
    const right = path.exec(b);
    return (
      a === b ||
      (left !== null &&
        right !== null &&
        (left[1] as string).toLowerCase() === (right[1] as string).toLowerCase() &&
        posix.normalize(left[2] as string) === posix.normalize(right[2] as string))
    );
  }

  /** Config-зависимости pnpm-workspace.yaml и lock-файла: те же имена и версии. */
  /**
   * pnpm 9.5+: прямая зависимость `catalog:[имя]` решена по диапазону каталога,
   * записанному в lock-файле (`catalogs.<имя>.<пакет>.specifier`). Каталог
   * pnpm-workspace.yaml изменён без переустановки — `pnpm install
   * --frozen-lockfile` откажет (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH), а обычный
   * install перерешит дерево мимо проверенного: сверка `catalog:` с `catalog:`
   * в importers этого не видит. Записи в каталоге нет — дело floating-range.
   */
  private static pnpmCatalogs(
    context: RuleContext,
    violation: (subject: string, reason: string, path: string, line?: number) => void,
  ): number {
    const catalogs = context.catalogs;
    if (context.lock.kind !== 'pnpm' || catalogs === undefined) {
      return 0;
    }
    const locked = context.lock.catalogs ?? {};
    let checked = 0;
    for (const manifest of context.manifests) {
      for (const dep of DirectDependencies.of(manifest)) {
        const found = PnpmCatalog.lookup(catalogs.settings, dep.name, dep.specifier, catalogs.file);
        if (found?.range === undefined) {
          continue;
        }
        checked += 1;
        const catalogName =
          dep.specifier
            .trim()
            .replace(/^catalog:/i, '')
            .trim() || 'default';
        const table = Object.hasOwn(locked, catalogName) ? locked[catalogName] : undefined;
        const entry = table !== undefined && Object.hasOwn(table, dep.name) ? table[dep.name] : undefined;
        if (entry?.specifier !== found.range) {
          violation(
            dep.name,
            `каталог ${catalogs.file} ${found.label}, в ${context.lock.path} catalogs.${catalogName} ${entry === undefined ? '— нет записи' : `«${entry.specifier}»`}: lock-файл устарел`,
            manifest.path,
            dep.line,
          );
        }
      }
    }
    return checked;
  }

  private static configDependencies(
    context: RuleContext,
    violation: (subject: string, reason: string, path: string, line?: number) => void,
  ): number {
    if (context.lock.kind !== 'pnpm') {
      return 0;
    }
    const declared = ConfigDependencies.of(context.pnpmWorkspace);
    const locked = context.lock.configDependencies ?? {};
    let checked = 0;
    for (const config of declared) {
      checked += 1;
      const version = config.specifier.replace(/\+.*$/, '');
      const entry = Object.hasOwn(locked, config.name) ? locked[config.name] : undefined;
      if (entry === undefined) {
        violation(
          config.name,
          `configDependencies: «${version}» нет в ${context.lock.path}: lock-файл устарел`,
          PnpmWorkspace.FILE,
          config.line,
        );
      } else if (entry.specifier !== version) {
        violation(
          config.name,
          `config-зависимость расходится: ${PnpmWorkspace.FILE} «${version}», ${context.lock.path} «${entry.specifier}»`,
          PnpmWorkspace.FILE,
          config.line,
        );
      }
    }
    const names = new Set(declared.map((config) => config.name));
    for (const [name, entry] of Object.entries(locked)) {
      if (!names.has(name)) {
        checked += 1;
        violation(
          name,
          `config-зависимость есть в ${context.lock.path}, в ${PnpmWorkspace.FILE} нет`,
          context.lock.path,
          entry.line,
        );
      }
    }
    return checked;
  }
}
