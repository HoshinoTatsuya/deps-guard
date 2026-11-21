import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { BaselineFile } from '../baseline/baseline-file';
import { RunCheck } from '../check/run-check';
import { LoadConfig } from '../config/load-config';
import { EXIT_CODE } from '../constants/exit-code.constant';
import { InputUnreadableError } from '../input-unreadable.error';
import { ReadLockfile } from '../lockfile/read-lockfile';
import { FetchMetadata } from '../metadata/fetch-metadata';
import { CatalogSettings } from '../project/catalog-settings';
import { ConfigDependencies } from '../project/config-dependencies';
import { PnpmWorkspace } from '../project/pnpm-workspace';
import { ReadManifests } from '../project/read-manifests';
import { ReadRegistrySettings } from '../project/read-registry-settings';
import { YarnToolchain } from '../project/yarn-toolchain';
import { YarnrcYml } from '../project/yarnrc-yml';
import { ExitCodeOf } from '../report/exit-code-of';
import { RenderReport } from '../report/render-report';
import type { CliIo } from '../types/cli-io.type';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';
import type { ReportFormat } from '../types/report-format.type';
import { valueText } from '../value-text';

/**
 * `deps-guard check | baseline | metadata`. Коды выхода — {@link EXIT_CODE}:
 * 0 — чисто, 1 — нарушения, 2 — не проверено, вход не прочитан или вызов неверен.
 */
export class Cli {
  public static readonly USAGE = [
    'использование:',
    '  deps-guard check [--root DIR] [--base REF] [--format text|json|sarif|junit] [--out FILE] [--now ISO]',
    '  deps-guard baseline [--root DIR] [--out FILE]',
    '  deps-guard metadata [--root DIR] [--registry URL] [--out FILE] [--timeout-ms N]',
    '    (заголовок Authorization для закрытого реестра — переменная DEPS_GUARD_REGISTRY_AUTH)',
  ].join('\n');

  private static readonly FORMATS: readonly ReportFormat[] = ['text', 'json', 'sarif', 'junit'];

  public static async main(argv: readonly string[], io: CliIo): Promise<number> {
    const [command, ...rest] = argv;
    try {
      switch (command) {
        case 'check':
          return Cli.check(rest, io);
        case 'baseline':
          return Cli.baseline(rest, io);
        case 'metadata':
          return await Cli.metadata(rest, io);
        default:
          io.stderr(
            `${command === undefined ? 'не указана команда' : `неизвестная команда «${command}»`}\n${Cli.USAGE}\n`,
          );
          return EXIT_CODE.unverified;
      }
    } catch (error) {
      io.stderr(`deps-guard: ${error instanceof Error ? error.message : valueText(error)}\n`);
      return EXIT_CODE.unverified;
    }
  }

  private static check(argv: readonly string[], io: CliIo): number {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        root: { type: 'string' },
        base: { type: 'string' },
        format: { type: 'string', default: 'text' },
        out: { type: 'string' },
        now: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
    const format = values.format as ReportFormat;
    if (!Cli.FORMATS.includes(format)) {
      throw new Error(`формат «${values.format}» не поддерживается (${Cli.FORMATS.join(', ')})`);
    }
    if (values.now !== undefined) {
      Cli.checkNow(values.now, io.clock?.() ?? new Date());
    }
    const report = RunCheck.run({
      root: resolve(io.cwd, values.root ?? '.'),
      ...(values.base === undefined ? {} : { baseRef: values.base }),
      ...(values.now === undefined ? {} : { now: new Date(values.now) }),
      env: io.env,
    });
    if (values.out !== undefined) {
      writeFileSync(resolve(io.cwd, values.out), RenderReport.render(format, report));
      io.stdout(RenderReport.render('text', report));
    } else {
      io.stdout(RenderReport.render(format, report));
    }
    return ExitCodeOf.report(report);
  }

