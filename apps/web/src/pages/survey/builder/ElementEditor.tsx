import {
  QUESTION_TYPES,
  QUESTION_TYPE_META,
  createOption,
  type ChoiceOption,
  type Element,
  type Issue,
  type Question,
  type QuestionType,
} from '@survey/core';
import { Button, Checkbox, SelectField, TextArea, TextField } from '../../../components/ui';
import { convertQuestion } from './defs';

interface EditorProps {
  element: Element;
  issues: Issue[];
  onChange: (element: Element) => void;
}

const num = (value: string): number | undefined =>
  value.trim() === '' ? undefined : Math.max(0, Math.floor(Number(value)));

export function ElementEditor({ element, issues, onChange }: EditorProps) {
  if (element.kind === 'text')
    return (
      <div className="flex flex-col gap-3">
        <TextArea
          label="Text"
          hint="Shown to respondents as plain text. Leave a blank line between paragraphs."
          rows={4}
          autoFocus={!element.body}
          value={element.body}
          onChange={(e) => onChange({ ...element, body: e.target.value })}
        />
        <IssueList issues={issues} />
      </div>
    );
  return <QuestionEditor question={element} issues={issues} onChange={onChange} />;
}

function QuestionEditor({
  question,
  issues,
  onChange,
}: {
  question: Question;
  issues: Issue[];
  onChange: (q: Question) => void;
}) {
  const set = <K extends keyof Question>(key: K, value: Question[K]) =>
    onChange({ ...question, [key]: value } as Question);
  const setConfig = (patch: Record<string, unknown>) => {
    const config = { ...question.config, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(config)) if (config[k] === undefined || config[k] === '') delete config[k];
    onChange({ ...question, config } as Question);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <TextArea
          label="Question"
          rows={2}
          autoFocus={!question.title}
          value={question.title}
          onChange={(e) => set('title', e.target.value)}
          error={issues.find((i) => i.code === 'title_required')?.message}
        />
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
      <TextField
        label="Help text (optional)"
        value={question.helpText ?? ''}
        onChange={(e) => {
          const { helpText: _, ...rest } = question;
          onChange((e.target.value ? { ...question, helpText: e.target.value } : rest) as Question);
        }}
      />

      {'options' in question ? <OptionsEditor question={question} onChange={onChange} /> : null}

      <TypeSettings question={question} setConfig={setConfig} />

      <Checkbox
        label="Required"
        checked={question.required}
        onChange={(e) => set('required', e.target.checked)}
      />
      <IssueList issues={issues.filter((i) => i.code !== 'title_required')} />
    </div>
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
  const update = (i: number, patch: Partial<ChoiceOption>) =>
    setOptions(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
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
  const isLikert = question.type === 'likert';

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{isLikert ? 'Scale points' : 'Options'}</legend>
      <ol className="flex flex-col gap-2">
        {options.map((o, i) => (
          <li key={o.key} className="flex items-center gap-2">
            <span className="w-6 text-right text-xs text-muted" aria-hidden="true">
              {i + 1}.
            </span>
            <input
              className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-sm"
              aria-label={`Option ${i + 1} label`}
              value={o.label}
              readOnly={o.isOther ? false : undefined}
              onChange={(e) => update(i, { label: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !o.isOther) {
                  e.preventDefault();
                  const next = [...options];
                  next.splice(i + 1, 0, createOption(''));
                  setOptions(next);
                  setTimeout(() =>
                    (
                      e.currentTarget.closest('ol')?.querySelectorAll('input')[i + 1] as
                        HTMLInputElement | undefined
                    )?.focus(),
                  );
                }
              }}
            />
            {isLikert ? (
              <input
                type="number"
                className="w-16 rounded-lg border border-line px-2 py-1.5 text-sm"
                aria-label={`Option ${i + 1} value`}
                title="Numeric value used for averages"
                value={o.value ?? ''}
                onChange={(e) => {
                  const value = num(e.target.value);
                  const { value: _, ...rest } = o;
                  setOptions(
                    options.map((x, j) => (j === i ? (value === undefined ? rest : { ...rest, value }) : x)),
                  );
                }}
              />
            ) : null}
            {question.type === 'multi_choice' && !o.isOther ? (
              <label
                className="flex items-center gap-1 text-xs text-muted"
                title="Selecting it clears the others, e.g. 'None of the above'"
              >
                <input
                  type="checkbox"
                  checked={Boolean(o.exclusive)}
                  onChange={(e) => update(i, { exclusive: e.target.checked || undefined })}
                />
                Exclusive
              </label>
            ) : null}
            {o.isOther ? <span className="text-xs text-muted">+ free text</span> : null}
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move option ${i + 1} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move option ${i + 1} down`}
              disabled={i === options.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove option ${i + 1}`}
              onClick={() => setOptions(options.filter((_, j) => j !== i))}
            >
              ✕
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2 pl-8">
        <Button
          size="sm"
          onClick={() => {
            const opt = createOption(
              `Option ${regular.length + 1}`,
              isLikert ? { value: options.length + 1 } : {},
            );
            setOptions(other ? [...regular, opt, other] : [...options, opt]);
          }}
        >
          Add option
        </Button>
        {supportsOther && !other ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOptions([...options, createOption('Other', { isOther: true })])}
          >
            Add "Other" with free text
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}

function TypeSettings({
  question,
  setConfig,
}: {
  question: Question;
  setConfig: (patch: Record<string, unknown>) => void;
}) {
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
            <TextField
              label="Placeholder"
              value={question.config.placeholder ?? ''}
              onChange={(e) => setConfig({ placeholder: e.target.value })}
            />
          ) : null}
        </div>
      );
    case 'short_text':
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
          <TextField
            label="Placeholder"
            value={question.config.placeholder ?? ''}
            onChange={(e) => setConfig({ placeholder: e.target.value })}
          />
        </div>
      );
    case 'email':
      return (
        <TextField
          label="Placeholder"
          value={question.config.placeholder ?? ''}
          onChange={(e) => setConfig({ placeholder: e.target.value })}
        />
      );
    case 'rating':
      return (
        <div className="grid gap-3 sm:grid-cols-4">
          <SelectField
            label="Scale"
            value={question.config.scale}
            onChange={(e) => setConfig({ scale: Number(e.target.value) })}
          >
            {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                1 to {n}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Show as"
            value={question.config.icon}
            onChange={(e) => setConfig({ icon: e.target.value })}
          >
            <option value="star">Stars</option>
            <option value="number">Numbers</option>
          </SelectField>
          <TextField
            label="Low label"
            value={question.config.lowLabel ?? ''}
            onChange={(e) => setConfig({ lowLabel: e.target.value })}
          />
          <TextField
            label="High label"
            value={question.config.highLabel ?? ''}
            onChange={(e) => setConfig({ highLabel: e.target.value })}
          />
        </div>
      );
    case 'nps':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="Label for 0"
            value={question.config.lowLabel}
            onChange={(e) => setConfig({ lowLabel: e.target.value || ' ' })}
          />
          <TextField
            label="Label for 10"
            value={question.config.highLabel}
            onChange={(e) => setConfig({ highLabel: e.target.value || ' ' })}
          />
        </div>
      );
    case 'date':
      return (
        <div className="grid gap-3 sm:max-w-md sm:grid-cols-2">
          <TextField
            label="Earliest date"
            type="date"
            value={question.config.minDate ?? ''}
            onChange={(e) => setConfig({ minDate: e.target.value || undefined })}
          />
          <TextField
            label="Latest date"
            type="date"
            value={question.config.maxDate ?? ''}
            onChange={(e) => setConfig({ maxDate: e.target.value || undefined })}
          />
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
