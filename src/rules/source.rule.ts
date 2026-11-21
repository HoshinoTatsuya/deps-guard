import { posix } from 'node:path';

import { PackageOrigin } from '../lockfile/package-origin';
import { ReadRegistrySettings } from '../project/read-registry-settings';
import { YarnrcYml } from '../project/yarnrc-yml';
import type { Finding } from '../types/finding.type';
import type { LockedPackage } from '../types/locked-package.type';
import type { RegistryDeclaration } from '../types/registry-declaration.type';
import type { RuleContext } from '../types/rule-context.type';
import type { RuleOutcome } from '../types/rule-outcome.type';
import { valueText } from '../value-text';
import { AllowEntries } from './allow-entries';

/**
 * Правило 3. Каждый пакет — из разрешённого реестра (`sources.registries`,
 * сравнение по схеме, хосту, порту и префиксу пути) и с integrity, в котором
 * есть хотя бы один корректный токен sha256/384/512 (base64 ровно длины
 * хэша: `sha512-` без хэша npm не сверяет вовсе). git-, file-, directory-,
 * http-вне-реестра и ссылки за пределы репозитория — нарушение без записи
 * в `sources.allow`; запись — `имя@источник` ({@link SourceRule.subjectOf}): допуск
 * по одному имени пропустил бы под тем же именем любой другой адрес. git — ещё
 * и только закреплённый коммитом. Допуск источника integrity не отменяет.
 * Пакет из `bundleDependencies` приезжает в архиве родителя и судится вместе
 * с ним.
 *
 * Пакет без адреса в lock-файле (pnpm v9 так пишет реестр по умолчанию)
 * ставится из реестра установки: `registry`/`@scope:registry` в `.npmrc`
 * (у yarn ещё `.yarnrc`) проекта, а если там не задан — из окружения CI,
 * которое гейт знает только из `sources.defaultRegistry`. Реестр `.npmrc` вне
 * `sources.registries` — нарушение; значение из переменной окружения и
 * отсутствие обоих — «не проверено».
 */
export class SourceRule {
  public static readonly id = 'source' as const;

  public static run(context: RuleContext): RuleOutcome {
    const section = context.config.sources;
    const registries = (section?.registries ?? []).map((url) => new URL(url));
    const findings: Finding[] = [];
    const implicit: string[] = [];
    const nonRegistry = new Set<string>();
    const violation = (pkg: LockedPackage, reason: string): void => {
      findings.push({
        rule: 'source',
        verdict: 'violation',
        path: context.lock.path,
        ...(pkg.line === undefined ? {} : { line: pkg.line }),
        subject: `${pkg.name}@${pkg.version}`,
        reason,
      });
    };
    const defaultRegistry = section?.defaultRegistry;
    if (defaultRegistry !== undefined && !SourceRule.inRegistries(defaultRegistry, registries)) {
      findings.push({
        rule: 'source',
        verdict: 'violation',
        path: context.configPath,
        subject: 'sources.defaultRegistry',
        reason: `реестр по умолчанию ${defaultRegistry} не входит в sources.registries`,
      });
    }
    const declared = ReadRegistrySettings.read(context.root, context.lock.kind);
    if (context.lock.kind === 'yarn-berry') {
      findings.push(...SourceRule.checksumBehavior(context.root));
    }
    findings.push(...SourceRule.declarationFindings(declared, registries));
    for (const pkg of context.lock.packages) {
      const { kind, url } = pkg.source;
      const subject = SourceRule.subjectOf(pkg);
      const allowed = AllowEntries.isAllowed(section?.allow, subject);
      if (kind === 'registry-default') {
        const scope = pkg.name.startsWith('@') ? pkg.name.slice(0, pkg.name.indexOf('/')) : undefined;
        const installedFrom =
          declared.find((entry) => entry.scope !== undefined && entry.scope === scope) ??
          declared.find((entry) => entry.scope === undefined);
        if (installedFrom === undefined && defaultRegistry === undefined) {
          implicit.push(`${pkg.name}@${pkg.version}`);
        }
      } else if (kind === 'tarball') {
        if (!SourceRule.inRegistries(url ?? '', registries)) {
          nonRegistry.add(subject);
          if (!allowed) {
            violation(
              pkg,
              `архив не из разрешённого реестра: ${SourceRule.display(url ?? '')}; допуск — sources.allow["${subject}"]`,
            );
          }
        }
      } else if (kind === 'link') {
        const target = posix.normalize(url ?? '');
        if (target === '..' || target.startsWith('../') || PackageOrigin.isAbsolute(url ?? '')) {
          nonRegistry.add(subject);
          if (!allowed) {
            violation(pkg, `ссылка за пределы репозитория: ${url}; допуск — sources.allow["${subject}"]`);
          }
        }
      } else if (kind !== 'bundled') {
        nonRegistry.add(subject);
        if (!allowed) {
          violation(
            pkg,
            `источник ${kind}${url ? ` (${SourceRule.display(url)})` : ''} — не реестр; нужна запись sources.allow["${subject}"] с причиной`,
          );
        } else if (kind === 'git' && !/^[0-9a-f]{40}$/.test(pkg.source.commit ?? '')) {
          violation(pkg, 'git-зависимость не закреплена коммитом (40 hex)');
        }
      }
      if (kind === 'registry-default' || kind === 'tarball' || kind === 'file') {
        const integrity =
          context.lock.kind === 'yarn-berry'
            ? SourceRule.checksumProblem(pkg.integrity, context.lock.cacheKey, pkg.conditions)
            : SourceRule.integrityProblem(pkg.integrity);
        if (integrity !== undefined) {
          violation(pkg, integrity);
        }
      }
    }
    if (implicit.length > 0) {
      findings.push({
        rule: 'source',
        verdict: 'unverified',
        path: context.lock.path,
        subject: `${implicit.length} пакетов`,
        reason: `пакеты без адреса в lock-файле ставятся из реестра установки, а он не задан ни в .npmrc проекта, ни в sources.defaultRegistry: ${implicit.slice(0, 5).join(', ')}${implicit.length > 5 ? ' …' : ''}`,
      });
    }
    findings.push(
      ...AllowEntries.audit('source', 'sources', section?.allow, context.configPath, (subject) =>
        nonRegistry.has(subject),
      ),
    );
    return { findings, checked: context.lock.packages.length };
  }

