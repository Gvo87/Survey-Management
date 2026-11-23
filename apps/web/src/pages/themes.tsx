/**
 * Themes (Phase 2A): colours, font, corner radius and a logo for respondent pages. Colours that
 * fail WCAG AA contrast can't be saved (checked here as you type, and again by the API).
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Theme } from '@survey/contracts';
import {
  DEFAULT_THEME,
  THEME_FONTS,
  THEME_RADII,
  checkThemeContrast,
  contrastRatio,
  inkFor,
  isHexColor,
  type ThemeTokens,
} from '@survey/core';
import { del, errorMessage, get, post, put, upload } from '../api';
import { useAuth } from '../auth';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, PageHeader, SelectField, TextField } from '../components/ui';

const FONT_LABEL: Record<keyof typeof THEME_FONTS, string> = {
  system: 'System (default)',
  humanist: 'Humanist sans',
  rounded: 'Rounded sans',
  serif: 'Serif',
  mono: 'Monospace',
};
const RADIUS_LABEL: Record<keyof typeof THEME_RADII, string> = { none: 'Square', small: 'Small', medium: 'Medium', large: 'Large' };
const COLOR_FIELDS: { key: 'primary' | 'background' | 'surface' | 'text'; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primary', hint: 'Buttons, selected answers, progress bar' },
  { key: 'background', label: 'Page background', hint: 'Behind the question card' },
  { key: 'surface', label: 'Card background', hint: 'Behind the questions' },
  { key: 'text', label: 'Text', hint: 'Questions and answers' },
];

export function ThemesPage() {
  const { me } = useAuth();
  const isAdmin = me?.activeOrg?.role === 'org_admin';
  const queryClient = useQueryClient();
  const themes = useQuery({ queryKey: ['themes'], queryFn: () => get<Theme[]>('/themes') });
  const [editing, setEditing] = useState<Theme | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Theme | null>(null);
  const reload = () => queryClient.invalidateQueries({ queryKey: ['themes'] });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/themes/${id}`),
    onSuccess: () => {
      setDeleting(null);
      void reload();
    },
  });
  const makeDefault = useMutation({
    mutationFn: (t: Theme) => put(`/themes/${t.id}`, { name: t.name, tokens: t.tokens, isDefault: !t.isDefault }),
    onSuccess: () => void reload(),
  });

  return (
    <>
      <PageHeader
        title="Themes"
        description="How your surveys look to respondents. The default theme applies to every survey that doesn't pick its own."
        actions={isAdmin ? <Button variant="primary" onClick={() => setEditing('new')}>New theme</Button> : null}
      />
      {themes.error ? <Alert tone="error">{errorMessage(themes.error)}</Alert> : null}
      {makeDefault.error ? <Alert tone="error">{errorMessage(makeDefault.error)}</Alert> : null}
      {themes.data?.length === 0 ? (
        <EmptyState title="No themes yet">Surveys use the standard look until you create a theme.</EmptyState>
      ) : null}
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(themes.data ?? []).map((t) => (
          <li key={t.id}>
            <Card>
              <ThemeSample tokens={t.tokens} logoUrl={t.logoUrl} />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 flex-1 truncate font-semibold">{t.name}</h2>
                {t.isDefault ? <Badge className="bg-brand-50 text-brand-700">Default</Badge> : null}
              </div>
              <p className="text-xs text-muted">
                Used by {t.surveyCount} survey{t.surveyCount === 1 ? '' : 's'}
                {t.isDefault ? ' and every survey without its own theme' : ''}.
              </p>
              {isAdmin ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setEditing(t)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" busy={makeDefault.isPending && makeDefault.variables?.id === t.id} onClick={() => makeDefault.mutate(t)}>
                    {t.isDefault ? 'Stop using as default' : 'Make default'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(t)}>
                    Delete
                  </Button>
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
      <ThemeEditor
        open={editing !== null}
        theme={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void reload();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete theme?"
        message={`Surveys using "${deleting?.name}" switch to the organization default.`}
        confirmLabel="Delete theme"
        danger
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </>
  );
}

/** A small, static rendering of a survey page in the theme's colours. */
function ThemeSample({ tokens, logoUrl }: { tokens: ThemeTokens; logoUrl?: string | null }) {
  const radius = THEME_RADII[tokens.radius];
  const style: CSSProperties = { background: tokens.background, color: tokens.text, fontFamily: THEME_FONTS[tokens.font], borderRadius: 12 };
  return (
    <div className="border border-line p-3" style={style} aria-hidden="true">
      {logoUrl ? <img src={logoUrl} alt="" className="mb-2 max-h-6" /> : null}
      <div className="p-3" style={{ background: tokens.surface, borderRadius: radius }}>
        <div className="mb-2 text-sm font-semibold">1. How was your visit?</div>
        <div className="mb-1 px-2 py-1 text-xs" style={{ border: `1px solid ${tokens.primary}`, borderRadius: radius, background: `color-mix(in srgb, ${tokens.primary} 12%, ${tokens.surface})` }}>
          ● Great
        </div>
        <div className="mb-2 px-2 py-1 text-xs" style={{ border: `1px solid color-mix(in srgb, ${tokens.text} 55%, ${tokens.surface})`, borderRadius: radius }}>
          ○ Could be better
        </div>
        <div className="inline-block px-3 py-1 text-xs font-semibold" style={{ background: tokens.primary, color: inkFor(tokens.primary), borderRadius: radius }}>
          Next
        </div>
      </div>
    </div>
  );
}

