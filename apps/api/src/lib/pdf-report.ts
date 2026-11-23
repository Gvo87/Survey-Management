/**
 * PDF results report (Phase 2B): KPIs plus one chart per question, drawn with pdfkit vector
 * primitives. No headless browser (docs/05-risks.md E4: Chromium in the worker is memory-heavy).
 *
 * Limitation: the built-in PDF fonts cover Western European text (WinAnsi). Other characters are
 * replaced with "?"; the XLSX and CSV exports keep every character.
 */
import PDFDocument from 'pdfkit';
import type { QuestionSummary, ResultsSummary } from '@survey/contracts';

const INK = '#1b1f24';
const MUTED = '#555e69';
const BAR = '#2a78d6';
const TRACK = '#e8edf3';
const GOOD = '#1baf7a';
const BAD = '#d64545';
const NEUTRAL = '#b9c0c8';
const PAGE = { width: 595.28, height: 841.89, margin: 48 };
const CONTENT = PAGE.width - PAGE.margin * 2;

/** Keep only characters the standard fonts can draw. */
const safe = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7e\xa0-\xff\n]/g, '?');

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '0%');

export interface ReportMeta {
  title: string;
  orgName: string;
  scope: string;
  generatedAt: Date;
}

export async function renderPdfReport(meta: ReportMeta, summary: ResultsSummary): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, info: { Title: safe(meta.title), Author: safe(meta.orgName), Producer: 'Survey Platform' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const ensure = (height: number) => {
    if (doc.y + height > PAGE.height - PAGE.margin) doc.addPage();
  };

  // ── Title and KPIs ──
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(safe(meta.title), { width: CONTENT });
  doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor(MUTED);
  doc.text(safe(`${meta.orgName} - generated ${meta.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`));
  doc.text(safe(meta.scope));
  doc.moveDown(1);

  const t = summary.totals;
  const kpis: [string, string][] = [
    ['Completed', t.completed.toLocaleString('en')],
    ['Started', t.started.toLocaleString('en')],
    ['Completion rate', t.completionRate === null ? '-' : `${Math.round(t.completionRate * 1000) / 10}%`],
    ['Median time', t.medianDurationSec === null ? '-' : `${Math.floor(t.medianDurationSec / 60)}m ${t.medianDurationSec % 60}s`],
  ];
  const boxW = (CONTENT - 3 * 10) / 4;
  const top = doc.y;
  kpis.forEach(([label, value], i) => {
    const x = PAGE.margin + i * (boxW + 10);
    doc.roundedRect(x, top, boxW, 54, 6).fillColor('#f3f5f8').fill();
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(label, x + 10, top + 9, { width: boxW - 20 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(value, x + 10, top + 24, { width: boxW - 20 });
  });
  doc.x = PAGE.margin;
  doc.y = top + 70;
  if (t.disqualified) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${t.disqualified} screened out by logic rules.`).moveDown(0.5);

  // ── One section per question ──
  summary.questions.forEach((q, i) => {
    ensure(90);
    doc.x = PAGE.margin;
    doc.moveDown(0.6).fillColor(INK).font('Helvetica-Bold').fontSize(12).text(safe(`${i + 1}. ${q.title}`), { width: CONTENT });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${q.answered.toLocaleString('en')} answered${q.removedInCurrentVersion ? ' - removed in the current version' : ''}`);
    doc.moveDown(0.4);
    drawQuestion(doc, q, ensure);
  });

  doc.end();
  return done;
}

type Doc = InstanceType<typeof PDFDocument>;

function bars(doc: Doc, rows: { label: string; value: number; text: string }[], max: number, ensure: (h: number) => void) {
  const labelW = CONTENT * 0.38;
  const barW = CONTENT * 0.46;
  for (const row of rows) {
    ensure(18);
    const y = doc.y;
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(safe(row.label), PAGE.margin, y + 1, { width: labelW - 8, height: 12, ellipsis: true, lineBreak: false });
    doc.rect(PAGE.margin + labelW, y, barW, 11).fillColor(TRACK).fill();
    const w = max > 0 ? Math.max(row.value > 0 ? 1.5 : 0, (row.value / max) * barW) : 0;
    if (w > 0) doc.rect(PAGE.margin + labelW, y, w, 11).fillColor(BAR).fill();
    doc.fillColor(MUTED).fontSize(9).text(row.text, PAGE.margin + labelW + barW + 6, y + 1, { width: CONTENT - labelW - barW - 6, lineBreak: false });
    doc.x = PAGE.margin;
    doc.y = y + 16;
  }
}

function columns(doc: Doc, data: { label: string; count: number; color?: string }[], ensure: (h: number) => void) {
  if (!data.length) return;
  const h = 70;
  ensure(h + 24);
  const top = doc.y;
  const max = Math.max(1, ...data.map((d) => d.count));
  const slot = CONTENT / data.length;
  const w = Math.max(2, Math.min(28, slot * 0.7));
  data.forEach((d, i) => {
    const x = PAGE.margin + i * slot + (slot - w) / 2;
    const bh = (d.count / max) * h;
    doc.rect(x, top + h - bh, w, bh).fillColor(d.color ?? BAR).fill();
    doc.fillColor(MUTED).font('Helvetica').fontSize(7).text(safe(d.label), PAGE.margin + i * slot, top + h + 3, { width: slot, align: 'center', lineBreak: false });
  });
  doc.moveTo(PAGE.margin, top + h).lineTo(PAGE.margin + CONTENT, top + h).strokeColor(NEUTRAL).lineWidth(0.5).stroke();
  doc.x = PAGE.margin;
  doc.y = top + h + 16;
}

