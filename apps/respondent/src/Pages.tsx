import { useEffect, useRef, type ReactNode } from 'react';

/** Plain text with blank-line paragraphs. Never rendered as HTML. */
export function Paragraphs({ text, className }: { text: string; className?: string }) {
  const parts = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className={className}>
      {parts.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}

/** A full-page message (thank you, closed, not found…) whose heading takes focus. */
export function MessagePage({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <main className="survey message-page">
      {icon ? (
        <div className="message-icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h1 ref={ref} tabIndex={-1}>
        {title}
      </h1>
      {children}
    </main>
  );
}

export function Loading() {
  return (
    <main className="survey loading" aria-busy="true">
      <div className="skeleton title" />
      <div className="skeleton line" />
      <div className="skeleton block" />
      <span className="sr-only">Loading survey…</span>
    </main>
  );
}
