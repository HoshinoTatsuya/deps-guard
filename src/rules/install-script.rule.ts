import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { SOURCE_BUILD_HOOKS } from '../constants/source-build-hooks.constant';
import { InputUnreadableError } from '../input-unreadable.error';
import { PackageOrigin } from '../lockfile/package-origin';
import { PnpmWorkspace } from '../project/pnpm-workspace';
import { ReadBuildSettings } from '../project/read-build-settings';
import { WorkspaceDirs } from '../project/workspace-dirs';
import type { BuildSettings } from '../types/build-settings.type';
import type { Finding } from '../types/finding.type';
import type { LockedPackage } from '../types/locked-package.type';
import type { RuleContext } from '../types/rule-context.type';
import type { RuleOutcome } from '../types/rule-outcome.type';
import { AllowEntries } from './allow-entries';

/**
 * Правило 2. Пакет дерева с preinstall/install/postinstall (или binding.gyp)
 * обязан иметь решение: разрешён (`installScripts.allow`, allowBuilds: true,
 * onlyBuiltDependencies) или явно запрещён (allowBuilds: false,
 * ignored-/neverBuiltDependencies). Пакет без решения — нарушение. Решение
 * засчитывается, только если его читает менеджер этой версии
 * ({@link ReadBuildSettings}).
 *
 * Плюс сверка, что настройка менеджера ДЕЙСТВИТЕЛЬНО запрещает остальные:
 * pnpm 10+ запрещает по умолчанию, pnpm < 10 — только при onlyBuiltDependencies,
 * dangerouslyAllowAllBuilds — нарушение, незафиксированная версия pnpm —
 * нарушение (неизвестно, какое поведение у CI). npm и yarn списков не знают:
 * запрет остальных подтверждается `ignore-scripts` (npm — `.npmrc`, yarn —
 * `.yarnrc`) или записью `installScripts.othersBlockedBy`, иначе — «не проверено».
 *
 * Признак скрипта: lock-файл (pnpm v6 `requiresBuild`, npm `hasInstallScript`),
 * затем метаданные реестра (`versions[v].hasInstallScript`), у локального
 * каталога — его package.json в репозитории (вместе с `prepare`: его менеджер
 * выполняет у каталога и git-зависимости). git-зависимость скрипт имеет
 * всегда: `prepare` собирает её при установке, а её package.json гейт не видит. Установленный node_modules
 * источником не служит: вердикт не зависит от того, ставили ли проект, а
 * скрипт пакета мог переписать собственный package.json. Нет данных — «не
 * проверено», не «чисто».
 */
export class InstallScriptRule {
  public static readonly id = 'install-script' as const;

