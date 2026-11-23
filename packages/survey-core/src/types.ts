/**
 * Recursive logic types. Declared by hand because Zod can't infer recursive types; schema.ts
 * annotates its schemas with these.
 */
import type { Operator } from './constants';

/** What a condition looks at: an answer (optionally one matrix row or ranked option), or a hidden field. */
export type Operand = { question: string; sub?: string } | { hidden: string };

export type ConditionValue = string | number | boolean | (string | number)[];

export interface LeafCondition {
  source: Operand;
  op: Operator;
  value?: ConditionValue;
}

/** AND / OR / NOT groups, nested at most 3 levels deep (validator-enforced). */
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | LeafCondition;

/** Evaluated when the respondent leaves `afterPage`; the first matching rule wins. */
export interface NavigationRule {
  id: string;
  afterPage: string;
  when: Condition;
  then: { goTo: string } | { end: true } | { disqualify: true };
}
