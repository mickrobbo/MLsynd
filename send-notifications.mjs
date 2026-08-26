// netlify/functions/send-notifications.mjs
//
// Migrated to the modern Netlify Functions format (ES Modules, Request/
// Response). Business logic (the per-recipient Resend email loop, the
// HTML template, the partial-success accounting) is untouched from the
// original — only the request-in/response-out shape changed:
// event.httpMethod -> request.method, event.body -> await request.text()
// (parsed the same way, same try/catch around the JSON.parse).
//
// .mjs extension required for ES Module syntax to work without needing
// a project-wide package.json change that would affect every other
// still-CommonJS function.
//
// Sends one personalized email per member summarizing their result for a given week.
// Triggered manually from the ledger's "Send notifications" button — never automatic.
//
// Expects a POST body of:
// {
//   weekLabel: "Week 30",
//   recipients: [
//     { name: "BILLY", email: "billy@example.com", summary: "You won $186.36 on your individual bet (Billy vs Josh)." },
//     ...
//   ]
// }
//
// Requires RESEND_API_KEY set as a Netlify environment variable.

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY is not configured on the server.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let payload;
  try {
    const rawBody = await request.text();
    payload = JSON.parse(rawBody || '{}');
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { weekLabel, recipients } = payload;
  if (!weekLabel || !Array.isArray(recipients) || recipients.length === 0) {
    return new Response(JSON.stringify({ error: 'weekLabel and a non-empty recipients array are required.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // FROM_EMAIL must be on a domain you've verified in Resend. Using their shared
  // test domain (onboarding@resend.dev) works immediately but only delivers to the
  // email address you signed up to Resend with — fine for testing, not for the group.
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'MLSynd Ledger <onboarding@resend.dev>';

  const results = [];
  for (const r of recipients) {
    if (!r.email || !r.name) {
      results.push({ name: r.name || '(unknown)', ok: false, error: 'Missing name or email' });
      continue;
    }
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromEmail,
          to: r.email,
          subject: `MLSynd — ${weekLabel} result`,
          html: `
            <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
              <h2 style="color:#0B2B22;">MLSynd Ledger — ${escapeHtml(weekLabel)}</h2>
              <p>Hi ${escapeHtml(r.name)},</p>
              <p>${escapeHtml(r.summary || 'This week\'s results are in.')}</p>
              <p style="color:#888; font-size:12px; margin-top:24px;">Sent from the MLSynd Ledger app.</p>
            </div>
          `
        })
      });
      if (res.ok) {
        results.push({ name: r.name, ok: true });
      } else {
        const errText = await res.text();
        results.push({ name: r.name, ok: false, error: errText });
      }
    } catch (err) {
      results.push({ name: r.name, ok: false, error: err.message });
    }
  }

  const failures = results.filter(r => !r.ok);
  return new Response(JSON.stringify({ sent: results.length - failures.length, failed: failures.length, results }), {
    status: failures.length ? 207 : 200, // 207: partial success
    headers: { 'Content-Type': 'application/json' }
  });
};