  public static run(context: RuleContext): RuleOutcome {
    const root = context.manifests.find((manifest) => manifest.importer === '.');
    if (!root) {
      return { findings: [], checked: 0 };
    }
    let settings: BuildSettings;
    try {
      settings = ReadBuildSettings.read(
        context.root,
        root,
        context.lock.kind,
        PnpmWorkspace.settings(context.pnpmWorkspace),
        context.lock.berryFormat,
      );
    } catch (error) {
      if (error instanceof InputUnreadableError) {
        return {
          findings: [
            {
              rule: 'install-script',
              verdict: 'broken',
              path: error.path,
              ...(error.line === undefined ? {} : { line: error.line }),
              subject: 'настройка скриптов',
              reason: error.message,
            },
          ],
          checked: 0,
        };
      }
      throw error;
    }
    const allow = context.config.installScripts?.allow;
    const findings: Finding[] = [...InstallScriptRule.settingsFindings(context, settings, root.path)];
    const unread =
      settings.unread.length > 0 ? `; не читаются этой версией: ${settings.unread.join('; ')}` : '';
    const unknown: string[] = [];
    const seen = new Set<string>();
    const workspace = InstallScriptRule.workspaceDirs(context, root.json);
    const berry = context.lock.kind === 'yarn-berry';
    for (const pkg of context.lock.packages) {
      const id = `${pkg.name}@${pkg.version}`;
      // Пакет самоустановки pnpm: решения проекта к нему не применяются (см. LockedPackage.packageManager).
      if (pkg.packageManager === true) {
        continue;
      }
      if (
        seen.has(id) ||
        (pkg.source.kind === 'link' &&
          !(context.lock.kind === 'npm' && InstallScriptRule.isLocalNonProject(pkg, workspace)))
      ) {
        continue;
      }
      seen.add(id);
      const exec = pkg.source.kind === 'unknown' && /^exec:/i.test(pkg.source.url ?? '');
      // yarn 2+: `prepack` git-зависимости yarn исполняет при любых enableScripts и
      // dependenciesMeta (замер 4.0.2–4.18.1); `exec:` — тоже, кроме yarn 4.14+ (там он
      // собирается, только если скрипты разрешены: enableScripts или built: true).
      const unconditional = berry && (pkg.source.kind === 'git' || (exec && settings.execGated !== true));
      // yarn 2+ при запрете остальных: пакет вне dependenciesMeta.built: true не собирается
      // (данные о его скрипте не нужны).
      if (
        berry &&
        settings.hasOnlyBuiltDependencies &&
        !unconditional &&
        !InstallScriptRule.listed(settings.allow, pkg)
      ) {
        continue;
      }
      const hasScript = InstallScriptRule.hasScript(context, pkg);
      if (hasScript === undefined) {
        unknown.push(id);
        continue;
      }
      if (!hasScript || settings.ignoreScripts || AllowEntries.isAllowed(allow, pkg.name)) {
        continue;
      }
      // Решение менеджера засчитывается там, где менеджер его исполняет: у yarn 2+
      // built: false не останавливает `exec:` (его останавливает только запрет скриптов).
      if (
        !unconditional &&
        (context.lock.kind === 'pnpm' || berry) &&
        (InstallScriptRule.listed(settings.allow, pkg) ||
          (!(berry && exec) && InstallScriptRule.listed(settings.deny, pkg)))
      ) {
        continue;
      }
      findings.push({
        rule: 'install-script',
        verdict: 'violation',
        path: context.lock.path,
        ...(pkg.line === undefined ? {} : { line: pkg.line }),
        subject: id,
        reason:
          context.lock.kind === 'pnpm'
            ? `install-скрипт без решения: allowBuilds (true — разрешить, false — запретить) или installScripts.allow с причиной${unread}`
            : berry && unconditional
              ? `${pkg.source.kind === 'git' ? 'prepack git-зависимости' : 'exec:-сборку'} yarn исполняет при любых enableScripts и dependenciesMeta — только installScripts.allow с причиной${unread}`
              : berry
                ? `install-скрипт без решения: dependenciesMeta["${pkg.name}"].built в package.json (true — разрешить, false — запретить) или installScripts.allow с причиной${unread}`
                : 'install-скрипт пакета вне installScripts.allow',
      });
    }
    if (unknown.length > 0 && !settings.ignoreScripts) {
      findings.push({
        rule: 'install-script',
        verdict: 'unverified',
        path: context.lock.path,
        subject: `${unknown.length} пакетов`,
        reason: `нет данных об install-скрипте (lock-файл их не хранит, нет метаданных реестра): ${InstallScriptRule.sample(unknown)}`,
      });
    }
    const names = new Set(context.lock.packages.map((pkg) => pkg.name));
    findings.push(
      ...AllowEntries.audit('install-script', 'installScripts', allow, context.configPath, (name) =>
        names.has(name),
      ),
    );
    return { findings, checked: seen.size };
  }

  private static settingsFindings(
    context: RuleContext,
    settings: BuildSettings,
    rootPath: string,
  ): Finding[] {
    const finding = (
      subject: string,
      reason: string,
      verdict: Finding['verdict'] = 'violation',
    ): Finding => ({
      rule: 'install-script',
      verdict,
      path: settings.sources[0] ?? rootPath,
      subject,
      reason,
    });
    if (settings.ignoreScripts) {
      return [];
    }
    if (settings.manager === 'yarn-berry' && settings.hasOnlyBuiltDependencies) {
      return [];
    }
    if (settings.manager !== 'pnpm') {
      const declared = context.config.installScripts?.othersBlockedBy;
      const rc =
        settings.manager === 'yarn'
          ? 'ignore-scripts true в .yarnrc'
          : settings.manager === 'yarn-berry'
            ? 'enableScripts: false в .yarnrc.yml'
            : 'ignore-scripts=true в .npmrc';
      const unread = settings.unread.length > 0 ? `; ${settings.unread.join('; ')}` : '';
      return declared !== undefined && AllowEntries.isAllowed({ declared }, 'declared')
        ? []
        : [
            finding(
              'installScripts.othersBlockedBy',
              `${settings.manager !== 'yarn-berry' ? settings.manager : settings.execGated === true ? 'yarn 4.14+ с enableScripts: true' : 'yarn 2+ (до 4.14 — yarn.lock формата 8 и младше — по умолчанию)'} выполняет install-скрипты всех зависимостей и не умеет разрешать их списком: запрет остальных не подтверждён (${rc} или installScripts.othersBlockedBy с причиной)${unread}`,
              'unverified',
            ),
          ];
    }
    if (settings.pnpmMajor === undefined) {
      return [
        {
          rule: 'install-script',
          verdict: 'violation',
          path: rootPath,
          subject: 'packageManager',
          reason:
            'версия pnpm не зафиксирована (packageManager или devEngines.packageManager): pnpm < 10 выполняет install-скрипты всех зависимостей',
        },
      ];
    }
    if (settings.allowAll) {
      return [finding('dangerouslyAllowAllBuilds', 'разрешены install-скрипты ВСЕХ зависимостей')];
    }
    if (settings.pnpmMajor < 10 && !settings.hasOnlyBuiltDependencies) {
      return [
        finding(
          'onlyBuiltDependencies',
          `pnpm ${settings.pnpmMajor} выполняет install-скрипты всех зависимостей, пока не задан onlyBuiltDependencies (поле pnpm в package.json)`,
        ),
      ];
    }
    return [];
  }

