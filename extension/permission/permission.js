// One visible getUserMedia call so Chrome can show its prompt. The stream is
// stopped immediately; the only thing we want is the remembered grant.
const status = document.getElementById('status');
const btn = document.getElementById('ask');

async function paint() {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    if (p.state === 'granted') { status.textContent = 'granted - you can close this tab'; status.className = 'ok'; btn.disabled = true; }
    else if (p.state === 'denied') { status.textContent = 'blocked - click the icon left of the address bar and allow the microphone, then reload'; status.className = 'bad'; }
    else { status.textContent = 'not asked yet'; status.className = ''; }
    p.onchange = paint;
  } catch { /* permissions.query unsupported: the button still works */ }
}

btn.addEventListener('click', async () => {
  status.textContent = 'asking…'; status.className = '';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    status.textContent = 'granted - you can close this tab'; status.className = 'ok'; btn.disabled = true;
  } catch (e) {
    status.textContent = `${e.name}: ${e.message}`; status.className = 'bad';
  }
});

paint();
