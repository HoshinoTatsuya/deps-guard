import { DEPENDENCY_FIELDS } from '../constants/dependency-fields.constant';
import { RANGE_KINDS } from '../constants/range-kinds.constant';
import { DirectDependencies } from '../project/direct-dependencies';
import { PnpmCatalog } from '../project/pnpm-catalog';
import { PnpmWorkspace } from '../project/pnpm-workspace';
import { SpecifierKind } from '../project/specifier-kind';
import type { Finding } from '../types/finding.type';
import type { RuleContext } from '../types/rule-context.type';
import type { RuleOutcome } from '../types/rule-outcome.type';
import { AllowEntries } from './allow-entries';

/**
 * Правило 6. Прямые зависимости проверяемых полей (`floatingRanges.fields`,
 * по умолчанию все три) — без запрещённых видов диапазона
 * (`floatingRanges.forbid`, по умолчанию все: `^`, `~`, `1.x`, `*`, `latest`,
 * `>=`). Неразобранный спецификатор — нарушение всегда. Библиотеке обычно
 * нужны диапазоны в `dependencies` — тогда `fields: ["devDependencies"]`.
 *
 * `catalog:` судится по диапазону из каталога (`catalog`, `catalogs.<имя>`):
 * pnpm — pnpm-workspace.yaml, yarn 4.10+ — `.yarnrc.yml`; записи в каталоге
 * нет — спецификатор не разобран.
 */
export class FloatingRangeRule {
  public static readonly id = 'floating-range' as const;

  public static run(context: RuleContext): RuleOutcome {
    const section = context.config.floatingRanges;
    const forbid = new Set<string>(section?.forbid ?? RANGE_KINDS);
    const fields = section?.fields ?? DEPENDENCY_FIELDS;
    const findings: Finding[] = [];
    const floating = new Set<string>();
    const catalogs = context.catalogs ?? {
      settings: PnpmWorkspace.settings(context.pnpmWorkspace),
      file: PnpmWorkspace.FILE,
    };
    let checked = 0;
    for (const manifest of context.manifests) {
      for (const dep of DirectDependencies.of(manifest, fields)) {
        checked += 1;
        const catalog = PnpmCatalog.lookup(catalogs.settings, dep.name, dep.specifier, catalogs.file);
        const range = catalog?.range ?? dep.specifier;
        const kind =
          catalog !== undefined && catalog.range === undefined ? 'unknown' : SpecifierKind.of(range);
        if (kind !== 'unknown' && !forbid.has(kind)) {
          continue;
        }
        floating.add(dep.name);
        if (kind === 'unknown' || !AllowEntries.isAllowed(section?.allow, dep.name)) {
          const shown =
            catalog === undefined ? `«${dep.specifier}»` : `«${dep.specifier}» → ${catalog.label}`;
          findings.push({
            rule: 'floating-range',
            verdict: 'violation',
            path: manifest.path,
            ...(dep.line === undefined ? {} : { line: dep.line }),
            subject: dep.name,
            reason:
              kind === 'unknown'
                ? `спецификатор ${shown} не разобран (${dep.field})`
                : `плавающий диапазон ${shown} (${kind}, ${dep.field}): закрепите точную версию`,
          });
        }
      }
    }
    findings.push(
      ...AllowEntries.audit('floating-range', 'floatingRanges', section?.allow, context.configPath, (name) =>
        floating.has(name),
      ),
    );
    return { findings, checked };
  }
}
