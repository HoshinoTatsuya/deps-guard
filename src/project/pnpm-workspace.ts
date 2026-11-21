import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import type { YamlDocument } from '../types/yaml-document.type';
import type { YamlObject } from '../types/yaml-object.type';
import { YamlSubset } from '../yaml/yaml-subset';
import { YamlSubsetError } from '../yaml/yaml-subset.error';

/**
 * `pnpm-workspace.yaml` корня: состав workspace (`packages`), решения о
 * install-скриптах, каталоги версий (`catalog`, `catalogs`), config-зависимости.
 * Нет файла — `undefined`; битый — {@link InputUnreadableError}: от него
 * зависит, какие проекты и решения проверяются.
 */
export class PnpmWorkspace {
  public static readonly FILE = 'pnpm-workspace.yaml';

  public static read(root: string): YamlDocument | undefined {
    const path = join(root, PnpmWorkspace.FILE);
    return existsSync(path) ? PnpmWorkspace.parse(readFileSync(path, 'utf8')) : undefined;
  }

  public static parse(text: string, label: string = PnpmWorkspace.FILE): YamlDocument {
    let document: YamlDocument;
    try {
      document = YamlSubset.parse(text);
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

  /** Отображение настроек документа (пустой файл — пусто). */
  public static settings(document: YamlDocument | undefined): YamlObject {
    const value = document?.value;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : Object.create(null);
  }
}
