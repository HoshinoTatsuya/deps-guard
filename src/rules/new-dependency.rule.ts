import { BaselineFile } from '../baseline/baseline-file';
import { InputUnreadableError } from '../input-unreadable.error';
import { ReadLockfile } from '../lockfile/read-lockfile';
import { ConfigDependencies } from '../project/config-dependencies';
import { DependencyIdentity } from '../project/dependency-identity';
import { DirectDependencies } from '../project/direct-dependencies';
import { PnpmWorkspace } from '../project/pnpm-workspace';
import { ReadManifests } from '../project/read-manifests';
import { WorkspaceDirs } from '../project/workspace-dirs';
import { YarnToolchain } from '../project/yarn-toolchain';
import { YarnrcYml } from '../project/yarnrc-yml';
import type { Finding } from '../types/finding.type';
import type { RuleContext } from '../types/rule-context.type';
import type { RuleOutcome } from '../types/rule-outcome.type';
import type { YamlDocument } from '../types/yaml-document.type';
import type { YamlObject } from '../types/yaml-object.type';
import { AllowEntries } from './allow-entries';

/**
 * Правило 1. Прямая зависимость, которой нет в базе (git-ревизия или файл
 * базовой линии), — только с записью-причиной в `newDependencies.allow`.
 *
 * Зависимость — это настоящий пакет и его источник, а не ключ package.json
 * ({@link DependencyIdentity}): `npm:`-алиас под старым ключом
 * (`aa-lib: npm:bb-lib@1.0.0`) — новая зависимость `bb-lib`; смена источника
 * под старым ключом (адрес архива, git, путь) — новая зависимость
 * `aa-lib@<источник>`, и допуск пишется под этим предметом.
 * Config-зависимости pnpm (их код pnpm исполняет до установки) — тоже прямые.
 *
 * База — по всему репозиторию: перенос зависимости между пакетами workspace
 * (и переименование пакета) не вносит в репозиторий нового кода. Проекты базы
 * — проекты её lock-файла и каталоги по её шаблонам workspace, а не пути
 * текущих package.json. Допуск зависимости, удалённой отовсюду, — «устарело».
 */
export class NewDependencyRule {
  public static readonly id = 'new-dependency' as const;

  public static run(context: RuleContext): RuleOutcome {
    const section = context.config.newDependencies;
    const settings = context.catalogs?.settings ?? PnpmWorkspace.settings(context.pnpmWorkspace);
    const current = context.manifests.flatMap((manifest) =>
      DirectDependencies.of(manifest).map((dep) => ({
        name: DependencyIdentity.of(dep.name, dep.specifier, manifest.importer, settings),
        path: manifest.path,
        line: dep.line,
        what:
          dep.name === dep.target
            ? `${dep.field}: ${dep.specifier}`
            : `${dep.field}: ${dep.name} → ${dep.specifier}`,
      })),
    );
    if (context.lock.kind === 'pnpm') {
      for (const config of ConfigDependencies.of(context.pnpmWorkspace)) {
        current.push({
          name: config.name,
          path: PnpmWorkspace.FILE,
          line: config.line,
          what: `configDependencies: ${config.specifier.replace(/\+.*$/, '')} — код исполняется до установки`,
        });
      }
    }
    if (context.lock.kind === 'yarn-berry') {
      for (const entry of YarnToolchain.onDisk(context.root)) {
        current.push({ name: entry.name, path: YarnToolchain.FILE, line: entry.line, what: entry.what });
      }
    }
    const names = new Set(current.map((dep) => dep.name));
    const audit = AllowEntries.audit(
      'new-dependency',
      'newDependencies',
      section?.allow,
      context.configPath,
      (subject) => names.has(subject),
    );
    const base = NewDependencyRule.baseNames(context);
    if (base instanceof Error || base === undefined) {
      const notChecked: Finding = {
        rule: 'new-dependency',
        verdict: base === undefined ? 'unverified' : 'broken',
        path: context.configPath,
        subject: 'newDependencies.baseline',
        reason:
          base === undefined
            ? 'база не задана (newDependencies.baseline или --base): новые зависимости не проверены'
            : base.message,
      };
      return { findings: [...audit, notChecked], checked: 0 };
    }
    const reported = new Set<string>();
    const findings: Finding[] = [];
    for (const dep of current) {
      if (base.has(dep.name) || reported.has(dep.name)) {
        continue;
      }
      reported.add(dep.name);
      if (!AllowEntries.isAllowed(section?.allow, dep.name)) {
        findings.push({
          rule: 'new-dependency',
          verdict: 'violation',
          path: dep.path,
          ...(dep.line === undefined ? {} : { line: dep.line }),
          subject: dep.name,
          reason: `новая прямая зависимость (${dep.what}) без записи-причины в newDependencies.allow`,
        });
      }
    }
    return { findings: [...findings, ...audit], checked: current.length };
  }

