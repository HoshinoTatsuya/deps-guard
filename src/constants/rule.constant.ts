import { deepFreeze } from '../deep-freeze';

/**
 * Правила гейта. `input` — не правило поставок, а итог чтения входов: lock-файл,
 * package.json и настройка, которые не удалось прочесть, — отказ гейта, а не
 * пропуск проверки.
 */
export const RULE = {
  'new-dependency': { title: 'Новая прямая зависимость — только с записью-причиной' },
  'install-script': {
    title: 'Install-скрипты — только у разрешённых пакетов, и настройка менеджера запрещает остальные',
  },
  source: { title: 'Пакеты — только из разрешённых реестров, с integrity' },
  typosquatting: { title: 'Имена не похожи на популярные пакеты' },
  freshness: { title: 'Версии опубликованы не позже порога свежести' },
  'floating-range': { title: 'Прямые зависимости — без плавающих диапазонов' },
  'lock-mismatch': { title: 'package.json и lock-файл согласованы' },
  'banned-package': {
    title: 'В дереве нет запрещённых пакетов (прямых, транзитивных, peer, optional, под алиасом)',
  },
  input: { title: 'Входы гейта прочитаны: настройка, lock-файл, package.json' },
} as const;

deepFreeze(RULE);
