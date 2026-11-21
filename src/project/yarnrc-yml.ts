import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import type { YamlDocument } from '../types/yaml-document.type';
import type { YamlObject } from '../types/yaml-object.type';
import { YamlSubset } from '../yaml/yaml-subset';
import { YamlSubsetError } from '../yaml/yaml-subset.error';

/**
 * `.yarnrc.yml` проекта yarn 2+. yarn читает его js-yaml со схемой FAILSAFE
 * (каждый скаляр — строка) и приводит значение к типу настройки сам: булево —
 * `true`/`1` и `false`/`0`, иное — ошибка yarn. Разборщик гейта строже
 * ({@link YamlSubset}): всё, что разборщики читают по-разному, — отказ.
 * Значение `${ПЕРЕМЕННАЯ}` yarn берёт из окружения — гейт его не видит.
 */
export class YarnrcYml {
  public static readonly FILE = '.yarnrc.yml';

  public static read(root: string): YamlDocument | undefined {
    const path = join(root, YarnrcYml.FILE);
    return existsSync(path) ? YarnrcYml.parse(readFileSync(path, 'utf8')) : undefined;
  }

  public static parse(text: string, label: string = YarnrcYml.FILE): YamlDocument {
    let document: YamlDocument;
    try {
      document = YamlSubset.parseFailsafe(text);
    } catch (error) {
      if (error instanceof YamlSubsetError) {
        throw new InputUnreadableError(label, error.detail, error.line);
      }
      throw error;
    }
    const value = document.value;
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      throw new InputUnreadableError(label, 'ожидалось отображение');
    }
    return document;
  }

  public static settings(document: YamlDocument | undefined): YamlObject {
    const value = document?.value;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : Object.create(null);
  }

  /**
   * Булева настройка верхнего уровня так, как её приводит yarn: `true`/`1` —
   * true, `false`/`0` — false; нет ключа — `undefined`; `${…}` — `'env'`;
   * иное (в том числе пустое значение) — отказ со строкой.
   */
  public static flag(document: YamlDocument | undefined, key: string): boolean | 'env' | undefined {
    const settings = YarnrcYml.settings(document);
    if (!Object.hasOwn(settings, key)) {
      return undefined;
    }
    const value = settings[key];
    if (value === true || value === 'true' || value === '1') {
      return true;
    }
    if (value === false || value === 'false' || value === '0') {
      return false;
    }
    if (typeof value === 'string' && value.includes('${')) {
      return 'env';
    }
    throw new InputUnreadableError(
      YarnrcYml.FILE,
      `${key}: ожидалось true или false (yarn принимает true/1 и false/0)`,
      document?.lineOf(settings, key),
    );
  }
}
