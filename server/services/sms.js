function cleanPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return `+${raw.slice(1).replace(/\D/g, '')}`;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export async function sendSms({ to, body }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const normalizedTo = cleanPhone(to);

  if (!normalizedTo) {
    return { ok: false, skipped: true, error: 'Invalid phone number' };
  }
  if (!accountSid || !authToken || !from) {
    console.warn('SMS not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.');
    return { ok: false, skipped: true, error: 'SMS provider not configured' };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const form = new URLSearchParams();
  form.set('From', from);
  form.set('To', normalizedTo);
  form.set('Body', String(body || '').slice(0, 1400));

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data && data.message ? data.message : `Twilio error ${resp.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, sid: data.sid };
}

