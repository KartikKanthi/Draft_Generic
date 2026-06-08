import nodemailer from 'nodemailer';

function createTransport() {
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  if (!user || !pass) return null;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user, pass },
  });
}

export async function sendPickNotification({ teamName, email, draftName, draftId, teamToken, deadlineHours, round, pickInRound }) {
  const transport = createTransport();
  if (!transport || !email) return;

  const base = process.env.BASE_URL || 'http://localhost:3000';
  const pickLink = `${base}/draft.html?id=${draftId}&token=${teamToken}`;
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER;

  const deadlineNote = deadlineHours > 0
    ? `You have <strong>${deadlineHours} hour${deadlineHours !== 1 ? 's' : ''}</strong> to pick. If time runs out an auto-pick will be made for you.`
    : '';
  const deadlineText = deadlineHours > 0
    ? `You have ${deadlineHours} hour${deadlineHours !== 1 ? 's' : ''} to pick. Auto-pick fires if time runs out.`
    : '';

  const pickLabel = round ? `Round ${round}, Pick ${pickInRound}` : '';

  try {
    await transport.sendMail({
      from,
      to: email,
      subject: `⏰ Your turn to pick — ${draftName}`,
      text: [
        `Hi ${teamName},`,
        '',
        `It's your turn to pick in ${draftName}!`,
        pickLabel,
        deadlineText,
        '',
        `Make your pick here: ${pickLink}`,
        '',
        '— Fantasy Draft',
      ].filter(Boolean).join('\n'),
      html: `
        <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#4F8EF7;margin-top:0">⏰ Your turn to pick!</h2>
          <p>Hi <strong>${teamName}</strong>,</p>
          <p>It's your turn in <strong>${draftName}</strong>.${pickLabel ? ` <span style="color:#888">(${pickLabel})</span>` : ''}</p>
          ${deadlineNote ? `<p style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;color:#92400e">${deadlineNote}</p>` : ''}
          <a href="${pickLink}" style="display:inline-block;background:#4F8EF7;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin-top:8px">Make Your Pick →</a>
          <p style="color:#aaa;font-size:11px;margin-top:28px">Fantasy Draft App · <a href="${pickLink}" style="color:#aaa">${pickLink}</a></p>
        </div>
      `,
    });
  } catch (err) {
    console.error('[email] Failed to send pick notification:', err.message);
  }
}

export async function sendDraftStartedNotification({ teamName, email, draftName, draftId, teamToken, deadlineHours, round, pickInRound, isFirst }) {
  const transport = createTransport();
  if (!transport || !email) return;

  const base = process.env.BASE_URL || 'http://localhost:3000';
  const pickLink = `${base}/draft.html?id=${draftId}&token=${teamToken}`;
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER;

  const subject = isFirst
    ? `🏁 Draft started — it's your pick first! (${draftName})`
    : `🏁 Draft started — ${draftName}`;

  const deadlineNote = isFirst && deadlineHours > 0
    ? `<p style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:10px 14px;color:#92400e">You're up first! You have <strong>${deadlineHours} hour${deadlineHours !== 1 ? 's' : ''}</strong> to make your pick.</p>`
    : '';

  try {
    await transport.sendMail({
      from,
      to: email,
      subject,
      html: `
        <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#4F8EF7;margin-top:0">🏁 The draft has started!</h2>
          <p>Hi <strong>${teamName}</strong>,</p>
          <p>The draft <strong>${draftName}</strong> has begun.</p>
          ${isFirst ? `<p style="color:#22c55e;font-weight:600">You have the first pick! (Round ${round}, Pick ${pickInRound})</p>` : ''}
          ${deadlineNote}
          <a href="${pickLink}" style="display:inline-block;background:#4F8EF7;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;margin-top:8px">${isFirst ? 'Make Your Pick →' : 'View the Draft →'}</a>
          <p style="color:#aaa;font-size:11px;margin-top:28px">Fantasy Draft App</p>
        </div>
      `,
    });
  } catch (err) {
    console.error('[email] Failed to send draft-started notification:', err.message);
  }
}
