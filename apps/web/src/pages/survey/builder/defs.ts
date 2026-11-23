/** Pure, immutable edits of a survey definition, used by the builder. */
import {
  QUESTION_TYPE_META,
  cloneElement,
  createPage,
  createQuestion,
  type Element,
  type Page,
  type Question,
  type QuestionType,
  type SurveyDefinition,
} from '@survey/core';

export type Def = SurveyDefinition;

const mapPages = (def: Def, fn: (page: Page) => Page): Def => ({ ...def, pages: def.pages.map(fn) });

export function findElement(def: Def, key: string): { element: Element; page: Page; index: number } | null {
  for (const page of def.pages) {
    const index = page.elements.findIndex((e) => e.key === key);
    if (index !== -1) return { element: page.elements[index]!, page, index };
  }
  return null;
}

export function updateElement(def: Def, key: string, fn: (element: Element) => Element): Def {
  return mapPages(def, (page) => ({
    ...page,
    elements: page.elements.map((e) => (e.key === key ? fn(e) : e)),
  }));
}

export function updatePage(def: Def, pageKey: string, patch: Partial<Page>): Def {
  return mapPages(def, (page) => (page.key === pageKey ? { ...page, ...patch } : page));
}

export function insertElement(def: Def, pageKey: string, element: Element, index?: number): Def {
  return mapPages(def, (page) => {
    if (page.key !== pageKey) return page;
    const elements = [...page.elements];
    elements.splice(index ?? elements.length, 0, element);
    return { ...page, elements };
  });
}

export function removeElement(def: Def, key: string): Def {
  return mapPages(def, (page) => ({ ...page, elements: page.elements.filter((e) => e.key !== key) }));
}

export function duplicateElement(def: Def, key: string): { def: Def; newKey: string } {
  const found = findElement(def, key);
  if (!found) return { def, newKey: key };
  const copy = cloneElement(found.element);
  return { def: insertElement(def, found.page.key, copy, found.index + 1), newKey: copy.key };
}

/** Move an element to `toPageKey` at `toIndex` (index in the destination after removal). */
export function moveElement(def: Def, key: string, toPageKey: string, toIndex: number): Def {
  const found = findElement(def, key);
  if (!found) return def;
  const without = removeElement(def, key);
  return insertElement(without, toPageKey, found.element, toIndex);
}

export function moveElementBy(def: Def, key: string, delta: -1 | 1): Def {
  const found = findElement(def, key);
  if (!found) return def;
  const target = found.index + delta;
  if (target >= 0 && target < found.page.elements.length)
    return moveElement(def, key, found.page.key, target);
  // Past the edge of the page: hop to the neighbouring page.
  const pageIndex = def.pages.indexOf(found.page);
  const neighbour = def.pages[pageIndex + delta];
  if (!neighbour) return def;
  return moveElement(def, key, neighbour.key, delta === 1 ? 0 : neighbour.elements.length);
}

export function addPage(def: Def, afterIndex = def.pages.length - 1): { def: Def; pageKey: string } {
  const page = createPage();
  const pages = [...def.pages];
  pages.splice(afterIndex + 1, 0, page);
  return { def: { ...def, pages }, pageKey: page.key };
}

export function removePage(def: Def, pageKey: string): Def {
  if (def.pages.length <= 1) return def;
  return { ...def, pages: def.pages.filter((p) => p.key !== pageKey) };
}

export function movePage(def: Def, from: number, to: number): Def {
  if (to < 0 || to >= def.pages.length) return def;
  const pages = [...def.pages];
  const [page] = pages.splice(from, 1);
  pages.splice(to, 0, page!);
  return { ...def, pages };
}

/**
 * Change a question's type. The result gets a NEW key: answers to the old question must never be
 * read as answers to a different type (the server rejects type changes under a published key).
 */
export function convertQuestion(question: Question, type: QuestionType): Question {
  const fresh = createQuestion(type, question.title);
  const next = { ...fresh, helpText: question.helpText, required: question.required } as Question;
  if ('options' in next && 'options' in question && type !== 'likert' && question.type !== 'likert') {
    const keepOther = QUESTION_TYPE_META[type].supportsOther;
    (next as { options: typeof question.options }).options = question.options
      .filter((o) => keepOther || !o.isOther)
      .map((o) => ({ key: o.key, label: o.label, ...(o.isOther ? { isOther: true } : {}) }));
  }
  if (next.helpText === undefined) delete (next as { helpText?: string }).helpText;
  return next;
}

/** Display number of each question, in survey order. */
export function questionNumbers(def: Def): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  for (const page of def.pages)
    for (const e of page.elements) if (e.kind === 'question') numbers.set(e.key, ++n);
  return numbers;
}
