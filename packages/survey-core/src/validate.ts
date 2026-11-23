/**
 * Semantic validation of a structurally valid definition.
 *
 * On every draft save these issues are returned to the builder; on publish, any issue with
 * severity "error" blocks publishing.
 */
import { LIMITS, OPERATORS_BY_KIND, QUESTION_TYPE_META, RESERVED_HIDDEN_FIELDS } from './constants';
import type { Element, Question, SurveyDefinition } from './schema';
import type { Condition, LeafCondition } from './types';
import { isValidIsoDate } from './answers';
import { listQuestions } from './engine';
import { conditionDepth, leaves, operandKind } from './logic';
import { malformedTokens, parseTokens } from './piping';

export interface Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  /** JSON-ish path into the definition, e.g. `pages[0].elements[2].options`. */
  path: string;
  pageKey?: string;
  elementKey?: string;
}

export interface ValidationContext {
  /** The survey is anonymous: identifying question types are not allowed. */
  anonymous?: boolean;
  /** Earlier published versions: a question key must keep its type forever. */
  previousVersions?: SurveyDefinition[];
}

/**
 * Heuristic guard against catastrophic backtracking (ReDoS) in creator-supplied patterns, which
 * run on the server for every answer: rejects backreferences and quantified groups that contain
 * quantifiers, e.g. `(a+)+` or `(\w*)*`. Input is also capped at 1,000 characters.
 */
export function isSafePattern(pattern: string): { ok: true } | { ok: false; reason: string } {
  if (pattern.length > LIMITS.patternLength) return { ok: false, reason: 'is too long' };
  try {
    new RegExp(pattern, 'u');
  } catch {
    return { ok: false, reason: "isn't a valid regular expression" };
  }
  if (/\\[1-9]|\\k</.test(pattern)) return { ok: false, reason: 'uses backreferences' };
  // Strip escapes and character classes, then look for a quantified group containing a quantifier.
  const simplified = pattern.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
  const stack: boolean[] = [];
  for (let i = 0; i < simplified.length; i++) {
    const c = simplified[i]!;
    if (c === '(') stack.push(false);
    else if (c === ')') {
      const hadQuantifier = stack.pop() ?? false;
      const next = simplified[i + 1];
      if (hadQuantifier && (next === '*' || next === '+' || next === '{')) return { ok: false, reason: 'nests repetition (e.g. "(a+)+"), which can freeze the server' };
      if (hadQuantifier && stack.length) stack[stack.length - 1] = true;
    } else if ((c === '*' || c === '+' || c === '{') && stack.length) stack[stack.length - 1] = true;
  }
  return { ok: true };
}

interface Position {
  page: number;
  element: number;
}