function ThemeEditor({ open, theme, onClose, onSaved }: { open: boolean; theme: Theme | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [tokens, setTokens] = useState<ThemeTokens>(DEFAULT_THEME);
  const [isDefault, setIsDefault] = useState(false);
  const [logo, setLogo] = useState<{ fileId: string | null; status: 'none' | 'current' | 'uploaded' }>({ fileId: null, status: 'none' });
  const [logoError, setLogoError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(theme?.name ?? '');
    setTokens(theme?.tokens ?? DEFAULT_THEME);
    setIsDefault(theme?.isDefault ?? false);
    setLogo({ fileId: theme?.logoFileId ?? null, status: theme?.logoFileId ? 'current' : 'none' });
    setLogoError(null);
  }, [open, theme]);

  const valid = COLOR_FIELDS.every((f) => isHexColor(tokens[f.key]));
  const problems = useMemo(() => (valid ? checkThemeContrast(tokens) : []), [tokens, valid]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, tokens, isDefault, logoFileId: logo.fileId };
      return theme ? put(`/themes/${theme.id}`, body) : post('/themes', body);
    },
    onSuccess: onSaved,
  });
  const uploadLogo = useMutation({
    mutationFn: (file: File) => upload<{ fileId: string }>('/themes/logo', file),
    onSuccess: (r) => setLogo({ fileId: r.fileId, status: 'uploaded' }),
    onError: (e) => setLogoError(errorMessage(e)),
  });

  const setColor = (key: (typeof COLOR_FIELDS)[number]['key'], value: string) => setTokens((t) => ({ ...t, [key]: value }));
  const canSave = name.trim() !== '' && valid && problems.length === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={theme ? `Edit "${theme.name}"` : 'New theme'}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={save.isPending} disabled={!canSave} onClick={() => save.mutate()}>
            Save theme
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1fr_240px]">
        <div className="flex flex-col gap-4">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Brand, Dark, Events" />
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-semibold">Colours</legend>
            {COLOR_FIELDS.map((f) => (
              <ColorField key={f.key} label={f.label} hint={f.hint} value={tokens[f.key]} onChange={(v) => setColor(f.key, v)} />
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label="Font" value={tokens.font} onChange={(e) => setTokens((t) => ({ ...t, font: e.target.value as ThemeTokens['font'] }))}>
              {Object.entries(FONT_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </SelectField>
            <SelectField label="Corners" value={tokens.radius} onChange={(e) => setTokens((t) => ({ ...t, radius: e.target.value as ThemeTokens['radius'] }))}>
              {Object.entries(RADIUS_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </SelectField>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">Logo</legend>
            <p className="text-xs text-muted">PNG, JPEG, WebP or GIF, up to 1 MB. Shown above the survey title. It appears once its malware check finishes.</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                aria-label="Logo image"
                className="text-sm"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setLogoError(null);
                  if (file) uploadLogo.mutate(file);
                  e.target.value = '';
                }}
              />
              {logo.fileId ? (
                <Button size="sm" variant="ghost" onClick={() => setLogo({ fileId: null, status: 'none' })}>
                  Remove logo
                </Button>
              ) : null}
            </div>
            <p className="text-sm" role="status">
              {uploadLogo.isPending ? 'Uploading…' : logo.status === 'uploaded' ? 'Logo uploaded. Save the theme to use it.' : logo.status === 'current' ? 'This theme has a logo.' : ''}
            </p>
            {logoError ? <Alert tone="error">{logoError}</Alert> : null}
          </fieldset>
          <Checkbox
            label="Use as the organization default"
            hint="Applies to every survey that doesn't choose a theme."
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
        </div>
        <div className="flex flex-col gap-3">
          <ThemeSample tokens={valid ? tokens : DEFAULT_THEME} logoUrl={logo.status === 'current' ? theme?.logoUrl : null} />
          <ContrastReport tokens={tokens} valid={valid} problems={problems} />
        </div>
      </div>
      {save.error ? (
        <Alert tone="error" className="mt-3">
          {errorMessage(save.error)}
        </Alert>
      ) : null}
    </Dialog>
  );
}

function ColorField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="flex items-end gap-2">
      <input
        type="color"
        aria-label={`${label} colour picker`}
        className="h-10 w-12 shrink-0 cursor-pointer rounded border border-line bg-white p-1"
        value={isHexColor(value) ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
      />
      <TextField
        className="min-w-0 flex-1"
        label={label}
        hint={hint}
        value={text}
        maxLength={7}
        spellCheck={false}
        error={isHexColor(text) ? undefined : 'Use a colour like #2445a8.'}
        onChange={(e) => {
          const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
          setText(v);
          if (isHexColor(v)) onChange(v.toLowerCase());
        }}
      />
    </div>
  );
}

function ContrastReport({ tokens, valid, problems }: { tokens: ThemeTokens; valid: boolean; problems: ReturnType<typeof checkThemeContrast> }) {
  if (!valid) return null;
  const checks = [
    { label: 'Text on page', ratio: contrastRatio(tokens.text, tokens.background), need: 4.5 },
    { label: 'Text on card', ratio: contrastRatio(tokens.text, tokens.surface), need: 4.5 },
    { label: 'Button text', ratio: contrastRatio(inkFor(tokens.primary), tokens.primary), need: 4.5 },
    { label: 'Primary on card', ratio: contrastRatio(tokens.primary, tokens.surface), need: 3 },
  ];
  return (
    <div className="rounded-lg border border-line p-3 text-sm" role={problems.length ? 'alert' : 'status'}>
      <p className="mb-2 font-semibold">{problems.length ? 'Contrast too low to save' : 'Meets WCAG AA contrast'}</p>
      <ul className="flex flex-col gap-1">
        {checks.map((c) => (
          <li key={c.label} className="flex justify-between gap-2">
            <span>{c.label}</span>
            <span className={c.ratio >= c.need ? 'text-green-800' : 'font-semibold text-red-700'}>
              {c.ratio >= c.need ? '✓' : '✕'} {c.ratio}:1<span className="sr-only">, needs {c.need}:1</span>
            </span>
          </li>
        ))}
      </ul>
      {problems.length ? <p className="mt-2 text-xs text-muted">Darken the text or lighten the background (or the other way round) until every line passes.</p> : null}
    </div>
  );
}
