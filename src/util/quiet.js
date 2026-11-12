// Hide the one-line "SQLite is an experimental feature" warning; keep every other warning.
const listeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w?.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
  if (listeners.length) listeners.forEach((l) => l(w));
  else console.warn(`${w.name}: ${w.message}`);
});
