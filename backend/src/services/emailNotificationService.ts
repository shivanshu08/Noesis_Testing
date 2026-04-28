import nodemailer, { SendMailOptions, Transporter } from 'nodemailer';
import { config } from '../config';
import { query } from '../database/connection';
import { logger } from '../utils/logger';

interface ExecutionEmailRecipientRow {
  id: number;
  email: string | null;
  full_name: string | null;
  username: string;
  role: string;
}

export interface ExecutionArtifactEmailAttachment {
  fileName: string;
  filePath: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface ExecutionArtifactsEmailPayload {
  runId: number;
  runName?: string | null;
  senderName?: string | null;
  recipients: string[];
  subject?: string | null;
  message?: string | null;
  attachments: ExecutionArtifactEmailAttachment[];
}

export interface ExecutionCompletionEmailPayload {
  runId: number;
  runName: string;
  finalStatus: 'passed' | 'failed' | 'error' | 'stopped' | string;
  environment?: string | null;
  triggeredByUserId: number;
  triggeredByName?: string | null;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  totalScripts: number;
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
}

let transporter: Transporter | null = null;

export function isMailConfigured(): boolean {
  return Boolean(config.mail.enabled && config.mail.host && config.mail.from);
}

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user
        ? {
            user: config.mail.user,
            pass: config.mail.password,
          }
        : undefined,
    });
  }

  return transporter;
}

function formatDate(value?: Date | string | null): string {
  if (!value) return 'Not available';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return date.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true,
  });
}