  /**
   * Предмет допуска источника: `имя@источник` — git без коммита (смена
   * коммита — тот же источник), архив по адресу, `file:` архива или каталога,
   * `link:` цели ссылки. Учётка из адреса в предмет не входит: предмет
   * печатается в отчёте и пишется в deps-guard.json.
   */
  public static subjectOf(pkg: LockedPackage): string {
    const { kind, url } = pkg.source;
    const where =
      kind === 'directory'
        ? `file:${(url ?? '').replace(/^file:/i, '')}`
        : kind === 'link'
          ? `link:${url ?? ''}`
          : SourceRule.withoutCredentials(url ?? kind);
    return `${pkg.name}@${where}`;
  }

  /**
   * Адрес под одним из реестров: та же схема, хост (точка в конце имени хоста
   * не в счёт) и порт, путь — с префиксом пути реестра, без учётки. Путь с
   * закодированным `/` или `\` (`..%2f`) — не под реестром: сервер или прокси
   * может раскодировать его в переход выше префикса.
   */
  public static inRegistries(url: string, registries: readonly URL[]): boolean {
    if (!URL.canParse(url)) {
      return false;
    }
    const target = new URL(url);
    if (/%2f|%5c|\\/i.test(target.pathname)) {
      return false;
    }
    return registries.some((registry) => {
      const prefix = registry.pathname.endsWith('/') ? registry.pathname : `${registry.pathname}/`;
      return (
        target.protocol === registry.protocol &&
        SourceRule.host(target) === SourceRule.host(registry) &&
        (target.pathname === registry.pathname || target.pathname.startsWith(prefix)) &&
        target.username === '' &&
        target.password === ''
      );
    });
  }

  private static host(url: URL): string {
    return `${url.hostname.replace(/\.$/, '')}:${url.port}`;
  }

  /** Реестры `.npmrc`/`.yarnrc` проекта: вне списка — нарушение; из переменной окружения — не проверено. */
  private static declarationFindings(
    declared: readonly RegistryDeclaration[],
    registries: readonly URL[],
  ): Finding[] {
    return declared.flatMap((entry): Finding[] => {
      const place = { rule: 'source' as const, path: entry.path, line: entry.line, subject: entry.key };
      if (entry.value.includes('${')) {
        return [
          {
            ...place,
            verdict: 'unverified',
            reason: `реестр установки берётся из переменной окружения (${entry.value}): гейт его не видит`,
          },
        ];
      }
      return SourceRule.inRegistries(entry.value, registries)
        ? []
        : [
            {
              ...place,
              verdict: 'violation',
              reason: `реестр установки ${SourceRule.display(entry.value)} не входит в sources.registries: пакеты без адреса в lock-файле ставятся из него`,
            },
          ];
    });
  }

