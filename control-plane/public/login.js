// control-plane/public/login.js - dashboard sign-in (AC-CTRL-001). No inline script: CSP script-src 'self'.
'use strict';

document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = document.getElementById('login-error');
    const button = form.querySelector('button');
    error.hidden = true;
    button.disabled = true;
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username: form.username.value, password: form.password.value }),
        });
        if (res.ok) {
            window.location.assign('/');
            return;
        }
        const body = await res.json().catch(() => ({}));
        const retry = res.headers.get('Retry-After');
        error.textContent = res.status === 429 && retry
            ? `Too many failed attempts. Try again in ${Math.ceil(Number(retry) / 60)} minute(s).`
            : (body.error || 'Sign-in failed.');
        error.hidden = false;
        form.password.value = '';
    } catch {
        error.textContent = 'The dashboard is unreachable.';
        error.hidden = false;
    } finally {
        button.disabled = false;
    }
});
