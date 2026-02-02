// src/lib/loadScripts.js
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    // evita duplicar
    const exists = document.querySelector(`script[data-dyn="${src}"]`);
    if (exists) return resolve(true);

    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.defer = true;
    s.dataset.dyn = src;
    s.onload = () => resolve(true);
    s.onerror = (e) => reject(e);
    document.head.appendChild(s);
  });
}
