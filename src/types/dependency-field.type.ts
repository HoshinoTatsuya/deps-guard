import type { DEPENDENCY_FIELDS } from '../constants/dependency-fields.constant';

/** Поле package.json с устанавливаемыми зависимостями. */
export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];
