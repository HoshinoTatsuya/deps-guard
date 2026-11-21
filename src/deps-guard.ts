import { BaselineFile } from './baseline/baseline-file';
import { RunCheck } from './check/run-check';
import { ReadLockfile } from './lockfile/read-lockfile';
import { FetchMetadata } from './metadata/fetch-metadata';
import { CatalogSettings } from './project/catalog-settings';
import { ConfigDependencies } from './project/config-dependencies';
import { PnpmWorkspace } from './project/pnpm-workspace';
import { ReadManifests } from './project/read-manifests';
import { YarnToolchain } from './project/yarn-toolchain';
import { YarnrcYml } from './project/yarnrc-yml';
import { ExitCodeOf } from './report/exit-code-of';
import { RenderReport } from './report/render-report';
import type { CheckOptions } from './types/check-options.type';
import type { CheckReport } from './types/check-report.type';
import type { FetchMetadataOptions } from './types/fetch-metadata-options.type';
import type { Lockfile } from './types/lockfile.type';
import type { PackageMetadata } from './types/package-metadata.type';
import type { ReportFormat } from './types/report-format.type';

/** Программный интерфейс гейта: то же, что делает CLI. */
export class DepsGuard {
  /** Проверить проект всеми правилами. Не бросает на непрочитанном входе — это вердикт `broken`. */
  public static check(options: CheckOptions): CheckReport {
    return RunCheck.run(options);
  }

  /** Код выхода по отчёту: 0 — чисто, 1 — нарушения, 2 — не проверено. */
  public static exitCode(report: CheckReport): number {
    return ExitCodeOf.report(report);
  }

  public static render(format: ReportFormat, report: CheckReport): string {
    return RenderReport.render(format, report);
  }

  /** Разобранный lock-файл проекта (бросает InputUnreadableError). */
  public static readLockfile(root: string, path?: string): Lockfile {
    return ReadLockfile.read(root, path);
  }

  /** Текст файла базовой линии для текущих package.json проекта. */
  public static renderBaseline(root: string, lockfilePath?: string): string {
    const lock = ReadLockfile.read(root, lockfilePath);
    const workspace = lock.kind === 'pnpm' ? PnpmWorkspace.read(root) : undefined;
    return BaselineFile.render(
      ReadManifests.read(root, lock, PnpmWorkspace.settings(workspace)),
      [
        ...ConfigDependencies.of(workspace).map((config) => config.name),
        ...(lock.kind === 'yarn-berry' ? YarnToolchain.onDisk(root).map((entry) => entry.name) : []),
      ],
      CatalogSettings.of(lock.kind, workspace, lock.kind === 'yarn-berry' ? YarnrcYml.read(root) : undefined)
        .settings,
    );
  }

  /** Метаданные реестра для пакетов lock-файла (даты публикации, признак скрипта). */
  public static fetchMetadata(
    options: FetchMetadataOptions,
  ): Promise<{ metadata: Record<string, PackageMetadata>; errors: string[] }> {
    return FetchMetadata.run(options);
  }
}
