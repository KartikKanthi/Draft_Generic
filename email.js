const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

function getSender() {
  const email = process.env.EMAIL_FROM_ADDRESS || process.env.EMAIL_USER || 'noreply@example.com';
  const name = process.env.EMAIL_FROM_NAME || 'Fantasy Draft';
  return { name, email };
}

async function sendBrevo({ to, subject, html, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[email] BREVO_API_KEY not set — notifications disabled');
    return { ok: false, error: 'BREVO_API_KEY not configured' };
  }

  try {
    const res = await fetch(BREVO_API, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: getSender(),
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.message || `HTTP ${res.status}`;
      console.error('[email] Brevo error:', msg);
      return { ok: false, error: msg };
    }

    return { ok: true };
  } catch (err) {
    console.error('[email] Brevo request failed:', err.message);
    return { ok: false, error: err.message };
  }
}

export async function sendTestEmail(to) {
  const result = await sendBrevo({
    to,
    subject: '✅ Fantasy Draft — email test',
    text: 'Your email notifications are working correctly.',
    html: `<div style="font-family:sans-serif;padding:24px"><h2 style="color:#4F8EF7">✅ Email is working!</h2><p>Your Fantasy Draft notification emails are configured correctly.</p></div>`,
  });
  if (result.ok) console.log(`[email] Test email sent to ${to}`);
  return result;
}

export async function sendPickNotification({ teamName, email, draftName, draftId, teamToken, deadlineHours, round, pickInRound }) {
  if (!email) return;

  const base = process.env.BASE_URL || 'http://localhost:3000';
  const pickLink = `${base}/draft.html?id=${draftId}&token=${teamToken}`;
  const pickLabel = round ? `Round ${round}, Pick ${pickInRound}` : '';
  const deadlineNote = deadlineHours > 0
    ? `<p style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;color:#92400e">You have <strong>${deadlineHours} hour${deadlineHours !== 1 ? 's' : ''}</strong> to pick. An auto-pick will be made if time runs out.</p>`
    : '';
  const deadlineText = deadlineHours > 0
    ? `You have ${deadlineHours} hour${deadlineHours !== 1 ? 's' : ''} to pick. Auto-pick fires if time runs out.`
    : '';

  await sendBrevo({
    to: email,
    subject: `⏰ Your turn to pick — ${draftName}`,
    text: [`Hi ${teamName},`, '', `It's your turn to pick in ${draftName}!`, pickLabel, deadlineText, '', `Make your pick: ${pickLink}`, '', '— Fantasy Draft'].filter(Boolean).join('\n'),
    html: `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#4F8EF7;margin-top:0">⏰ Your turn to pick!</h2>
        <p>Hi <strong>${teamName}</strong>,</p>
        <p>It's your turn in <strong>${draftName}</strong>.${pickLabel ? ` <span style="color:#888">(${pickLabel})</span>` : ''}</p>
        ${deadlineNote}
        <a href="${pickLink}" style="display:inline-block;background:#4F8EF7;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin-top:8px">Make Your Pick →</a>
        <p style="color:#aaa;font-size:11px;margin-top:28px">Fantasy Draft App · <a href="${pickLink}" style="color:#aaa">${pickLink}</a></p>
      </div>`,
  });
}

export async function sendDraftStartedNotification({ teamName, email, draftName, draftId, teamToken, deadlineHours, round, pickInRound, isFirst }) {
  if (!email) return;

  const base = process.env.BASE_URL || 'http://localhost:3000';
  const pickLink = `${base}/draft.html?id=${draftId}&token=${teamToken}`;
  const subject = isFirst
    ? `🏁 Draft started — it's your pick first! (${draftName})`
    : `🏁 Draft started — ${draftName}`;
  const deadlineNote = isFirst && deadlineHours > 0
    ? `<p style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;color:#92400e">You're up first! You have <strong>${deadlineHours} hour${deadlineHours !== 1 ? 's' : ''}</strong> to make your pick.</p>`
    : '';

  await sendBrevo({
    to: email,
    subject,
    html: `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="color:#4F8EF7;margin-top:0">🏁 The draft has started!</h2>
        <p>Hi <strong>${teamName}</strong>,</p>
        <p>The draft <strong>${draftName}</strong> has begun.</p>
        ${isFirst ? `<p style="color:#22c55e;font-weight:600">You have the first pick!${round ? ` (Round ${round}, Pick ${pickInRound})` : ''}</p>` : ''}
        ${deadlineNote}
        <a href="${pickLink}" style="display:inline-block;background:#4F8EF7;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin-top:8px">${isFirst ? 'Make Your Pick →' : 'View the Draft →'}</a>
        <p style="color:#aaa;font-size:11px;margin-top:28px">Fantasy Draft App</p>
      </div>`,
  });
}