function formatDuration(durationMs?: number | null): string {
  if (!Number.isFinite(durationMs || NaN) || !durationMs) return 'Not available';
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return 'Unknown size';
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function buildRunUrl(runId: number): string | null {
  const base = String(config.mail.appBaseUrl || '').split(',')[0]?.trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/run/${runId}`;
}

async function getExecutionRecipients(triggeredByUserId: number): Promise<string[]> {
  const recipients = await query<ExecutionEmailRecipientRow>(
    `SELECT id, email, full_name, username, role
     FROM users
     WHERE is_active = TRUE
       AND email IS NOT NULL
       AND email <> ''
       AND (role IN ('admin', 'tester') OR id = $1)`,
    [triggeredByUserId]
  );

  return Array.from(
    new Set(
      recipients
        .map((recipient) => normalizeEmail(recipient.email || ''))
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )
  );
}

function buildSubject(payload: ExecutionCompletionEmailPayload): string {
  const status = payload.finalStatus === 'passed' ? 'PASSED' : 'FAILED';
  return `[Noesis] Script execution ${status}: ${payload.runName}`;
}

function buildText(payload: ExecutionCompletionEmailPayload, runUrl: string | null): string {
  const statusLine = payload.finalStatus === 'passed'
    ? 'The script execution passed successfully.'
    : 'The script execution failed or ended with errors.';

  return [
    statusLine,
    '',
    `Run: ${payload.runName} (#${payload.runId})`,
    `Status: ${payload.finalStatus.toUpperCase()}`,
    `Environment: ${payload.environment || 'local'}`,
    `Triggered by: ${payload.triggeredByName || `User ${payload.triggeredByUserId}`}`,
    `Started: ${formatDate(payload.startedAt)}`,
    `Completed: ${formatDate(payload.completedAt)}`,
    `Duration: ${formatDuration(payload.durationMs)}`,
    '',
    `Summary: ${payload.passed} passed, ${payload.failed} failed, ${payload.errors} errors, ${payload.skipped} skipped out of ${payload.totalScripts} script(s).`,
    payload.errorMessage ? `Error: ${payload.errorMessage}` : '',
    runUrl ? `View run details: ${runUrl}` : '',
  ].filter(Boolean).join('\n');
}

function buildHtml(payload: ExecutionCompletionEmailPayload, runUrl: string | null): string {
  const isPassed = payload.finalStatus === 'passed';
  const accent = isPassed ? '#16a34a' : '#dc2626';
  const label = isPassed ? 'Execution Passed' : 'Execution Failed';
  const lead = isPassed
    ? 'All selected scripts completed successfully.'
    : 'One or more scripts failed, errored, or the execution engine reported a failure.';

  const rows = [
    ['Run', `${payload.runName} (#${payload.runId})`],
    ['Status', payload.finalStatus.toUpperCase()],
    ['Environment', payload.environment || 'local'],
    ['Triggered by', payload.triggeredByName || `User ${payload.triggeredByUserId}`],
    ['Started', formatDate(payload.startedAt)],
    ['Completed', formatDate(payload.completedAt)],
    ['Duration', formatDuration(payload.durationMs)],
  ];

  return `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:680px;margin:0 auto;">
      <div style="border-left:6px solid ${accent};padding:18px 22px;background:#f9fafb;">
        <h2 style="margin:0 0 6px;font-size:22px;color:${accent};">${escapeHtml(label)}</h2>
        <p style="margin:0;color:#374151;">${escapeHtml(lead)}</p>
      </div>
      <table style="border-collapse:collapse;width:100%;margin-top:18px;font-size:14px;">
        ${rows.map(([key, value]) => `
          <tr>
            <td style="border:1px solid #e5e7eb;padding:10px 12px;background:#f9fafb;font-weight:700;width:160px;">${escapeHtml(key)}</td>
            <td style="border:1px solid #e5e7eb;padding:10px 12px;">${escapeHtml(value)}</td>
          </tr>
        `).join('')}
      </table>
      <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap;">
        <div style="padding:12px 14px;border:1px solid #dcfce7;background:#f0fdf4;"><strong>${payload.passed}</strong><br>Passed</div>
        <div style="padding:12px 14px;border:1px solid #fee2e2;background:#fef2f2;"><strong>${payload.failed}</strong><br>Failed</div>
        <div style="padding:12px 14px;border:1px solid #ffedd5;background:#fff7ed;"><strong>${payload.errors}</strong><br>Errors</div>
        <div style="padding:12px 14px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>${payload.skipped}</strong><br>Skipped</div>
      </div>
      ${payload.errorMessage ? `<p style="margin-top:18px;color:#991b1b;"><strong>Error:</strong> ${escapeHtml(payload.errorMessage)}</p>` : ''}
      ${runUrl ? `<p style="margin-top:22px;"><a href="${escapeHtml(runUrl)}" style="background:#111827;color:white;text-decoration:none;padding:10px 14px;border-radius:6px;display:inline-block;">View run details</a></p>` : ''}
      <p style="margin-top:24px;color:#6b7280;font-size:12px;">This message was sent automatically by Noesis Testing after script execution completed.</p>
    </div>
  `;
}

export async function sendExecutionCompletionEmail(payload: ExecutionCompletionEmailPayload): Promise<void> {
  if (!isMailConfigured()) {
    logger.info('Execution email notification skipped because mail is disabled or SMTP is not configured.');
    return;
  }

  try {
    const recipients = await getExecutionRecipients(payload.triggeredByUserId);
    if (recipients.length === 0) {
      logger.warn(`Execution email notification skipped for run ${payload.runId}: no admin/tester recipient emails found.`);
      return;
    }

    const runUrl = buildRunUrl(payload.runId);
    await getTransporter().sendMail({
      from: config.mail.from,
      to: recipients,
      subject: buildSubject(payload),
      text: buildText(payload, runUrl),
      html: buildHtml(payload, runUrl),
    });

    logger.info(`Execution email notification sent for run ${payload.runId} to ${recipients.length} recipient(s).`);
  } catch (error) {
    logger.error(`Execution email notification failed for run ${payload.runId}:`, error);
  }
}

function buildArtifactsSubject(payload: ExecutionArtifactsEmailPayload): string {
  if (payload.subject && payload.subject.trim()) {
    return payload.subject.trim();
  }
  return `[Noesis] Execution artifacts for ${payload.runName || `Run #${payload.runId}`}`;
}

function buildArtifactsText(payload: ExecutionArtifactsEmailPayload, runUrl: string | null): string {
  const attachmentLines = payload.attachments.map((attachment) => (
    `- ${attachment.fileName} (${formatBytes(attachment.sizeBytes)})`
  ));

  return [
    payload.message?.trim() || 'Execution artifacts are attached.',
    '',
    `Run: ${payload.runName || `Run #${payload.runId}`} (#${payload.runId})`,
    payload.senderName ? `Sent by: ${payload.senderName}` : '',
    `Attachments: ${payload.attachments.length}`,
    ...attachmentLines,
    '',
    runUrl ? `View run details: ${runUrl}` : '',
  ].filter(Boolean).join('\n');
}

function buildArtifactsHtml(payload: ExecutionArtifactsEmailPayload, runUrl: string | null): string {
  const attachmentRows = payload.attachments.map((attachment) => `
    <tr>
      <td style="border:1px solid #e5e7eb;padding:10px 12px;">${escapeHtml(attachment.fileName)}</td>
      <td style="border:1px solid #e5e7eb;padding:10px 12px;color:#4b5563;">${escapeHtml(attachment.mimeType || 'file')}</td>
      <td style="border:1px solid #e5e7eb;padding:10px 12px;color:#4b5563;">${escapeHtml(formatBytes(attachment.sizeBytes))}</td>
    </tr>
  `).join('');

  return `
    <div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:680px;margin:0 auto;">
      <div style="border-left:6px solid #2563eb;padding:18px 22px;background:#eff6ff;">
        <h2 style="margin:0 0 6px;font-size:22px;color:#1d4ed8;">Execution Artifacts</h2>
        <p style="margin:0;color:#374151;">${escapeHtml(payload.message?.trim() || 'Execution artifacts are attached for review.')}</p>
      </div>
      <table style="border-collapse:collapse;width:100%;margin-top:18px;font-size:14px;">
        <tr>
          <td style="border:1px solid #e5e7eb;padding:10px 12px;background:#f9fafb;font-weight:700;width:160px;">Run</td>
          <td style="border:1px solid #e5e7eb;padding:10px 12px;">${escapeHtml(payload.runName || `Run #${payload.runId}`)} (#${payload.runId})</td>
        </tr>
        ${payload.senderName ? `
        <tr>
          <td style="border:1px solid #e5e7eb;padding:10px 12px;background:#f9fafb;font-weight:700;width:160px;">Sent by</td>
          <td style="border:1px solid #e5e7eb;padding:10px 12px;">${escapeHtml(payload.senderName)}</td>
        </tr>
        ` : ''}
      </table>
      <h3 style="margin:20px 0 8px;font-size:16px;">Attached files</h3>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr>
            <th align="left" style="border:1px solid #e5e7eb;padding:10px 12px;background:#f9fafb;">File</th>
            <th align="left" style="border:1px solid #e5e7eb;padding:10px 12px;background:#f9fafb;">Type</th>
            <th align="left" style="border:1px solid #e5e7eb;padding:10px 12px;background:#f9fafb;">Size</th>
          </tr>
        </thead>
        <tbody>${attachmentRows}</tbody>
      </table>
      ${runUrl ? `<p style="margin-top:22px;"><a href="${escapeHtml(runUrl)}" style="background:#111827;color:white;text-decoration:none;padding:10px 14px;border-radius:6px;display:inline-block;">View run details</a></p>` : ''}
      <p style="margin-top:24px;color:#6b7280;font-size:12px;">This message was sent from Noesis Testing.</p>
    </div>
  `;
}

export async function sendExecutionArtifactsEmail(payload: ExecutionArtifactsEmailPayload): Promise<void> {
  if (!isMailConfigured()) {
    throw new Error('Mail is disabled or SMTP is not configured.');
  }

  const recipients = Array.from(
    new Set(
      payload.recipients
        .map((recipient) => normalizeEmail(recipient))
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )
  );
  if (recipients.length === 0) {
    throw new Error('At least one valid recipient email is required.');
  }
  if (payload.attachments.length === 0) {
    throw new Error('At least one artifact attachment is required.');
  }

  const runUrl = buildRunUrl(payload.runId);
  const attachments: SendMailOptions['attachments'] = payload.attachments.map((attachment) => ({
    filename: attachment.fileName,
    path: attachment.filePath,
    contentType: attachment.mimeType || undefined,
  }));

  await getTransporter().sendMail({
    from: config.mail.from,
    to: recipients,
    subject: buildArtifactsSubject(payload),
    text: buildArtifactsText(payload, runUrl),
    html: buildArtifactsHtml(payload, runUrl),
    attachments,
  });

  logger.info(`Execution artifacts email sent for run ${payload.runId} to ${recipients.length} recipient(s) with ${payload.attachments.length} attachment(s).`);
}
