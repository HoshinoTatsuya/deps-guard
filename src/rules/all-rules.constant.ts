import { deepFreeze } from '../deep-freeze';
import type { Rule } from '../types/rule.type';
import { BannedPackageRule } from './banned-package.rule';
import { FloatingRangeRule } from './floating-range.rule';
import { FreshnessRule } from './freshness.rule';
import { InstallScriptRule } from './install-script.rule';
import { LockMismatchRule } from './lock-mismatch.rule';
import { NewDependencyRule } from './new-dependency.rule';
import { SourceRule } from './source.rule';
import { TyposquattingRule } from './typosquatting.rule';

/** Правила в порядке отчёта. */
export const ALL_RULES: readonly Rule[] = [
  NewDependencyRule,
  InstallScriptRule,
  SourceRule,
  TyposquattingRule,
  FreshnessRule,
  FloatingRangeRule,
  LockMismatchRule,
  BannedPackageRule,
];

deepFreeze(ALL_RULES);
