/** The widget's self-contained script: a floating WhatsApp button for `number` (digits only). */
export function widgetScript(number: string): string {
  return `(function () {
  var s = document.currentScript;
  var d = (s && s.dataset) || {};
  if (window.__sandiaWidget) return;
  window.__sandiaWidget = true;
  var url = 'https://wa.me/' + ${JSON.stringify(number)} + (d.text ? '?text=' + encodeURIComponent(d.text) : '');
  var a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('aria-label', d.label || 'Escríbenos por WhatsApp');
  a.style.cssText = 'position:fixed;bottom:20px;' + (d.position === 'left' ? 'left' : 'right') + ':20px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:999px;background:' + (d.color || '#25D366') + ';color:#fff;font:600 15px/1 system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25)';
  a.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.8s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3z"/></svg>';
  if (d.label) { var t = document.createElement('span'); t.textContent = d.label; a.appendChild(t); }
  (document.body || document.documentElement).appendChild(a);
})();
`
}
