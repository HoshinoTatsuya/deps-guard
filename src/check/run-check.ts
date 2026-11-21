import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { LoadConfig } from '../config/load-config';
import { MIN_REASON_LENGTH } from '../constants/min-reason-length.constant';
import { RULE } from '../constants/rule.constant';
import { InputUnreadableError } from '../input-unreadable.error';
import { ReadLockfile } from '../lockfile/read-lockfile';
import { MetadataCache } from '../metadata/metadata-cache';
import { PopularPackages } from '../names/popular-packages';
import { CatalogSettings } from '../project/catalog-settings';
import { GitShow } from '../project/git-show';
import { ManifestLinks } from '../project/manifest-links';
import { PnpmWorkspace } from '../project/pnpm-workspace';
import { ReadManifests } from '../project/read-manifests';
import { YarnrcYml } from '../project/yarnrc-yml';
import { ALL_RULES } from '../rules/all-rules.constant';
import { ReasonLength } from '../rules/reason-length';
import type { CheckOptions } from '../types/check-options.type';
import type { CheckReport } from '../types/check-report.type';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';
import type { Finding } from '../types/finding.type';
import type { Lockfile } from '../types/lockfile.type';
import type { Manifest } from '../types/manifest.type';
import type { PackageMetadata } from '../types/package-metadata.type';
import type { RuleId } from '../types/rule-id.type';
import type { RuleStatus } from '../types/rule-status.type';
import type { RuleSummary } from '../types/rule-summary.type';
import type { VersionCatalogs } from '../types/version-catalogs.type';
import type { YamlDocument } from '../types/yaml-document.type';

/**
 * Проверка проекта всеми правилами. Непрочитанный вход (настройка, lock-файл,
 * package.json) — отчёт с вердиктом `broken` у входа и у каждого правила:
 * ни одно правило не считается пройденным на непрочитанных данных. Исключение
 * внутри правила — `broken` этого правила, а не падение всего гейта и не пропуск.
 */
export class RunCheck {
  public static readonly TOOL = 'deps-guard';

  /**
   * `.yarnrc.yml` для каталогов версий; непрочитанный файл называют правила,
   * которые читают его настройки (скрипты, реестр), — здесь он не вход гейта.
   */
  private static yarnrcOrNothing(root: string): YamlDocument | undefined {
    try {
      return YarnrcYml.read(root);
    } catch (error) {
      if (error instanceof InputUnreadableError) {
        return undefined;
      }
      throw error;
    }
  }