  private static baseline(argv: readonly string[], io: CliIo): number {
    const { values } = parseArgs({
      args: [...argv],
      options: { root: { type: 'string' }, out: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    const root = resolve(io.cwd, values.root ?? '.');
    const config = Cli.optionalConfig(root);
    const baseline = config?.newDependencies?.baseline;
    const out = values.out ?? (baseline && 'file' in baseline ? baseline.file : 'deps-guard.baseline.json');
    const lock = ReadLockfile.read(root, config?.lockfile);
    const workspace = lock.kind === 'pnpm' ? PnpmWorkspace.read(root) : undefined;
    BaselineFile.write(
      root,
      out,
      ReadManifests.read(root, lock, PnpmWorkspace.settings(workspace)),
      [
        ...ConfigDependencies.of(workspace).map((entry) => entry.name),
        ...(lock.kind === 'yarn-berry' ? YarnToolchain.onDisk(root).map((entry) => entry.name) : []),
      ],
      CatalogSettings.of(lock.kind, workspace, lock.kind === 'yarn-berry' ? YarnrcYml.read(root) : undefined)
        .settings,
    );
    io.stdout(`базовая линия записана: ${out}\n`);
    return EXIT_CODE.clean;
  }

  private static async metadata(argv: readonly string[], io: CliIo): Promise<number> {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        root: { type: 'string' },
        registry: { type: 'string' },
        out: { type: 'string' },
        'timeout-ms': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
    const root = resolve(io.cwd, values.root ?? '.');
    const config = Cli.optionalConfig(root);
    const lockKind = ReadLockfile.read(root, config?.lockfile).kind;
    const declared = ReadRegistrySettings.read(root, lockKind);
    // Пакеты ставятся из реестра .npmrc проекта, если он задан; реестры scope — оттуда же.
    const registry =
      values.registry ??
      declared.filter((entry) => entry.scope === undefined).at(-1)?.value ??
      config?.sources?.defaultRegistry;
    if (registry === undefined) {
      throw new Error('не задан реестр: --registry, registry в .npmrc проекта или sources.defaultRegistry');
    }
    const scopeRegistries = Object.fromEntries(
      declared.flatMap((entry) => (entry.scope === undefined ? [] : [[entry.scope, entry.value] as const])),
    );
    const timeoutMs = values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']);
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new Error(`--timeout-ms: ожидалось положительное целое, получено «${values['timeout-ms']}»`);
    }
    const out = values.out ?? config?.freshness?.metadataFile ?? 'deps-guard.metadata.json';
    const lock = ReadLockfile.read(root, config?.lockfile);
    const authorization = io.env.DEPS_GUARD_REGISTRY_AUTH;
    const { metadata, errors } = await FetchMetadata.run({
      registry,
      scopeRegistries,
      packages: lock.packages,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(authorization === undefined || authorization === '' ? {} : { authorization }),
    });
    // Относительный — от корня (кэш читает check), абсолютный — как есть.
    const path = resolve(root, out);
    const previous = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>)
      : {};
    const merged = { ...previous, ...metadata };
    const sorted = Object.fromEntries(
      Object.keys(merged)
        .sort()
        .map((name) => [name, merged[name]]),
    );
    writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
    io.stdout(`метаданные: ${Object.keys(metadata).length} пакетов записано в ${out}\n`);
    if (errors.length > 0) {
      io.stderr(`не получено ${errors.length}:\n${errors.map((line) => `  ${line}`).join('\n')}\n`);
      return EXIT_CODE.unverified;
    }
    return EXIT_CODE.clean;
  }

  /**
   * `--now` — дата ISO 8601 (`2026-11-16` или `2026-11-16T10:00:00Z`, с зоной):
   * нестрогий `Date.parse` прочёл бы `1` как 2001 год. Опорное время позже
   * настоящего больше чем на сутки — отказ: оно молча отключило бы свежесть.
   */
  private static checkNow(value: string, clock: Date): void {
    const iso = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
    const parsed = Date.parse(value);
    // `2026-02-30` Date.parse молча переносит на март: день обязан остаться тем же.
    const sameDay =
      !Number.isNaN(parsed) &&
      new Date(Date.parse(value.slice(0, 10))).toISOString().startsWith(value.slice(0, 10));
    if (!iso.test(value) || !sameDay) {
      throw new Error(`--now: «${value}» — не дата ISO 8601 (2026-11-16 или 2026-11-16T10:00:00Z)`);
    }
    if (parsed > clock.getTime() + 24 * 60 * 60 * 1000) {
      throw new Error(
        `--now: «${value}» в будущем: опорное время позже настоящего отключило бы проверку свежести`,
      );
    }
  }

  private static optionalConfig(root: string): DepsGuardConfig | undefined {
    if (!existsSync(join(root, LoadConfig.FILE))) {
      return undefined;
    }
    try {
      return LoadConfig.fromRoot(root);
    } catch (error) {
      if (error instanceof InputUnreadableError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }
}
