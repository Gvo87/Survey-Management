import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Phase 2B: campaign emails also carry HTML, list headers and report attachments. */
  html?: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
  /** Only populated by the in-memory mailer used in tests. */
  outbox: EmailMessage[];
}

export function createMailer(transport: 'smtp' | 'memory', smtpUrl: string, from: string): Mailer {
  if (transport === 'memory') {
    const outbox: EmailMessage[] = [];
    return { outbox, send: async (m) => void outbox.push(m) };
  }
  const smtp = nodemailer.createTransport(smtpUrl);
  return {
    outbox: [],
    send: async (m) => {
      await smtp.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html, headers: m.headers, attachments: m.attachments });
    },
  };
}