function note(doc: Doc, text: string) {
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(safe(text), PAGE.margin, doc.y, { width: CONTENT });
  doc.moveDown(0.3);
}

function drawQuestion(doc: Doc, q: QuestionSummary, ensure: (h: number) => void) {
  switch (q.type) {
    case 'single_choice':
    case 'multi_choice':
    case 'dropdown':
    case 'likert': {
      const max = Math.max(0, ...q.options.map((o) => o.count));
      bars(doc, q.options.map((o) => ({ label: o.label, value: o.count, text: `${o.count} (${o.pct}%)` })), max, ensure);
      if (q.mean !== null && q.mean !== undefined) note(doc, `Average score: ${q.mean}`);
      return;
    }
    case 'rating':
      note(doc, `Average ${q.mean ?? '-'} of ${q.scale} - median ${q.median ?? '-'}`);
      columns(doc, q.distribution.map((d) => ({ label: String(d.value), count: d.count })), ensure);
      return;
    case 'nps':
      note(doc, `NPS ${q.score ?? '-'}: ${q.promoters} promoters, ${q.passives} passives, ${q.detractors} detractors`);
      columns(
        doc,
        q.distribution.map((d) => ({ label: String(d.value), count: d.count, color: d.value >= 9 ? GOOD : d.value >= 7 ? NEUTRAL : BAD })),
        ensure,
      );
      return;
    case 'slider':
      note(doc, `Average ${q.mean ?? '-'} - median ${q.median ?? '-'} (range ${q.min} to ${q.max})`);
      columns(doc, q.histogram.map((b) => ({ label: String(b.from), count: b.count })), ensure);
      return;
    case 'date':
      columns(doc, q.byDay.slice(-31).map((d) => ({ label: d.date.slice(5), count: d.count })), ensure);
      return;
    case 'matrix': {
      const labelW = CONTENT * 0.3;
      const cellW = (CONTENT - labelW) / Math.max(1, q.columns.length);
      ensure(18);
      let y = doc.y;
      q.columns.forEach((c, j) =>
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(safe(c.label), PAGE.margin + labelW + j * cellW, y, { width: cellW, align: 'center', lineBreak: false }),
      );
      y += 14;
      q.rows.forEach((r, i) => {
        ensure(18);
        if (doc.y > y) y = doc.y;
        doc.fillColor(INK).font('Helvetica').fontSize(8).text(safe(r.label), PAGE.margin, y + 3, { width: labelW - 6, lineBreak: false, ellipsis: true });
        q.columns.forEach((_, j) => {
          const n = q.counts[i]![j]!;
          const share = r.answered ? n / r.answered : 0;
          const shade = Math.round(255 - share * 120);
          doc.rect(PAGE.margin + labelW + j * cellW + 1, y, cellW - 2, 15).fillColor(`rgb(${shade - 40}, ${shade - 10}, 255)`).fill();
          doc.fillColor(INK).fontSize(8).text(pct(n, r.answered), PAGE.margin + labelW + j * cellW, y + 4, { width: cellW, align: 'center', lineBreak: false });
        });
        y += 17;
      });
      doc.x = PAGE.margin;
      doc.y = y + 4;
      return;
    }
    case 'ranking': {
      const total = q.answered || 1;
      bars(
        doc,
        q.options.map((o, i) => ({ label: `${i + 1}. ${o.label}`, value: o.firstPlace, text: `avg ${o.meanRank ?? '-'}, 1st ${pct(o.firstPlace, total)}` })),
        Math.max(0, ...q.options.map((o) => o.firstPlace)),
        ensure,
      );
      note(doc, 'Sorted by average rank (1 is best). Bars show how often each was ranked first.');
      return;
    }
    case 'consent':
      note(doc, `${q.agreed} agreed (${pct(q.agreed, q.answered)}).`);
      return;
    case 'file_upload':
      note(doc, `${q.files} responses include files (download them from the response viewer).`);
      return;
    case 'short_text':
    case 'long_text':
    case 'email':
    case 'phone':
      if (q.type === 'email' || q.type === 'phone') {
        note(doc, 'Contact details are not included in the PDF report.');
        return;
      }
      for (const answer of q.latest.slice(0, 5)) {
        ensure(28);
        doc.fillColor(INK).font('Helvetica-Oblique').fontSize(9).text(safe(`"${answer.text.slice(0, 300)}"`), PAGE.margin + 10, doc.y, { width: CONTENT - 10 });
        doc.moveDown(0.3);
      }
      if (!q.latest.length) note(doc, 'No answers yet.');
      else note(doc, 'Latest answers shown. All answers are in the CSV and XLSX exports.');
      doc.x = PAGE.margin;
      return;
  }
}
