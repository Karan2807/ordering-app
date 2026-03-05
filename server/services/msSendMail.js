import { getMsAccessToken } from './msToken.js';

function normalizeEmails(input) {
  const list = Array.isArray(input) ? input : [input];
  return [...new Set(
    list
      .flatMap((v) => String(v || '').split(/[,\n;]/))
      .map((v) => v.trim())
      .filter(Boolean)
  )];
}

function buildAttachments(attachments = []) {
  return attachments
    .filter((a) => a && a.filename && a.content)
    .map((a) => {
      const contentBytes = Buffer.isBuffer(a.content)
        ? a.content.toString('base64')
        : Buffer.from(a.content).toString('base64');
      return {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename,
        contentType: a.contentType || 'application/octet-stream',
        contentBytes,
      };
    });
}

export async function sendGraphMail({ to, subject, text, html, attachments = [] }) {
  const senderEmail = process.env.SENDER_EMAIL;
  if (!senderEmail) throw new Error('Missing required environment variable: SENDER_EMAIL');

  const recipients = normalizeEmails(to);
  if (!recipients.length) throw new Error('At least one recipient email is required');

  const token = await getMsAccessToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/sendMail`;

  const payload = {
    message: {
      subject: subject || 'No Subject',
      body: {
        contentType: html ? 'HTML' : 'Text',
        content: html || text || '',
      },
      toRecipients: recipients.map((email) => ({
        emailAddress: { address: email },
      })),
    },
    saveToSentItems: true,
  };

  const graphAttachments = buildAttachments(attachments);
  if (graphAttachments.length) {
    payload.message.attachments = graphAttachments;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Microsoft Graph sendMail failed (${resp.status}): ${errText}`);
  }

  return { success: true, to: recipients };
}

