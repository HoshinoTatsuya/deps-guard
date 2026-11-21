import { DependencyChains } from '../graph/dependency-chains';
import type { DependencyChain } from '../types/dependency-chain.type';
import type { Finding } from '../types/finding.type';
import type { LockedPackage } from '../types/locked-package.type';
import type { RuleContext } from '../types/rule-context.type';
import type { RuleOutcome } from '../types/rule-outcome.type';

/**
 * Правило 8. В установленном дереве (по lock-файлу) нет пакетов из перечня
 * `bannedPackages`: ни прямых, ни транзитивных, ни peer, поставленных
 * менеджером сам (pnpm, npm 7+), ни optional, ни под алиасом — судится
 * настоящее имя пакета (`db: npm:x@…` — пакет `x`). Peer, который объявлен и не
 * установлен, в дереве не стоит и нарушением не является. Находка называет
 * цепочки от прямых зависимостей проектов до пакета: что именно убрать.
 *
 * Пустой перечень — правило ничего не запрещает: это решение проекта, а не
 * контроль доступа. Битая запись перечня — отказ настройки (`LoadConfig`).
 */
export class BannedPackageRule {
  public static readonly id = 'banned-package' as const;

  /** Сколько цепочек называть в находке; остальные — числом. */
  public static readonly CHAINS_SHOWN = 5;

  public static run(context: RuleContext): RuleOutcome {
    const banned = new Map((context.config.bannedPackages ?? []).map((entry) => [entry.name, entry.reason]));
    if (banned.size === 0) {
      return { findings: [], checked: 0 };
    }
    const byKey = new Map(context.lock.packages.map((pkg) => [pkg.key, pkg]));
    let chains: DependencyChains | undefined;
    const findings: Finding[] = [];
    for (const pkg of context.lock.packages) {
      const reason = banned.get(pkg.name);
      if (reason === undefined) {
        continue;
      }
      chains ??= DependencyChains.of(context.lock, context.manifests);
      findings.push({
        rule: 'banned-package',
        verdict: 'violation',
        path: context.lock.path,
        ...(pkg.line === undefined ? {} : { line: pkg.line }),
        subject: `${pkg.name}@${pkg.version}`,
        reason: `запрещённый пакет в дереве (${reason}); ${BannedPackageRule.describe(
          chains.chainsTo(pkg.key),
          byKey,
        )}`,
      });
    }
    return { findings, checked: context.lock.packages.length };
  }

  private static describe(
    chains: readonly DependencyChain[],
    byKey: ReadonlyMap<string, LockedPackage>,
  ): string {
    if (chains.length === 0) {
      return 'ни одна прямая зависимость к нему по записям lock-файла не ведёт — запись без владельца, пакет всё равно ставится';
    }
    const shown = chains.slice(0, BannedPackageRule.CHAINS_SHOWN).map((chain) => {
      const where = chain.root.importer === '.' ? 'package.json' : `${chain.root.importer}/package.json`;
      const steps = chain.keys.map((key) => {
        const pkg = byKey.get(key);
        return pkg === undefined ? key : `${pkg.name}@${pkg.version}`;
      });
      return `${where} ${chain.root.field}.${chain.root.name}: ${steps.join(' → ')}`;
    });
    const rest = chains.length - shown.length;
    return `цепочки: ${shown.join('; ')}${rest > 0 ? `; и ещё ${rest}` : ''}`;
  }
}