  public static run(options: CheckOptions): CheckReport {
    const root = resolve(options.root);
    let config: DepsGuardConfig;
    let lock: Lockfile;
    let manifests: Manifest[];
    let pnpmWorkspace: YamlDocument | undefined;
    let catalogs: VersionCatalogs;
    try {
      config = options.config ? LoadConfig.validate(options.config) : LoadConfig.fromRoot(root);
      lock = ReadLockfile.read(root, config.lockfile);
      pnpmWorkspace = lock.kind === 'pnpm' ? PnpmWorkspace.read(root) : undefined;
      manifests = ReadManifests.read(root, lock, PnpmWorkspace.settings(pnpmWorkspace));
      catalogs = CatalogSettings.of(
        lock.kind,
        pnpmWorkspace,
        lock.kind === 'yarn-berry' ? RunCheck.yarnrcOrNothing(root) : undefined,
      );
    } catch (error) {
      if (error instanceof InputUnreadableError) {
        return RunCheck.unreadable(root, error);
      }
      throw error;
    }
    if (lock.linksOmitted) {
      lock = { ...lock, packages: [...lock.packages, ...ManifestLinks.missing(manifests, lock)] };
    }
    const pending: Finding[] = [];
    const findings: Finding[] = [];
    const metadata = new Map<string, PackageMetadata>();
    const metadataFile = config.freshness?.metadataFile;
    if (metadataFile !== undefined) {
      try {
        for (const [name, entry] of MetadataCache.read(root, metadataFile)) {
          metadata.set(name, entry);
        }
      } catch (error) {
        pending.push(RunCheck.broken('freshness', metadataFile, (error as Error).message));
      }
    }
    if (options.metadata) {
      // Как и битый кэш: непрочитанный вход — `broken` свежести, а не исключение (контракт check).
      try {
        for (const [name, entry] of MetadataCache.fromObject({ ...options.metadata }, 'параметр metadata')) {
          metadata.set(name, entry);
        }
      } catch (error) {
        pending.push(RunCheck.broken('freshness', 'параметр metadata', (error as Error).message));
      }
    }
    let popular: readonly string[] | undefined;
    const context = {
      root,
      config,
      configPath: options.config ? '<параметр config>' : LoadConfig.FILE,
      lock,
      manifests,
      ...(pnpmWorkspace === undefined ? {} : { pnpmWorkspace }),
      catalogs,
      metadata,
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      now: options.now ?? new Date(),
      popular: () => {
        const file = config.typosquatting?.popularFile;
        popular ??= PopularPackages.load(file === undefined ? PopularPackages.BUILTIN : join(root, file));
        return popular;
      },
      gitShow: GitShow.reader(root),
      gitList: GitShow.lister(root),
    };
    const summaries: RuleSummary[] = [
      {
        rule: 'input',
        title: RULE.input.title,
        status: 'passed',
        checked: lock.packages.length + manifests.length,
      },
    ];
    for (const rule of ALL_RULES) {
      const disabled = config.disabled?.[rule.id];
      if (ReasonLength.isEnough(disabled)) {
        summaries.push({
          rule: rule.id,
          title: RULE[rule.id].title,
          status: 'disabled',
          checked: 0,
          disabledReason: disabled,
        });
        continue;
      }
      const own: Finding[] =
        disabled === undefined
          ? []
          : [
              {
                rule: rule.id,
                verdict: 'violation',
                path: context.configPath,
                subject: `disabled.${rule.id}`,
                reason: `причина отключения короче ${MIN_REASON_LENGTH} знаков: правило не отключено`,
              },
            ];
      let checked = 0;
      try {
        const outcome = rule.run(context);
        own.push(...outcome.findings);
        checked = outcome.checked;
      } catch (error) {
        own.push(
          error instanceof InputUnreadableError
            ? {
                rule: rule.id,
                verdict: 'broken',
                path: error.path,
                ...(error.line === undefined ? {} : { line: error.line }),
                subject: 'вход правила',
                reason: error.message,
              }
            : RunCheck.broken(rule.id, lock.path, `правило не выполнено: ${(error as Error).message}`),
        );
      }
      own.push(...pending.filter((finding) => finding.rule === rule.id));
      summaries.push({ rule: rule.id, title: RULE[rule.id].title, status: RunCheck.status(own), checked });
      findings.push(...own);
    }
    const warnings = RunCheck.envWarnings(lock, options.env ?? process.env);
    return {
      tool: RunCheck.tool(),
      root,
      lockfile: lock.path,
      now: context.now.toISOString(),
      ...(warnings.length === 0 ? {} : { warnings }),
      rules: summaries,
      findings,
    };
  }

  /**
   * Переменные `YARN_*` окружения гейта: yarn (1 и 2+) берёт их поверх файлов
   * настроек проекта (реестр, скрипты, checksum), а гейт их не судит. Имена —
   * в предупреждение, значения не читаются (там бывают токены).
   */
  public static envWarnings(lock: Lockfile, env: Readonly<Record<string, string | undefined>>): string[] {
    if (lock.kind !== 'yarn' && lock.kind !== 'yarn-berry') {
      return [];
    }
    const names = Object.keys(env)
      .filter((name) => /^yarn_/i.test(name) && env[name] !== undefined)
      .sort();
    return names.length === 0
      ? []
      : [
          `в окружении гейта заданы ${names.join(', ')}: yarn берёт их поверх настроек проекта, а гейт их не судит — проверьте окружение CI, где ставятся зависимости`,
        ];
  }

  public static status(findings: readonly Finding[]): RuleStatus {
    if (findings.some((finding) => finding.verdict === 'violation' || finding.verdict === 'stale')) {
      return 'failed';
    }
    if (findings.some((finding) => finding.verdict === 'broken')) {
      return 'broken';
    }
    return findings.some((finding) => finding.verdict === 'unverified') ? 'unverified' : 'passed';
  }

  private static unreadable(root: string, error: InputUnreadableError): CheckReport {
    const finding: Finding = {
      rule: 'input',
      verdict: 'broken',
      path: error.path,
      ...(error.line === undefined ? {} : { line: error.line }),
      subject: 'вход гейта',
      reason: error.message,
    };
    const rules: RuleSummary[] = (Object.keys(RULE) as RuleId[]).map((rule) => ({
      rule,
      title: RULE[rule].title,
      status: 'broken',
      checked: 0,
    }));
    return { tool: RunCheck.tool(), root, rules, findings: [finding] };
  }

  private static broken(rule: RuleId, path: string, reason: string): Finding {
    return { rule, verdict: 'broken', path, subject: rule, reason };
  }

  private static tool(): { name: string; version: string } {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    return { name: RunCheck.TOOL, version: manifest.version };
  }
}
