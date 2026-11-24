'use strict';

// Netlify Function: receives the portfolio contact form and emails it to the
// site owner through the Resend API. All secrets come from environment
// variables (set in the Netlify dashboard), never from the frontend code.

const LIMITS = { name: 80, email: 120, subject: 120, message: 2000 };
const MAX_BODY_BYTES = 10000;
const MIN_FILL_MS = 2000; // a real person needs a moment to fill the form
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const reply = (statusCode, body, extra) => ({
  statusCode,
  headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra),
  body: JSON.stringify(body),
});
const GENERIC_ERROR = 'Sorry, your message could not be sent. Please try again later.';

// Remove control characters; keep text within the limit. Returns undefined if invalid.
function field(value, max, multiline) {
  if (typeof value !== 'string') return undefined;
  let s = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, '');
  s = multiline ? s.replace(/\r\n?/g, '\n') : s.replace(/\s+/g, ' ');
  s = s.trim();
  return s.length <= max ? s : undefined;
}

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return reply(405, { ok: false, message: 'Method not allowed.' }, { Allow: 'POST' });
  }

  // Only accept requests that come from this same website.
  const headers = event.headers || {};
  if (headers.origin) {
    try {
      if (new URL(headers.origin).host !== headers.host) return reply(403, { ok: false, message: 'Request not allowed.' });
    } catch (e) {
      return reply(403, { ok: false, message: 'Request not allowed.' });
    }
  }
  if (!String(headers['content-type'] || '').includes('application/json')) {
    return reply(415, { ok: false, message: 'Unsupported request.' });
  }

  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf8');
  if (raw.length > MAX_BODY_BYTES) return reply(413, { ok: false, message: 'Your message is too large.' });

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return reply(400, { ok: false, message: 'Invalid request.' });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return reply(400, { ok: false, message: 'Invalid request.' });

  // Spam protection: hidden honeypot field and a minimum fill time.
  // Bots get a fake "success" so they learn nothing.
  if (typeof data['bot-field'] === 'string' && data['bot-field'].trim() !== '') return reply(200, { ok: true });
  if (!(Number(data.t) >= MIN_FILL_MS)) return reply(200, { ok: true });

  const name = field(data.name, LIMITS.name, false);
  const email = field(data.email, LIMITS.email, false);
  const subject = field(data.subject, LIMITS.subject, false);
  const message = field(data.message, LIMITS.message, true);

  if (name === undefined || email === undefined || subject === undefined || message === undefined) {
    return reply(400, { ok: false, message: 'One of the fields is too long or invalid.' });
  }
  if (!name || !email || !subject || !message) return reply(400, { ok: false, message: 'Please fill in all fields.' });
  if (!EMAIL_RE.test(email)) return reply(400, { ok: false, message: 'Please enter a valid email address.' });

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL;
  const from = process.env.CONTACT_FROM_EMAIL || 'Portfolio Contact <onboarding@resend.dev>';
  if (!apiKey || !to) {
    console.error('Contact form is not configured: missing environment variables.');
    return reply(500, { ok: false, message: GENERIC_ERROR });
  }

  const text = 'New message from your portfolio website\n\nName: ' + name + '\nEmail: ' + email + '\nSubject: ' + subject + '\n\nMessage:\n' + message + '\n';
  const html =
    '<h2>New message from your portfolio website</h2>' +
    '<p><strong>Name:</strong> ' + escapeHtml(name) + '<br>' +
    '<strong>Email:</strong> ' + escapeHtml(email) + '<br>' +
    '<strong>Subject:</strong> ' + escapeHtml(subject) + '</p>' +
    '<p><strong>Message:</strong></p>' +
    '<p style="white-space:pre-wrap">' + escapeHtml(message) + '</p>';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: email, subject: 'Portfolio message: ' + subject, text, html }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error('Email provider returned status ' + res.status); // status only, never the key or message
      return reply(502, { ok: false, message: GENERIC_ERROR });
    }
    return reply(200, { ok: true, message: 'Thank you! Your message was sent.' });
  } catch (e) {
    console.error('Email request failed.');
    return reply(502, { ok: false, message: GENERIC_ERROR });
  } finally {
    clearTimeout(timer);
  }
};
