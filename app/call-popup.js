const id = new URL(location.href).searchParams.get('id');
document.getElementById('service').textContent = new URL(location.href).searchParams.get('service') || 'Звонок';
document.getElementById('record').onclick = () => window.callPrompt.choose(id, true);
document.getElementById('skip').onclick = () => window.callPrompt.choose(id, false);
window.onkeydown = e => { if (e.key === 'Escape') window.callPrompt.choose(id, false); };
