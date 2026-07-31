/**
 * Frontend example — call this from your Vercel-hosted site.
 * Works from plain HTML/JS, no build step or library required.
 */

// Paste the Web App URL you get after deploying Code.gs (ends in /exec)
const SCRIPT_URL = 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec';

async function registerUser({ name, email, task }) {
  try {
    const response = await fetch(SCRIPT_URL, {
      method: 'POST',
      // IMPORTANT: use text/plain, not application/json.
      // Apps Script Web Apps don't handle CORS preflight (OPTIONS) requests.
      // Sending text/plain keeps this a "simple request" so the browser
      // skips the preflight and the request goes straight through.
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify({ name, email, task }),
    });

    const result = await response.json();

    if (!result.success) {
      // e.g. "This email is already registered."
      throw new Error(result.error || 'Registration failed.');
    }

    return result; // { success: true, group: "B" }
  } catch (err) {
    console.error('Registration error:', err);
    throw err;
  }
}

// --- Example usage wired to a form ---
document.getElementById('registration-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('name').value;
  const email = document.getElementById('email').value;
  const task = document.getElementById('task')?.value || '';

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const result = await registerUser({ name, email, task });
    alert(`You're registered! You've been assigned to Group ${result.group}.`);
    e.target.reset();
  } catch (err) {
    alert(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Register';
  }
});