  /** Имена прямых зависимостей базы: `undefined` — база не задана; Error — не прочитана. */
  private static baseNames(context: RuleContext): Set<string> | Error | undefined {
    const baseline = context.config.newDependencies?.baseline;
    const ref = context.baseRef ?? (baseline && 'gitRef' in baseline ? baseline.gitRef : undefined);
    try {
      if (ref !== undefined) {
        return NewDependencyRule.gitNames(context, ref);
      }
      return baseline && 'file' in baseline ? BaselineFile.read(context.root, baseline.file) : undefined;
    } catch (error) {
      return error as Error;
    }
  }

  private static gitNames(context: RuleContext, ref: string): Set<string> {
    const kind = context.lock.kind;
    const importers = new Set(context.manifests.map((manifest) => manifest.importer));
    const baseLock = context.gitShow(ref, context.lock.path);
    if (baseLock !== undefined) {
      try {
        for (const importer of Object.keys(ReadLockfile.parse(context.lock.path, baseLock).importers ?? {})) {
          importers.add(importer);
        }
      } catch (error) {
        // Lock-файл базы, который не читается, базу не сужает: проекты берутся из шаблонов workspace.
        if (!(error instanceof InputUnreadableError)) {
          throw error;
        }
      }
    }
    const rootText = context.gitShow(ref, 'package.json');
    const rootJson =
      rootText === undefined ? {} : ReadManifests.fromText('.', `${ref}:package.json`, rootText).json;
    const workspaceText = kind === 'pnpm' ? context.gitShow(ref, PnpmWorkspace.FILE) : undefined;
    const workspace: YamlDocument | undefined =
      workspaceText === undefined
        ? undefined
        : PnpmWorkspace.parse(workspaceText, `${ref}:${PnpmWorkspace.FILE}`);
    const patterns = WorkspaceDirs.patterns(kind, rootJson, PnpmWorkspace.settings(workspace), {
      manifest: `${ref}:package.json`,
      workspace: `${ref}:${PnpmWorkspace.FILE}`,
    });
    if (patterns.length > 0) {
      for (const dir of WorkspaceDirs.match(kind, patterns, WorkspaceDirs.fromFiles(context.gitList(ref)))) {
        importers.add(dir);
      }
    }
    const names = new Set<string>();
    const settings =
      kind === 'yarn-berry' ? NewDependencyRule.baseYarnrc(context, ref) : PnpmWorkspace.settings(workspace);
    for (const importer of importers) {
      const path = importer === '.' ? 'package.json' : `${importer}/package.json`;
      const text = context.gitShow(ref, path);
      if (text !== undefined) {
        for (const dep of DirectDependencies.of(ReadManifests.fromText(importer, `${ref}:${path}`, text))) {
          names.add(DependencyIdentity.of(dep.name, dep.specifier, importer, settings));
        }
      }
    }
    for (const config of ConfigDependencies.of(workspace, `${ref}:${PnpmWorkspace.FILE}`)) {
      names.add(config.name);
    }
    if (kind === 'yarn-berry') {
      try {
        const entries = YarnToolchain.entries(
          context.gitShow(ref, YarnToolchain.FILE),
          (path) => context.gitShow(ref, path),
          `${ref}:${YarnToolchain.FILE}`,
        );
        for (const entry of entries) {
          names.add(entry.name);
        }
      } catch (error) {
        // Непрочитанная настройка базы базу не расширяет: всё текущее судится как новое.
        if (!(error instanceof InputUnreadableError)) {
          throw error;
        }
      }
    }
    return names;
  }

  /**
   * Каталоги версий `.yarnrc.yml` базы (yarn 4.10+). Непрочитанная настройка
   * базу не расширяет: `catalog:` базы остаётся неразрешённым предметом, и всё
   * текущее судится как новое.
   */
  private static baseYarnrc(context: RuleContext, ref: string): YamlObject {
    const text = context.gitShow(ref, YarnrcYml.FILE);
    try {
      return YarnrcYml.settings(
        text === undefined ? undefined : YarnrcYml.parse(text, `${ref}:${YarnrcYml.FILE}`),
      );
    } catch (error) {
      if (!(error instanceof InputUnreadableError)) {
        throw error;
      }
      return Object.create(null);
    }
  }
}
