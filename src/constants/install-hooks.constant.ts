import { deepFreeze } from '../deep-freeze';

/**
 * Скрипты жизненного цикла, которые менеджер выполняет при установке пакета
 * как зависимости. Пакет с `binding.gyp` без своего `install` npm и pnpm
 * собирают `node-gyp rebuild` — это тоже install-скрипт.
 */
export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

deepFreeze(INSTALL_HOOKS);
