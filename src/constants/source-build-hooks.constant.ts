import { deepFreeze } from '../deep-freeze';
import { INSTALL_HOOKS } from './install-hooks.constant';

/**
 * Скрипты, которые менеджер выполняет у зависимости из git или локального
 * каталога: к install-скриптам добавляется `prepare` (пакет собирается из
 * исходников при установке). У пакета из реестра `prepare` не выполняется.
 */
export const SOURCE_BUILD_HOOKS = [...INSTALL_HOOKS, 'prepare'] as const;

deepFreeze(SOURCE_BUILD_HOOKS);
