import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEPENDENCY_FIELDS } from '../constants/dependency-fields.constant';
import { MIN_REASON_LENGTH } from '../constants/min-reason-length.constant';
import { RANGE_KINDS } from '../constants/range-kinds.constant';
import { RULE } from '../constants/rule.constant';
import { InputUnreadableError } from '../input-unreadable.error';
import { ReasonLength } from '../rules/reason-length';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';
import { valueText } from '../value-text';

/**
 * Чтение и проверка `deps-guard.json`. Без файла — отказ: значения по
 * умолчанию судили бы чужой репозиторий чужими реестрами. Неизвестный ключ —
 * отказ: опечатка в имени раздела молча выключала бы правило.
 */
export class LoadConfig {
  public static readonly FILE = 'deps-guard.json';

  private static readonly SECTIONS: Readonly<Record<string, readonly string[]>> = {
    newDependencies: ['baseline', 'allow'],
    installScripts: ['allow', 'othersBlockedBy'],
    sources: ['registries', 'defaultRegistry', 'allow'],
    typosquatting: ['popularFile', 'allow'],
    freshness: ['minAgeDays', 'metadataFile', 'allow'],
    floatingRanges: ['forbid', 'fields', 'allow'],
  };

  public static fromRoot(root: string): DepsGuardConfig {
    let text: string;
    try {
      text = readFileSync(join(root, LoadConfig.FILE), 'utf8');
    } catch (error) {
      throw new InputUnreadableError(LoadConfig.FILE, `настройка не прочитана (${(error as Error).message})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new InputUnreadableError(LoadConfig.FILE, `не JSON: ${(error as Error).message}`);
    }
    return LoadConfig.validate(parsed);
  }

  /** Проверка формы настройки; ошибка — {@link InputUnreadableError}. */
  public static validate(value: unknown): DepsGuardConfig {
    const fail = (detail: string): never => {
      throw new InputUnreadableError(LoadConfig.FILE, detail);
    };
    const config = LoadConfig.object(value, 'корень', fail);
    LoadConfig.keys(
      config,
      'корень',
      ['lockfile', 'disabled', ...Object.keys(LoadConfig.SECTIONS), 'bannedPackages'],
      fail,
    );
    if (config.lockfile !== undefined) {
      LoadConfig.string(config.lockfile, 'lockfile', fail);
    }
    if (config.disabled !== undefined) {
      const disabled = LoadConfig.object(config.disabled, 'disabled', fail);
      // `input` — не правило, а чтение входов: «отключить» его нельзя, ключ молча ничего бы не делал.
      LoadConfig.keys(
        disabled,
        'disabled',
        Object.keys(RULE).filter((rule) => rule !== 'input'),
        fail,
      );
      for (const [rule, reason] of Object.entries(disabled)) {
        LoadConfig.string(reason, `disabled.${rule}`, fail);
      }
    }
    for (const [section, allowed] of Object.entries(LoadConfig.SECTIONS)) {
      if (config[section] === undefined) {
        continue;
      }
      const body = LoadConfig.object(config[section], section, fail);
      LoadConfig.keys(body, section, allowed, fail);
      if (body.allow !== undefined) {
        const allow = LoadConfig.object(body.allow, `${section}.allow`, fail);
        for (const [subject, reason] of Object.entries(allow)) {
          LoadConfig.string(reason, `${section}.allow["${subject}"]`, fail);
        }
      }
    }
    LoadConfig.validateSections(config, fail);
    LoadConfig.bannedPackages(config.bannedPackages, fail);
    return config as DepsGuardConfig;
  }

  /**
   * Имя пакета реестра: `x` или `@scope/x`, без версии и диапазона, не длиннее
   * 214 знаков, не с `.`/`_`; заглавные — только в имени без scope (так
   * записаны старые пакеты реестра).
   */
  private static readonly PACKAGE_NAME =
    /^(?:@[a-z0-9~-][a-z0-9._~-]*\/[a-z0-9~-][a-z0-9._~-]*|[A-Za-z0-9~-][A-Za-z0-9._~-]*)$/;

  /**
   * `bannedPackages`: массив `{ name, reason }`. Нет ключа или пусто — правило
   * ничего не запрещает. Запись без причины (короче {@link MIN_REASON_LENGTH}
   * видимых знаков), с неразобранным именем, с лишним ключом и повтор имени —
   * отказ: перечень, который читается не так, как написан, хуже отсутствия.
   */
  private static bannedPackages(value: unknown, fail: (detail: string) => never): void {
    if (value === undefined) {
      return;
    }
    if (!Array.isArray(value)) {
      fail('bannedPackages: ожидался массив записей { name, reason }');
    }
    const seen = new Set<string>();
    (value as unknown[]).forEach((item, index) => {
      const where = `bannedPackages[${index}]`;
      const entry = LoadConfig.object(item, where, fail);
      LoadConfig.keys(entry, where, ['name', 'reason'], fail);
      const name = entry.name;
      if (typeof name !== 'string' || name.length > 214 || !LoadConfig.PACKAGE_NAME.test(name)) {
        fail(
          `${where}.name: ожидалось имя пакета реестра (x или @scope/x, без версии), получено «${valueText(name)}»`,
        );
      }
      if (!ReasonLength.isEnough(entry.reason)) {
        fail(`${where}.reason: причина запрета обязательна, не короче ${MIN_REASON_LENGTH} видимых знаков`);
      }
      if (seen.has(name as string)) {
        fail(`${where}.name: «${String(name)}» уже в перечне`);
      }
      seen.add(name as string);
    });
  }

  private static validateSections(config: Record<string, unknown>, fail: (detail: string) => never): void {
    const baseline = (config.newDependencies as Record<string, unknown> | undefined)?.baseline;
    if (baseline !== undefined) {
      const body = LoadConfig.object(baseline, 'newDependencies.baseline', fail);
      const keys = Object.keys(body);
      if (keys.length !== 1 || (keys[0] !== 'gitRef' && keys[0] !== 'file')) {
        fail('newDependencies.baseline: ровно один ключ — gitRef или file');
      }
      LoadConfig.string(body[keys[0] as string], `newDependencies.baseline.${keys[0]}`, fail);
    }
    const installScripts = config.installScripts as Record<string, unknown> | undefined;
    if (installScripts?.othersBlockedBy !== undefined) {
      LoadConfig.string(installScripts.othersBlockedBy, 'installScripts.othersBlockedBy', fail);
    }
    const sources = config.sources as Record<string, unknown> | undefined;
    if (sources?.registries !== undefined) {
      if (!Array.isArray(sources.registries)) {
        fail('sources.registries: ожидался массив адресов');
      }
      (sources.registries as unknown[]).forEach((url, index) => {
        LoadConfig.url(url, `sources.registries[${index}]`, fail);
      });
    }
    if (sources?.defaultRegistry !== undefined) {
      LoadConfig.url(sources.defaultRegistry, 'sources.defaultRegistry', fail);
    }
    const typosquatting = config.typosquatting as Record<string, unknown> | undefined;
    if (typosquatting?.popularFile !== undefined) {
      LoadConfig.string(typosquatting.popularFile, 'typosquatting.popularFile', fail);
    }
    const freshness = config.freshness as Record<string, unknown> | undefined;
    if (freshness?.minAgeDays !== undefined) {
      const days = freshness.minAgeDays;
      if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
        fail('freshness.minAgeDays: ожидалось неотрицательное число дней');
      }
    }
    if (freshness?.metadataFile !== undefined) {
      LoadConfig.string(freshness.metadataFile, 'freshness.metadataFile', fail);
    }
    const ranges = config.floatingRanges as Record<string, unknown> | undefined;
    LoadConfig.enumArray(ranges?.forbid, 'floatingRanges.forbid', RANGE_KINDS, fail);
    LoadConfig.enumArray(ranges?.fields, 'floatingRanges.fields', DEPENDENCY_FIELDS, fail);
  }

  private static object(
    value: unknown,
    where: string,
    fail: (detail: string) => never,
  ): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail(`${where}: ожидался объект`);
    }
    return value as Record<string, unknown>;
  }

  private static keys(
    body: Record<string, unknown>,
    where: string,
    allowed: readonly string[],
    fail: (detail: string) => never,
  ): void {
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
      fail(
        `${where}: неизвестный ключ ${unknown.map((key) => `«${key}»`).join(', ')} (допустимы: ${allowed.join(', ')})`,
      );
    }
  }

  private static string(value: unknown, where: string, fail: (detail: string) => never): void {
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`${where}: ожидалась непустая строка`);
    }
  }

  private static url(value: unknown, where: string, fail: (detail: string) => never): void {
    LoadConfig.string(value, where, fail);
    if (!URL.canParse(value as string) || !/^https?:$/.test(new URL(value as string).protocol)) {
      fail(`${where}: ожидался адрес http(s), получено «${String(value)}»`);
    }
  }

  private static enumArray(
    value: unknown,
    where: string,
    allowed: readonly string[],
    fail: (detail: string) => never,
  ): void {
    if (value === undefined) {
      return;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !allowed.includes(item))) {
      fail(`${where}: ожидался массив из ${allowed.join(', ')}`);
    }
  }
}
