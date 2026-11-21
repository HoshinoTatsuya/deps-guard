import { deepFreeze } from '../deep-freeze';

/**
 * Поля package.json, зависимости из которых ставятся в дерево проекта.
 * `peerDependencies` сюда не входит: объявление совместимости ставит
 * потребитель, а не проект.
 */
export const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

deepFreeze(DEPENDENCY_FIELDS);
