import { SimilarName } from '../names/similar-name';
import { DirectDependencies } from '../project/direct-dependencies';
import type { Finding } from '../types/finding.type';
import type { RuleContext } from '../types/rule-context.type';
import type { RuleOutcome } from '../types/rule-outcome.type';
import { AllowEntries } from './allow-entries';

/**
 * Правило 4. Имя каждого пакета дерева и каждой прямой зависимости (у
 * `npm:`-алиаса — цели) не похоже на популярный пакет ({@link SimilarName}).
 * Законный пакет с похожим именем — запись в `typosquatting.allow` с причиной.
 */
export class TyposquattingRule {
  public static readonly id = 'typosquatting' as const;

  public static run(context: RuleContext): RuleOutcome {
    const allow = context.config.typosquatting?.allow;
    let popular: readonly string[];
    try {
      popular = context.popular();
    } catch (error) {
      return {
        findings: [
          {
            rule: 'typosquatting',
            verdict: 'broken',
            path: context.config.typosquatting?.popularFile ?? context.configPath,
            subject: 'список популярных пакетов',
            reason: (error as Error).message,
          },
        ],
        checked: 0,
      };
    }
    const similar = new SimilarName(popular);
    const where = new Map<string, { path: string; line?: number }>();
    for (const manifest of context.manifests) {
      for (const dep of DirectDependencies.of(manifest)) {
        // Судится настоящий пакет: у `npm:`-алиаса — цель, а не ключ.
        if (!where.has(dep.target)) {
          where.set(dep.target, {
            path: manifest.path,
            ...(dep.line === undefined ? {} : { line: dep.line }),
          });
        }
      }
    }
    for (const pkg of context.lock.packages) {
      if (!where.has(pkg.name)) {
        where.set(pkg.name, {
          path: context.lock.path,
          ...(pkg.line === undefined ? {} : { line: pkg.line }),
        });
      }
    }
    const findings: Finding[] = [];
    const flagged = new Set<string>();
    for (const [name, place] of where) {
      const reasons = similar.reasons(name);
      if (reasons.length === 0) {
        continue;
      }
      flagged.add(name);
      if (!AllowEntries.isAllowed(allow, name)) {
        findings.push({
          rule: 'typosquatting',
          verdict: 'violation',
          ...place,
          subject: name,
          reason: `имя похоже на популярный пакет: ${reasons.join('; ')}`,
        });
      }
    }
    findings.push(
      ...AllowEntries.audit('typosquatting', 'typosquatting', allow, context.configPath, (name) =>
        flagged.has(name),
      ),
    );
    return { findings, checked: where.size };
  }
}