export function validateDefinition(def: SurveyDefinition, ctx: ValidationContext = {}): Issue[] {
  const issues: Issue[] = [];
  const seenKeys = new Map<string, string>();
  const error = (code: string, message: string, path: string, extra: Partial<Issue> = {}) =>
    issues.push({ severity: 'error', code, message, path, ...extra });
  const warn = (code: string, message: string, path: string, extra: Partial<Issue> = {}) =>
    issues.push({ severity: 'warning', code, message, path, ...extra });
  const claimKey = (key: string, path: string, extra: Partial<Issue>) => {
    const existing = seenKeys.get(key);
    if (existing) error('duplicate_key', `Key "${key}" is used more than once.`, path, extra);
    else seenKeys.set(key, path);
  };

  const previousTypes = new Map<string, string>();
  for (const prev of ctx.previousVersions ?? []) {
    for (const q of listQuestions(prev)) previousTypes.set(q.key, q.type);
  }

  // Where every question sits, for "refers to an earlier question" checks.
  const positions = new Map<string, Position>();
  const questionsByKey = new Map<string, Question>();
  const pageIndexByKey = new Map<string, number>();
  def.pages.forEach((page, pi) => {
    pageIndexByKey.set(page.key, pi);
    page.elements.forEach((e, ei) => {
      if (e.kind === 'question') {
        positions.set(e.key, { page: pi, element: ei });
        questionsByKey.set(e.key, e);
      }
    });
  });
  const declaredHidden = new Set(def.hiddenFields.map((f) => f.key));
  const numberOf = (key: string) => [...questionsByKey.keys()].indexOf(key) + 1;

  /** Check a condition. `before` is the position its references must precede. */
  const checkCondition = (condition: Condition, path: string, before: Position, extra: Partial<Issue>) => {
    if (conditionDepth(condition) > LIMITS.conditionDepth)
      error('condition_too_deep', `Conditions can be nested at most ${LIMITS.conditionDepth} levels deep.`, path, extra);
    for (const leaf of leaves(condition)) checkLeaf(leaf, path, before, extra);
  };

  const checkLeaf = (leaf: LeafCondition, path: string, before: Position, extra: Partial<Issue>) => {
    if ('hidden' in leaf.source) {
      if (!declaredHidden.has(leaf.source.hidden))
        error('dangling_reference', `The condition uses hidden field "${leaf.source.hidden}", which isn't declared.`, path, extra);
    } else {
      const ref = leaf.source.question;
      const at = positions.get(ref);
      const question = questionsByKey.get(ref);
      if (!at || !question) {
        error('dangling_reference', 'The condition refers to a question that no longer exists.', path, extra);
        return;
      }
      const earlier = at.page < before.page || (at.page === before.page && at.element < before.element);
      if (!earlier)
        error('forward_reference', `The condition uses question ${numberOf(ref)}, which comes later. Conditions can only use earlier answers.`, path, extra);
      const sub = leaf.source.sub;
      if (sub) {
        const subs = question.type === 'matrix' ? question.rows : question.type === 'ranking' ? question.options : null;
        if (!subs) error('invalid_condition', `Question ${numberOf(ref)} has no rows or options to pick from.`, path, extra);
        else if (!subs.some((s) => s.key === sub))
          error('dangling_reference', `The condition refers to a row or option of question ${numberOf(ref)} that no longer exists.`, path, extra);
      }
      // Option values must exist.
      if ('options' in question && ['eq', 'neq', 'in', 'not_in', 'contains_any', 'contains_all', 'contains_none'].includes(leaf.op)) {
        const kind = operandKind(def, leaf.source);
        if (kind === 'choice' || kind === 'multi') {
          const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
          if (values.some((v) => !question.options.some((o) => o.key === v)))
            error('dangling_reference', `The condition uses an option of question ${numberOf(ref)} that no longer exists.`, path, extra);
        }
      }
    }
    const kind = operandKind(def, leaf.source);
    if (kind && !OPERATORS_BY_KIND[kind].includes(leaf.op))
      error('operator_type_mismatch', `"${leaf.op}" can't be used with this kind of answer.`, path, extra);
    const needsValue = !['answered', 'not_answered'].includes(leaf.op);
    const isList = ['in', 'not_in', 'contains_any', 'contains_all', 'contains_none'].includes(leaf.op);
    if (needsValue && (leaf.value === undefined || leaf.value === ''))
      error('missing_value', 'The condition needs a value to compare with.', path, extra);
    else if (leaf.op === 'between' && !(Array.isArray(leaf.value) && leaf.value.length === 2))
      error('invalid_value', '"Between" needs two values.', path, extra);
    else if (isList && !(Array.isArray(leaf.value) && leaf.value.length > 0))
      error('invalid_value', 'Choose at least one value.', path, extra);
  };

  /** Piping tokens may only use earlier answers (or any answer, on end screens) and declared hidden fields. */
  const checkPiping = (text: string | undefined, path: string, before: Position | null, extra: Partial<Issue>) => {
    for (const token of parseTokens(text)) {
      if (token.namespace === 'param' && !declaredHidden.has(token.key))
        error('dangling_reference', `"${token.raw}" uses hidden field "${token.key}", which isn't declared.`, path, extra);
      if (token.namespace === 'q') {
        const at = positions.get(token.key);
        if (!at) error('dangling_reference', `"${token.raw}" refers to a question that no longer exists.`, path, extra);
        else if (before && !(at.page < before.page || (at.page === before.page && at.element < before.element)))
          error('forward_reference', `"${token.raw}" uses question ${numberOf(token.key)}, which comes later.`, path, extra);
      }
    }
    for (const bad of malformedTokens(text))
      warn('malformed_token', `"${bad}" isn't a valid insert. Use {{q.KEY}}, {{param.NAME}} or {{contact.FIELD}}.`, path, extra);
  };

  let questionCount = 0;

  def.pages.forEach((page, pi) => {
    const pagePath = `pages[${pi}]`;
    const atPage = { pageKey: page.key };
    claimKey(page.key, pagePath, atPage);
    if (page.elements.length === 0) warn('empty_page', `Page ${pi + 1} has no content.`, pagePath, atPage);
    if (page.visibleIf) checkCondition(page.visibleIf, `${pagePath}.visibleIf`, { page: pi, element: -1 }, atPage);
    checkPiping(page.title, `${pagePath}.title`, { page: pi, element: 0 }, atPage);
    checkPiping(page.description, `${pagePath}.description`, { page: pi, element: 0 }, atPage);

    page.elements.forEach((element: Element, ei) => {
      const path = `${pagePath}.elements[${ei}]`;
      const at = { pageKey: page.key, elementKey: element.key };
      claimKey(element.key, path, at);
      if (element.visibleIf) checkCondition(element.visibleIf, `${path}.visibleIf`, { page: pi, element: ei }, at);

      if (element.kind === 'text') {
        if (!element.body.trim()) warn('empty_text_block', 'This text block is empty.', path, at);
        checkPiping(element.body, `${path}.body`, { page: pi, element: ei }, at);
        return;
      }

      questionCount++;
      const q = element;
      const meta = QUESTION_TYPE_META[q.type];
      if (!q.title.trim()) error('title_required', 'Every question needs a title.', `${path}.title`, at);
      checkPiping(q.title, `${path}.title`, { page: pi, element: ei }, at);
      checkPiping(q.helpText, `${path}.helpText`, { page: pi, element: ei }, at);

      const previousType = previousTypes.get(q.key);
      if (previousType && previousType !== q.type)
        error('question_type_changed', 'This question changed type since it was published. Delete it and add a new question instead.', path, at);

      if (ctx.anonymous && meta.identifying)
        error('identifying_question_in_anonymous', `${meta.label} questions can't be used in an anonymous survey.`, path, at);

      if ('options' in q) {
        const optPath = `${path}.options`;
        const noun = q.type === 'matrix' ? 'columns' : 'options';
        if (q.options.length < 2) error('too_few_options', `Add at least two ${noun}.`, optPath, at);
        const optionKeys = new Set<string>();
        const labels = new Set<string>();
        q.options.forEach((o, oi) => {
          if (optionKeys.has(o.key)) error('duplicate_key', `Option key "${o.key}" is used twice.`, `${optPath}[${oi}]`, at);
          optionKeys.add(o.key);
          if (!o.label.trim()) error('option_label_required', `${q.type === 'matrix' ? 'Column' : 'Option'} ${oi + 1} has no label.`, `${optPath}[${oi}]`, at);
          const normalised = o.label.trim().toLowerCase();
          if (normalised && labels.has(normalised)) warn('duplicate_option_label', `Two ${noun} are labelled "${o.label}".`, `${optPath}[${oi}]`, at);
          labels.add(normalised);
          if (o.isOther && !meta.supportsOther) error('other_not_supported', `${meta.label} questions can't have an "Other" option.`, optPath, at);
          if (o.exclusive && q.type !== 'multi_choice') error('exclusive_not_supported', 'Only multiple choice options can be exclusive.', optPath, at);
        });
        if (q.options.filter((o) => o.isOther).length > 1) error('multiple_other', 'Only one "Other" option is allowed.', optPath, at);
      }

      switch (q.type) {
        case 'multi_choice': {
          const { minSelections: min, maxSelections: max } = q.config;
          const selectable = q.options.filter((o) => !o.exclusive).length;
          if (min !== undefined && max !== undefined && min > max) error('min_exceeds_max', 'Minimum selections is higher than maximum.', `${path}.config`, at);
          if (max !== undefined && max > selectable) error('max_exceeds_options', 'Maximum selections is higher than the number of options.', `${path}.config`, at);
          if (min !== undefined && min > selectable) error('min_exceeds_options', 'Minimum selections is higher than the number of options.', `${path}.config`, at);
          break;
        }
        case 'matrix': {
          if (q.rows.length < 1) error('too_few_rows', 'Add at least one row.', `${path}.rows`, at);
          const rowKeys = new Set<string>();
          q.rows.forEach((r, ri) => {
            if (rowKeys.has(r.key) || q.options.some((o) => o.key === r.key)) error('duplicate_key', `Row key "${r.key}" is used twice.`, `${path}.rows[${ri}]`, at);
            rowKeys.add(r.key);
            if (!r.label.trim()) error('option_label_required', `Row ${ri + 1} has no label.`, `${path}.rows[${ri}]`, at);
          });
          break;
        }
        case 'ranking':
          if (q.config.rankCount !== undefined && q.config.rankCount > q.options.length)
            error('max_exceeds_options', 'You ask for more ranks than there are options.', `${path}.config`, at);
          break;
        case 'short_text':
        case 'long_text': {
          if (q.config.minLength !== undefined && q.config.minLength > q.config.maxLength)
            error('min_exceeds_max', 'Minimum length is longer than maximum length.', `${path}.config`, at);
          if (q.type === 'short_text') {
            const { minValue, maxValue, pattern } = q.config;
            if (minValue !== undefined && maxValue !== undefined && minValue > maxValue)
              error('min_exceeds_max', 'Minimum value is higher than maximum value.', `${path}.config`, at);
            if (pattern) {
              const safe = isSafePattern(pattern);
              if (!safe.ok) error('unsafe_pattern', `The validation pattern ${safe.reason}.`, `${path}.config.pattern`, at);
            }
          }
          break;
        }
        case 'slider': {
          const { min, max, step } = q.config;
          if (min >= max) error('min_exceeds_max', 'The slider minimum must be below its maximum.', `${path}.config`, at);
          else if ((max - min) / step > 1000) error('too_many_steps', 'The slider has more than 1,000 steps. Use a larger step.', `${path}.config`, at);
          break;
        }
        case 'date': {
          const { minDate, maxDate, minTime, maxTime } = q.config;
          if (minDate && !isValidIsoDate(minDate)) error('invalid_date', 'Earliest date is not a valid date.', `${path}.config.minDate`, at);
          if (maxDate && !isValidIsoDate(maxDate)) error('invalid_date', 'Latest date is not a valid date.', `${path}.config.maxDate`, at);
          if (minDate && maxDate && minDate > maxDate) error('min_exceeds_max', 'Earliest date is after the latest date.', `${path}.config`, at);
          if (minTime && maxTime && minTime > maxTime) error('min_exceeds_max', 'Earliest time is after the latest time.', `${path}.config`, at);
          break;
        }
        case 'consent':
          if (!q.config.statement.trim()) error('statement_required', 'Write the statement people agree to.', `${path}.config.statement`, at);
          if (q.config.linkUrl && !/^https?:\/\//i.test(q.config.linkUrl)) error('invalid_url', 'The link must start with https://.', `${path}.config.linkUrl`, at);
          if (!q.required) warn('consent_optional', 'Consent questions are usually required.', path, at);
          break;
        case 'likert':
          if (q.options.some((o) => o.value === undefined))
            warn('likert_missing_values', 'Give every scale point a numeric value so averages can be shown.', path, at);
          break;
      }
    });
  });

  if (questionCount === 0) error('no_questions', 'Add at least one question.', 'pages');
  if (questionCount > LIMITS.questions) error('too_many_questions', `A survey can have at most ${LIMITS.questions} questions.`, 'pages');

  // Navigation rules: forward jumps only, valid targets, unique ids.
  const ruleIds = new Set<string>();
  (def.logic ?? []).forEach((rule, ri) => {
    const path = `logic[${ri}]`;
    if (ruleIds.has(rule.id)) error('duplicate_key', `Rule key "${rule.id}" is used twice.`, path);
    ruleIds.add(rule.id);
    const from = pageIndexByKey.get(rule.afterPage);
    if (from === undefined) {
      error('dangling_reference', 'A rule belongs to a page that no longer exists.', path);
      return;
    }
    const at = { pageKey: rule.afterPage };
    checkCondition(rule.when, `${path}.when`, { page: from, element: Number.MAX_SAFE_INTEGER }, at);
    if ('goTo' in rule.then) {
      const to = pageIndexByKey.get(rule.then.goTo);
      if (to === undefined) error('dangling_reference', `A rule on page ${from + 1} jumps to a page that no longer exists.`, path, at);
      else if (to <= from) error('backward_jump', `A rule on page ${from + 1} jumps back to page ${to + 1}. Rules can only skip forward.`, path, at);
    }
  });

  const hiddenKeys = new Set<string>();
  def.hiddenFields.forEach((field, i) => {
    const path = `hiddenFields[${i}]`;
    if (hiddenKeys.has(field.key)) error('duplicate_hidden_field', `Hidden field "${field.key}" is declared twice.`, path);
    hiddenKeys.add(field.key);
    if ((RESERVED_HIDDEN_FIELDS as readonly string[]).includes(field.key))
      error('reserved_hidden_field', `"${field.key}" is reserved by the platform. Choose another name.`, path);
    if (ctx.anonymous && !field.nonIdentifying)
      warn('hidden_field_dropped_when_anonymous', `Hidden field "${field.key}" isn't marked as non-identifying, so it won't be collected in this anonymous survey.`, path);
  });

  // End screens may use any answer.
  const { thankYou, disqualified } = def.settings;
  checkPiping(thankYou.title, 'settings.thankYou.title', null, {});
  checkPiping(thankYou.body, 'settings.thankYou.body', null, {});
  if (thankYou.redirectUrl) {
    checkPiping(thankYou.redirectUrl, 'settings.thankYou.redirectUrl', null, {});
    const candidate = thankYou.redirectUrl.replace(/\{\{[^}]*\}\}/g, 'x');
    let valid = false;
    try {
      valid = ['http:', 'https:'].includes(new URL(candidate).protocol);
    } catch {
      valid = false;
    }
    if (!valid) error('invalid_url', 'The redirect must be a full web address starting with https://.', 'settings.thankYou.redirectUrl');
  }
  if (disqualified) {
    checkPiping(disqualified.title, 'settings.disqualified.title', null, {});
    checkPiping(disqualified.body, 'settings.disqualified.body', null, {});
  }

  return issues;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
