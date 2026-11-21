import type {
  CliIo,
  DanglingReference,
  LockedCatalogEntry,
  LockedConfigDependency,
  Lockfile,
  Verdict,
} from './index';

/** Типы элементов публичных полей экспортированы: потребитель может их назвать. */
describe('экспорт типов', () => {
  it('элементы Lockfile.dangling, configDependencies и catalogs, вердикт matured, CliIo.clock', () => {
    const dangling: DanglingReference = { importer: '.', name: 'a', version: '1.0.0' };
    const config: LockedConfigDependency = { specifier: '1.0.0' };
    const catalog: LockedCatalogEntry = { specifier: '^1.0.0' };
    const lock: Lockfile = {
      kind: 'pnpm',
      path: 'pnpm-lock.yaml',
      packages: [],
      dangling: [dangling],
      configDependencies: { x: config },
      catalogs: { default: { x: catalog } },
    };
    const verdict: Verdict = 'matured';
    const io: Pick<CliIo, 'clock'> = { clock: () => new Date(0) };
    expect([lock.dangling?.length, verdict, io.clock?.().getTime()]).toEqual([1, 'matured', 0]);
  });
});