  private static withoutCredentials(url: string): string {
    if (!URL.canParse(url)) {
      return url;
    }
    const parsed = new URL(url);
    // У ssh/git пользователь (`git@`) — часть адреса, а не учётка; учётка бывает у http(s).
    if (!/^https?:$/i.test(parsed.protocol) || (parsed.username === '' && parsed.password === '')) {
      return url;
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  }

  /** Адрес для сообщения — без учётки (в `.npmrc` она бывает прямо в адресе). */
  private static display(url: string): string {
    if (!URL.canParse(url)) {
      return url;
    }
    const parsed = new URL(url);
    if (parsed.username !== '' || parsed.password !== '') {
      parsed.username = '';
      parsed.password = '';
      return `${parsed.toString()} (учётка в адресе скрыта)`;
    }
    return url;
  }

  /**
   * integrity — список токенов SRI `алгоритм-base64[?опции]`. Засчитывается
   * токен sha256/384/512 с корректным base64 ровно длины хэша (32/48/64 байта):
   * токен без хэша или с обрезанным хэшем менеджер отбрасывает и ставит архив
   * без сверки.
   */
  private static integrityProblem(integrity: string | undefined): string | undefined {
    const tokens = (integrity ?? '')
      .trim()
      .split(/\s+/)
      .filter((token) => token !== '');
    if (tokens.length === 0) {
      return 'нет integrity: содержимое архива не сверяется с записанным хэшем';
    }
    if (tokens.some((token) => SourceRule.isStrongToken(token))) {
      return undefined;
    }
    const algorithms = tokens.map((token) => token.split('-')[0]);
    return algorithms.some((algorithm) => algorithm !== undefined && algorithm in SourceRule.DIGEST_BYTES)
      ? `integrity без корректного хэша sha256/384/512 («${tokens.join(' ').slice(0, 60)}»): менеджер такой токен отбрасывает и не сверяет архив`
      : `integrity только ${algorithms.join(', ')}: слабый хэш (нужен sha512)`;
  }

  /**
   * checksum yarn 2+: sha512 архива в кэше (128 hex), у yarn 4.1+ — с
   * префиксом `cacheKey/`. Префикс не текущего `__metadata.cacheKey` yarn не
   * сверяет вовсе (замер на yarn 4.0.2: подменённый хэш с префиксом `9/` —
   * установка прошла), поэтому такой checksum — нет checksum.
   */
  private static checksumProblem(
    checksum: string | undefined,
    cacheKey: string | undefined,
    conditions: string | undefined,
  ): string | undefined {
    if (checksum === undefined || checksum.trim() === '') {
      return conditions === undefined
        ? 'нет checksum: yarn не сверяет архив с записанным хэшем'
        : `нет checksum у пакета платформы (${conditions}): на подходящей платформе yarn ставит его без сверки — добавьте платформу в supportedArchitectures .yarnrc.yml и переустановите`;
    }
    const match = /^(?:([^/\s]+)\/)?([0-9a-f]{128})$/.exec(checksum.trim());
    if (match === null) {
      return `checksum «${checksum.slice(0, 40)}» — не sha512 (128 hex)`;
    }
    if (match[1] !== undefined && match[1] !== cacheKey) {
      return `checksum с префиксом «${match[1]}» при __metadata.cacheKey «${cacheKey ?? ''}»: yarn такой checksum не сверяет`;
    }
    return undefined;
  }

  /** `checksumBehavior` в .yarnrc.yml не `throw` — yarn ставит архив и при несовпадении хэша. */
  private static checksumBehavior(root: string): Finding[] {
    const document = YarnrcYml.read(root);
    const settings = YarnrcYml.settings(document);
    if (!Object.hasOwn(settings, 'checksumBehavior') || settings.checksumBehavior === 'throw') {
      return [];
    }
    const line = document?.lineOf(settings, 'checksumBehavior');
    return [
      {
        rule: 'source',
        verdict: 'violation',
        path: YarnrcYml.FILE,
        ...(line === undefined ? {} : { line }),
        subject: 'checksumBehavior',
        reason: `checksumBehavior: ${valueText(settings.checksumBehavior)} — yarn не останавливает установку при несовпадении checksum (нужно throw или без ключа)`,
      },
    ];
  }

  private static readonly DIGEST_BYTES: Readonly<Record<string, number>> = Object.freeze({
    sha256: 32,
    sha384: 48,
    sha512: 64,
  });

  private static isStrongToken(token: string): boolean {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?[\x21-\x7e]*)?$/.exec(token);
    if (match === null) {
      return false;
    }
    const digest = match[2] as string;
    return (
      digest.length % 4 === 0 &&
      Buffer.from(digest, 'base64').length === SourceRule.DIGEST_BYTES[match[1] as string]
    );
  }
}
