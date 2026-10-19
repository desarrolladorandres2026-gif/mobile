// El tema se aplica antes del primer pintado. Si esperara a React (initTheme corre
// en un efecto, después de pintar), quien usa modo oscuro vería un destello blanco
// en cada carga. Misma lógica que stores/themeStore.ts: tema guardado, o el del
// sistema en "auto".
//
// Vive en su propio archivo y no en línea dentro de index.html para que la
// Content-Security-Policy del panel pueda exigir `script-src 'self'` sin
// 'unsafe-inline' (M-025). Se sirve del mismo origen y se carga de forma
// bloqueante, así que el comportamiento es idéntico.
(function () {
  try {
    var saved = localStorage.getItem('zipp_theme') || 'auto';
    var dark = saved === 'dark' || (saved === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {}
})();
