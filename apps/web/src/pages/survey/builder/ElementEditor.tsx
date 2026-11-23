import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  FILE_CATEGORIES,
  LIMITS,
  QUESTION_TYPES,
  QUESTION_TYPE_META,
  createOption,
  type ChoiceOption,
  type Element,
  type FileCategory,
  type Issue,
  type Question,
  type QuestionType,
  type SurveyDefinition,
} from '@survey/core';
import { errorMessage, post } from '../../../api';
import { Button, Checkbox, SelectField, TextArea, TextField } from '../../../components/ui';
import { convertQuestion } from './defs';
import { PipeMenu, sourcesBefore, usePipeTarget, VisibilityEditor } from './logic';

interface EditorProps {
  element: Element;
  issues: Issue[];
  def: SurveyDefinition;
  pageKey: string;
  onChange: (element: Element) => void;
}

const num = (value: string): number | undefined =>
  value.trim() === '' ? undefined : Math.max(0, Math.floor(Number(value)));
/** Any finite number (slider bounds, numeric validation), or undefined when empty. */
const anyNum = (value: string): number | undefined => (value.trim() === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));

export function ElementEditor({ element, issues, def, pageKey, onChange }: EditorProps) {
  const sources = useMemo(() => sourcesBefore(def, { pageKey, elementKey: element.key }), [def, pageKey, element.key]);
  const body = usePipeTarget(element.kind === 'text' ? element.body : '', (v) => element.kind === 'text' && onChange({ ...element, body: v }));
  const setVisibleIf = (visibleIf: Element['visibleIf']) => {
    const { visibleIf: _, ...rest } = element;
    onChange((visibleIf ? { ...rest, visibleIf } : rest) as Element);
  };

  if (element.kind === 'text')
    return (
      <div className="flex flex-col gap-3">
        <div className="relative">
          <div className="absolute right-0 top-0">
            <PipeMenu sources={sources} onInsert={body.insert} />
          </div>
          <TextArea
            label="Text"
            hint="Shown to respondents as plain text. Leave a blank line between paragraphs."
            rows={4}
            autoFocus={!element.body}
            value={element.body}
            onChange={(e) => onChange({ ...element, body: e.target.value })}
            {...body.trackProps}
          />
        </div>
        <VisibilityEditor def={def} condition={element.visibleIf} sources={sources} what="text" onChange={setVisibleIf} />
        <IssueList issues={issues} />
      </div>
    );
  return (
    <QuestionEditor
      question={element}
      issues={issues}
      def={def}
      sources={sources}
      onChange={onChange}
      onVisibleIf={setVisibleIf}
    />
  );
}

function QuestionEditor({
  question,
  issues,
  def,
  sources,
  onChange,
  onVisibleIf,
}: {
  question: Question;
  issues: Issue[];
  def: SurveyDefinition;
  sources: ReturnType<typeof sourcesBefore>;
  onChange: (q: Question) => void;
  onVisibleIf: (c: Question['visibleIf']) => void;
}) {
  const set = <K extends keyof Question>(key: K, value: Question[K]) => onChange({ ...question, [key]: value } as Question);
  const setConfig = (patch: Record<string, unknown>) => {
    const config = { ...question.config, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(config)) if (config[k] === undefined || config[k] === '') delete config[k];
    onChange({ ...question, config } as Question);
  };
  const title = usePipeTarget(question.title, (v) => set('title', v));
  const setHelp = (v: string) => {
    const { helpText: _, ...rest } = question;
    onChange((v ? { ...question, helpText: v } : rest) as Question);
  };
  const help = usePipeTarget(question.helpText ?? '', setHelp);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <div className="relative">
          <div className="absolute right-0 top-0">
            <PipeMenu sources={sources} onInsert={title.insert} />
          </div>
          <TextArea
            label="Question"
            rows={2}
            autoFocus={!question.title}
            value={question.title}
            onChange={(e) => set('title', e.target.value)}
            error={issues.find((i) => i.code === 'title_required')?.message}
            {...title.trackProps}
          />
        </div>
        <SelectField
          label="Type"
          value={question.type}
          onChange={(e) => onChange(convertQuestion(question, e.target.value as QuestionType))}
          hint="Changing type creates a new question."
        >
          {QUESTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {QUESTION_TYPE_META[t].label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="relative">
        <div className="absolute right-0 top-0">
          <PipeMenu sources={sources} onInsert={help.insert} />
        </div>
        <TextField label="Help text (optional)" value={question.helpText ?? ''} onChange={(e) => setHelp(e.target.value)} {...help.trackProps} />
      </div>

      {question.type === 'matrix' ? (
        <ListEditor
          legend="Rows"
          itemName="Row"
          items={question.rows}
          onChange={(rows) => onChange({ ...question, rows })}
        />
      ) : null}
      {'options' in question ? <OptionsEditor question={question} onChange={onChange} /> : null}

      <TypeSettings question={question} setConfig={setConfig} />

      <Checkbox
        label="Required"
        hint={question.type === 'consent' ? 'Respondents must tick "I agree" to continue.' : undefined}
        checked={question.required}
        onChange={(e) => set('required', e.target.checked)}
      />
      <VisibilityEditor def={def} condition={question.visibleIf} sources={sources} what="question" onChange={onVisibleIf} />
      <IssueList issues={issues.filter((i) => i.code !== 'title_required')} />
      <SaveToBank question={question} />
    </div>
  );
}

function SaveToBank({ question }: { question: Question }) {
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () => post('/question-bank', { question }),
    onSuccess: () => setDone(true),
  });
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
      <Button size="sm" variant="ghost" busy={save.isPending} disabled={!question.title.trim()} onClick={() => save.mutate()}>
        Save to question bank
      </Button>
      {done ? (
        <span role="status" className="text-green-800">
          Saved. Your organization can reuse it from "+ Add question".
        </span>
      ) : null}
      {save.error ? <span className="text-red-700">{errorMessage(save.error)}</span> : null}
    </div>
  );
}