  /** Каталоги проектов workspace (их скрипты — код самого репозитория, а не зависимости). */
  private static workspaceDirs(
    context: RuleContext,
    rootJson: Readonly<Record<string, unknown>>,
  ): Set<string> {
    const patterns = WorkspaceDirs.patterns(
      context.lock.kind,
      rootJson,
      PnpmWorkspace.settings(context.pnpmWorkspace),
    );
    const dirs = new Set(context.manifests.map((manifest) => manifest.importer));
    return new Set(
      WorkspaceDirs.match(context.lock.kind, patterns, [...dirs]).concat(dirs.has('.') ? ['.'] : []),
    );
  }

  /**
   * Ссылка npm на каталог внутри репозитория, который не проект workspace (так
   * npm ставит `file:./dep`): npm выполняет его скрипты, включая `prepare`.
   * У pnpm и yarn `link:` скрипты цели не выполняются, а `file:`-каталог —
   * источник `directory`.
   */
  private static isLocalNonProject(pkg: LockedPackage, workspace: ReadonlySet<string>): boolean {
    const target = posix.normalize(pkg.source.url ?? '');
    return (
      target !== '..' &&
      !target.startsWith('../') &&
      !PackageOrigin.isAbsolute(pkg.source.url ?? '') &&
      !workspace.has(target)
    );
  }

  private static hasScript(context: RuleContext, pkg: LockedPackage): boolean | undefined {
    if (pkg.source.kind === 'git') {
      return true;
    }
    // yarn 2+ `exec:` собирает пакет, исполняя скрипт из репозитория, — при любых настройках скриптов.
    if (pkg.source.kind === 'unknown' && /^exec:/i.test(pkg.source.url ?? '')) {
      return true;
    }
    if ((pkg.source.kind === 'directory' || pkg.source.kind === 'link') && pkg.source.url !== undefined) {
      // Локальный каталог: его package.json — прямо в репозитории, по пути из lock-файла.
      return InstallScriptRule.directoryScript(join(context.root, pkg.source.url.replace(/^file:/i, '')));
    }
    if (pkg.installScript !== undefined) {
      return pkg.installScript;
    }
    const versions = context.metadata.get(pkg.name)?.versions;
    const entry =
      versions !== undefined && Object.hasOwn(versions, pkg.version) ? versions[pkg.version] : undefined;
    return typeof entry?.hasInstallScript === 'boolean' ? entry.hasInstallScript : undefined;
  }

  private static directoryScript(dir: string): boolean | undefined {
    try {
      const scripts =
        (
          JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')) as {
            scripts?: Record<string, unknown>;
          }
        ).scripts ?? {};
      return (
        SOURCE_BUILD_HOOKS.some(
          (hook) => Object.hasOwn(scripts, hook) && typeof scripts[hook] === 'string',
        ) || existsSync(join(dir, 'binding.gyp'))
      );
    } catch {
      return undefined;
    }
  }

  /** Запись решения: имя целиком или `имя@версия[ || версия]`. */
  private static listed(entries: ReadonlySet<string>, pkg: LockedPackage): boolean {
    if (entries.has(pkg.name)) {
      return true;
    }
    for (const entry of entries) {
      if (entry.startsWith(`${pkg.name}@`)) {
        const versions = entry.slice(pkg.name.length + 1).split(/\s*\|\|\s*/);
        if (versions.includes(pkg.version)) {
          return true;
        }
      }
    }
    return false;
  }

  private static sample(ids: readonly string[]): string {
    const shown = ids.slice(0, 10).join(', ');
    return ids.length > 10 ? `${shown} и ещё ${ids.length - 10}` : shown;
  }
}
