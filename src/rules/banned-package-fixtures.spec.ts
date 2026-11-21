import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RunCheck } from '../check/run-check';
import { TempDir } from '../testing/temp-dir';

/**
 * Правило на настоящих lock-файлах: npm 12.2.2, pnpm 12.21.0, yarn 1.22.22 и
 * yarn 4.18.1 поставили одни и те же проекты из поддельного реестра
 * (`scripts/record-banned-package-fixtures.cjs`). Запрещённый пакет `old-orm`;
 * `allowed` — дерево, где он только объявлен необязательным peer (`maybe-orm`)
 * и не установлен.
 */
const REASON = 'заменён другой библиотекой, возврат запрещён решением проекта';
const MANAGERS = ['npm', 'pnpm', 'yarn1', 'berry'] as const;
const LOCKS = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn1: 'yarn.lock', berry: 'yarn.lock' };

/** Ожидаемые цепочки по случаю; `null` — менеджер пакет не ставит (yarn не ставит peer сам). */
const CASES: Record<string, { chain: string | null; yarnChain?: string | null }> = {
  allowed: { chain: null },
  direct: { chain: 'package.json dependencies.old-orm: old-orm@1.0.0' },
  transitive: { chain: 'package.json devDependencies.kit: kit@1.0.0 → orm-adapter@1.0.0 → old-orm@1.0.0' },
  peer: { chain: 'package.json dependencies.needs-orm: needs-orm@1.0.0 → old-orm@1.0.0', yarnChain: null },
  optional: { chain: 'package.json dependencies.opt-kit: opt-kit@1.0.0 → old-orm@1.0.0' },
  'alias-direct': { chain: 'package.json dependencies.db: old-orm@1.0.0' },
  'alias-transitive': { chain: 'package.json dependencies.alias-kit: alias-kit@1.0.0 → old-orm@1.0.0' },
  workspace: {
    chain: 'packages/app/package.json dependencies.kit: kit@1.0.0 → orm-adapter@1.0.0 → old-orm@1.0.0',
  },
};

const check = (manager: (typeof MANAGERS)[number], name: string) =>
  RunCheck.run({
    root: join(TempDir.FIXTURES, 'banned-package', manager, name),
    config: { bannedPackages: [{ name: 'old-orm', reason: REASON }] },
    now: new Date('2026-11-17T00:00:00Z'),
    env: {},
  });

describe('banned-package на lock-файлах настоящих менеджеров', () => {
  const table = MANAGERS.flatMap((manager) =>
    Object.entries(CASES).map(([name, expected]) => {
      const yarn = manager === 'yarn1' || manager === 'berry';
      const chain = yarn && expected.yarnChain !== undefined ? expected.yarnChain : expected.chain;
      return [manager, name, chain] as const;
    }),
  );

  it.each(table)('%s/%s', (manager, name, chain) => {
    const report = check(manager, name);
    expect(report.lockfile).toBe(LOCKS[manager]);
    const summary = report.rules.find((rule) => rule.rule === 'banned-package');
    const own = report.findings.filter((finding) => finding.rule === 'banned-package');
    expect(own.map((finding) => [finding.verdict, finding.path, finding.subject, finding.reason])).toEqual(
      chain === null
        ? []
        : [
            [
              'violation',
              LOCKS[manager],
              'old-orm@1.0.0',
              `запрещённый пакет в дереве (${REASON}); цепочки: ${chain}`,
            ],
          ],
    );
    expect(summary?.status).toBe(chain === null ? 'passed' : 'failed');
    // Выборка не выродилась: правило рассмотрело пакеты дерева, а не пустой список.
    expect(summary?.checked).toBeGreaterThan(0);
  });

  it.each(['npm', 'pnpm', 'berry'] as const)(
    '%s/allowed: запрещённый пакет в lock-файле упомянут peer-объявлением (иначе случай ничего не доказывает)',
    (manager) => {
      const text = readFileSync(
        join(TempDir.FIXTURES, 'banned-package', manager, 'allowed', LOCKS[manager]),
        'utf8',
      );
      expect(text).toMatch(/peerDependencies"?:\s*\{?\s*"?old-orm"?: "?\^1\.0\.0/);
      expect(check(manager, 'allowed').findings.filter((finding) => finding.rule === 'input')).toEqual([]);
    },
  );
});