/** Editable list of labelled items (matrix rows). */
function ListEditor({
  legend,
  itemName,
  items,
  onChange,
}: {
  legend: string;
  itemName: string;
  items: ChoiceOption[];
  onChange: (items: ChoiceOption[]) => void;
}) {
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <ol className="flex flex-col gap-2">
        {items.map((item, i) => (
          <li key={item.key} className="flex items-center gap-2">
            <span className="w-6 text-right text-xs text-muted" aria-hidden="true">
              {i + 1}.
            </span>
            <input
              className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-sm"
              aria-label={`${itemName} ${i + 1} label`}
              value={item.label}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            />
            <Button size="sm" variant="ghost" aria-label={`Move ${itemName.toLowerCase()} ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move ${itemName.toLowerCase()} ${i + 1} down`}
              disabled={i === items.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Remove ${itemName.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
              ✕
            </Button>
          </li>
        ))}
      </ol>
      <Button size="sm" className="ml-8 self-start" onClick={() => onChange([...items, createOption(`${itemName} ${items.length + 1}`)])}>
        Add {itemName.toLowerCase()}
      </Button>
    </fieldset>
  );
}

function OptionsEditor({
  question,
  onChange,
}: {
  question: Extract<Question, { options: ChoiceOption[] }>;
  onChange: (q: Question) => void;
}) {
  const options = question.options;
  const setOptions = (next: ChoiceOption[]) => onChange({ ...question, options: next } as Question);
  const update = (i: number, patch: Partial<ChoiceOption>) => setOptions(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setOptions(next);
  };
  const regular = options.filter((o) => !o.isOther);
  const other = options.find((o) => o.isOther);
  const supportsOther = QUESTION_TYPE_META[question.type].supportsOther;
  const scored = question.type === 'likert' || question.type === 'matrix';
  const legend = question.type === 'likert' ? 'Scale points' : question.type === 'matrix' ? 'Columns' : 'Options';

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <ol className="flex flex-col gap-2">
        {options.map((o, i) => (
          <li key={o.key} className="flex items-center gap-2">
            <span className="w-6 text-right text-xs text-muted" aria-hidden="true">
              {i + 1}.
            </span>
            <input
              className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-sm"
              aria-label={`${legend === 'Columns' ? 'Column' : 'Option'} ${i + 1} label`}
              value={o.label}
              onChange={(e) => update(i, { label: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !o.isOther) {
                  e.preventDefault();
                  const next = [...options];
                  next.splice(i + 1, 0, createOption(''));
                  setOptions(next);
                  setTimeout(() => (e.currentTarget.closest('ol')?.querySelectorAll('input')[i + 1] as HTMLInputElement | undefined)?.focus());
                }
              }}
            />
            {scored ? (
              <input
                type="number"
                className="w-16 rounded-lg border border-line px-2 py-1.5 text-sm"
                aria-label={`Option ${i + 1} value`}
                title="Numeric value used for averages"
                value={o.value ?? ''}
                onChange={(e) => {
                  const value = num(e.target.value);
                  const { value: _, ...rest } = o;
                  setOptions(options.map((x, j) => (j === i ? (value === undefined ? rest : { ...rest, value }) : x)));
                }}
              />
            ) : null}
            {question.type === 'multi_choice' && !o.isOther ? (
              <label className="flex items-center gap-1 text-xs text-muted" title="Selecting it clears the others, e.g. 'None of the above'">
                <input type="checkbox" checked={Boolean(o.exclusive)} onChange={(e) => update(i, { exclusive: e.target.checked || undefined })} />
                Exclusive
              </label>
            ) : null}
            {o.isOther ? <span className="text-xs text-muted">+ free text</span> : null}
            <Button size="sm" variant="ghost" aria-label={`Move option ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Move option ${i + 1} down`} disabled={i === options.length - 1} onClick={() => move(i, 1)}>
              ↓
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
              ✕
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2 pl-8">
        <Button
          size="sm"
          onClick={() => {
            const opt = createOption(`${legend === 'Columns' ? 'Column' : 'Option'} ${regular.length + 1}`, scored ? { value: options.length + 1 } : {});
            setOptions(other ? [...regular, opt, other] : [...options, opt]);
          }}
        >
          Add {legend === 'Columns' ? 'column' : 'option'}
        </Button>
        {supportsOther && !other ? (
          <Button size="sm" variant="ghost" onClick={() => setOptions([...options, createOption('Other', { isOther: true })])}>
            Add "Other" with free text
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

const FILE_CATEGORY_LABEL: Record<FileCategory, string> = {
  image: 'Images (PNG, JPEG, WebP, GIF)',
  pdf: 'PDF',
  document: 'Documents (Word, OpenDocument)',
  spreadsheet: 'Spreadsheets (Excel, CSV)',
  text: 'Plain text',
};

function TypeSettings({ question, setConfig }: { question: Question; setConfig: (patch: Record<string, unknown>) => void }) {
  switch (question.type) {
    case 'single_choice':
    case 'dropdown':
    case 'multi_choice':
      return (
        <div className="flex flex-col gap-3">
          <Checkbox
            label="Randomize option order"
            hint='Each respondent sees a different, stable order. "Other" and exclusive options stay last.'
            checked={question.config.randomize}
            onChange={(e) => setConfig({ randomize: e.target.checked })}
          />
          {question.type === 'multi_choice' ? (
            <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
              <TextField
                label="Min selections"
                type="number"
                min={1}
                value={question.config.minSelections ?? ''}
                onChange={(e) => setConfig({ minSelections: num(e.target.value) || undefined })}
              />
              <TextField
                label="Max selections"
                type="number"
                min={1}
                value={question.config.maxSelections ?? ''}
                onChange={(e) => setConfig({ maxSelections: num(e.target.value) || undefined })}
              />
            </div>
          ) : null}
          {question.type === 'dropdown' ? (
            <TextField label="Placeholder" value={question.config.placeholder ?? ''} onChange={(e) => setConfig({ placeholder: e.target.value })} />
          ) : null}
        </div>
      );
    case 'short_text': {
      const format = question.config.format ?? 'text';
      return (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-medium">Answer format and validation</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField label="Format" value={format} onChange={(e) => setConfig({ format: e.target.value === 'text' ? undefined : e.target.value })}>
              <option value="text">Any text</option>
              <option value="number">Number</option>
              <option value="integer">Whole number</option>
            </SelectField>
            {format === 'text' ? (
              <>
                <TextField
                  label="Min characters"
                  type="number"
                  min={1}
                  value={question.config.minLength ?? ''}
                  onChange={(e) => setConfig({ minLength: num(e.target.value) || undefined })}
                />
                <TextField
                  label="Max characters"
                  type="number"
                  min={1}
                  value={question.config.maxLength}
                  onChange={(e) => setConfig({ maxLength: num(e.target.value) || 1 })}
                />
              </>
            ) : (
              <>
                <TextField label="Minimum" type="number" value={question.config.minValue ?? ''} onChange={(e) => setConfig({ minValue: anyNum(e.target.value) })} />
                <TextField label="Maximum" type="number" value={question.config.maxValue ?? ''} onChange={(e) => setConfig({ maxValue: anyNum(e.target.value) })} />
              </>
            )}
          </div>
          {format === 'text' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Must match pattern (regular expression)"
                hint="Optional. The whole answer must match, e.g. [A-Z]{2}[0-9]{6} for an order number."
                maxLength={LIMITS.patternLength}
                value={question.config.pattern ?? ''}
                onChange={(e) => setConfig({ pattern: e.target.value })}
              />
              <TextField
                label="Message when it doesn't match"
                placeholder="e.g. Enter your order number, like AB123456."
                value={question.config.patternMessage ?? ''}
                onChange={(e) => setConfig({ patternMessage: e.target.value })}
              />
            </div>
          ) : null}
          <TextField label="Placeholder" value={question.config.placeholder ?? ''} onChange={(e) => setConfig({ placeholder: e.target.value })} />
        </fieldset>
      );
    }
    case 'long_text':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Min characters"
            type="number"
            min={1}
            value={question.config.minLength ?? ''}
            onChange={(e) => setConfig({ minLength: num(e.target.value) || undefined })}
          />
          <TextField
            label="Max characters"
            type="number"
            min={1}
            value={question.config.maxLength}
            onChange={(e) => setConfig({ maxLength: num(e.target.value) || 1 })}
          />
          <TextField label="Placeholder" value={question.config.placeholder ?? ''} onChange={(e) => setConfig({ placeholder: e.target.value })} />
        </div>
      );
    case 'email':
      return <TextField label="Placeholder" value={question.config.placeholder ?? ''} onChange={(e) => setConfig({ placeholder: e.target.value })} />;
    case 'phone':
      return <p className="text-sm text-muted">Respondents enter an international number (with country code). It's stored in E.164 format, like +442079460958.</p>;
    case 'rating':
      return (
        <div className="grid gap-3 sm:grid-cols-4">
          <SelectField label="Scale" value={question.config.scale} onChange={(e) => setConfig({ scale: Number(e.target.value) })}>
            {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                1 to {n}
              </option>
            ))}
          </SelectField>
          <SelectField label="Show as" value={question.config.icon} onChange={(e) => setConfig({ icon: e.target.value })}>
            <option value="star">Stars</option>
            <option value="number">Numbers</option>
          </SelectField>
          <TextField label="Low label" value={question.config.lowLabel ?? ''} onChange={(e) => setConfig({ lowLabel: e.target.value })} />
          <TextField label="High label" value={question.config.highLabel ?? ''} onChange={(e) => setConfig({ highLabel: e.target.value })} />
        </div>
      );
    case 'nps':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Label for 0" value={question.config.lowLabel} onChange={(e) => setConfig({ lowLabel: e.target.value || ' ' })} />
          <TextField label="Label for 10" value={question.config.highLabel} onChange={(e) => setConfig({ highLabel: e.target.value || ' ' })} />
        </div>
      );
    case 'slider':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="Minimum" type="number" value={question.config.min} onChange={(e) => setConfig({ min: anyNum(e.target.value) ?? 0 })} />
          <TextField label="Maximum" type="number" value={question.config.max} onChange={(e) => setConfig({ max: anyNum(e.target.value) ?? 100 })} />
          <TextField label="Step" type="number" min={0} value={question.config.step} onChange={(e) => setConfig({ step: anyNum(e.target.value) || 1 })} />
          <TextField label="Unit (optional)" placeholder="e.g. %, km, $" maxLength={20} value={question.config.unit ?? ''} onChange={(e) => setConfig({ unit: e.target.value })} />
          <TextField label="Label at minimum" value={question.config.minLabel ?? ''} onChange={(e) => setConfig({ minLabel: e.target.value })} />
          <TextField label="Label at maximum" value={question.config.maxLabel ?? ''} onChange={(e) => setConfig({ maxLabel: e.target.value })} />
        </div>
      );
    case 'date': {
      const mode = question.config.mode ?? 'date';
      return (
        <div className="grid gap-3 sm:max-w-xl sm:grid-cols-3">
          <SelectField label="Ask for" value={mode} onChange={(e) => setConfig({ mode: e.target.value === 'date' ? undefined : e.target.value, minTime: undefined, maxTime: undefined })}>
            <option value="date">A date</option>
            <option value="time">A time</option>
            <option value="datetime">A date and time</option>
          </SelectField>
          {mode === 'time' ? (
            <>
              <TextField label="Earliest time" type="time" value={question.config.minTime ?? ''} onChange={(e) => setConfig({ minTime: e.target.value || undefined })} />
              <TextField label="Latest time" type="time" value={question.config.maxTime ?? ''} onChange={(e) => setConfig({ maxTime: e.target.value || undefined })} />
            </>
          ) : (
            <>
              <TextField label="Earliest date" type="date" value={question.config.minDate ?? ''} onChange={(e) => setConfig({ minDate: e.target.value || undefined })} />
              <TextField label="Latest date" type="date" value={question.config.maxDate ?? ''} onChange={(e) => setConfig({ maxDate: e.target.value || undefined })} />
            </>
          )}
        </div>
      );
    }
    case 'matrix':
      return (
        <div className="flex flex-col gap-2">
          <Checkbox
            label="Allow several answers per row"
            checked={question.config.multiplePerRow}
            onChange={(e) => setConfig({ multiplePerRow: e.target.checked })}
          />
          <Checkbox label="Randomize row order" checked={question.config.randomizeRows} onChange={(e) => setConfig({ randomizeRows: e.target.checked })} />
          <p className="text-xs text-muted">On phones, each row is shown as its own list of choices.</p>
        </div>
      );
    case 'ranking':
      return (
        <div className="grid gap-3 sm:max-w-md sm:grid-cols-2">
          <TextField
            label="Rank only the top…"
            type="number"
            min={1}
            max={question.options.length}
            hint="Leave empty to rank every option."
            value={question.config.rankCount ?? ''}
            onChange={(e) => setConfig({ rankCount: num(e.target.value) || undefined })}
          />
          <Checkbox className="sm:mt-7" label="Randomize option order" checked={question.config.randomize} onChange={(e) => setConfig({ randomize: e.target.checked })} />
        </div>
      );
    case 'file_upload':
      return (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:max-w-md sm:grid-cols-2">
            <TextField
              label="Maximum files"
              type="number"
              min={1}
              max={LIMITS.maxFiles}
              value={question.config.maxFiles}
              onChange={(e) => setConfig({ maxFiles: Math.min(LIMITS.maxFiles, num(e.target.value) || 1) })}
            />
            <TextField
              label="Maximum size per file (MB)"
              type="number"
              min={1}
              max={LIMITS.maxFileSizeMb}
              value={question.config.maxSizeMb}
              onChange={(e) => setConfig({ maxSizeMb: Math.min(LIMITS.maxFileSizeMb, num(e.target.value) || 1) })}
            />
          </div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Accepted file types</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {FILE_CATEGORIES.map((c) => (
                <Checkbox
                  key={c}
                  label={FILE_CATEGORY_LABEL[c]}
                  checked={question.config.allowedTypes.includes(c)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...question.config.allowedTypes, c] : question.config.allowedTypes.filter((x) => x !== c);
                    if (next.length) setConfig({ allowedTypes: FILE_CATEGORIES.filter((x) => next.includes(x)) });
                  }}
                />
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-muted">
            Files are checked for malware before anyone can download them. The file type is checked from its contents, not its
            name. Anonymous surveys can't ask for files.
          </p>
        </div>
      );
    case 'consent':
      return (
        <div className="flex flex-col gap-3">
          <TextArea
            label="Statement respondents agree to"
            rows={4}
            value={question.config.statement}
            onChange={(e) => setConfig({ statement: e.target.value || ' ' })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Link to the full notice (optional)"
              type="url"
              placeholder="https://example.com/privacy"
              value={question.config.linkUrl ?? ''}
              onChange={(e) => setConfig({ linkUrl: e.target.value })}
            />
            <TextField label="Link text" placeholder="Read the privacy notice" value={question.config.linkLabel ?? ''} onChange={(e) => setConfig({ linkLabel: e.target.value })} />
          </div>
          <p className="text-xs text-muted">The exact statement each respondent agreed to is recorded with their answer.</p>
        </div>
      );
    case 'likert':
      return null;
  }
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {issues.map((issue, i) => (
        <li key={i} className={issue.severity === 'error' ? 'text-red-700' : 'text-amber-800'}>
          <span aria-hidden="true">{issue.severity === 'error' ? '⚠ ' : 'ⓘ '}</span>
          <span className="sr-only">{issue.severity === 'error' ? 'Error: ' : 'Warning: '}</span>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}
