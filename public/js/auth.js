function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function initAuth(containerId) {
  const res = await fetch('/api/me');
  const { user } = await res.json();

  const el = document.getElementById(containerId);
  if (el) {
    if (user) {
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          ${user.avatar_url
            ? `<img src="${escHtml(user.avatar_url)}" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border)">`
            : `<div style="width:28px;height:28px;border-radius:50%;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff">${escHtml(user.name[0].toUpperCase())}</div>`}
          <span style="font-size:13px;color:var(--text-muted);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(user.name)}</span>
          <a href="/auth/logout" class="btn btn-sm" style="font-size:11px;padding:4px 8px">Sign out</a>
        </div>`;
    } else {
      el.innerHTML = `
        <a href="/auth/google" class="btn btn-sm" style="display:flex;align-items:center;gap:6px;font-size:12px">
          <svg width="14" height="14" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.3 13 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.8 37.1 46.5 31.3 46.5 24.5z"/><path fill="#FBBC05" d="M10.5 28.6A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.8-6A23.9 23.9 0 0 0 0 24c0 3.9.9 7.5 2.7 10.7l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.7 2.2-6.3 0-11.7-4.2-13.5-10l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>
          Sign in with Google
        </a>`;
    }
  }

  return user;
}
