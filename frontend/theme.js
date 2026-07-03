(function () {
  const STORAGE_KEY = 'cfqd-theme';

  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function getTheme() {
    return localStorage.getItem(STORAGE_KEY) || getSystemTheme();
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    updateToggleButton(theme);
  }

  function updateToggleButton(theme) {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const isDark = theme === 'dark';
    btn.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.innerHTML = isDark
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
      : '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  function createToggleButton() {
    if (document.getElementById('theme-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'theme-toggle';
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', toggleTheme);
    document.body.appendChild(btn);
    updateToggleButton(getTheme());
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || getTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }

  function initTheme() {
    applyTheme(getTheme());
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', createToggleButton);
    } else {
      createToggleButton();
    }

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }

  initTheme();
  window.CFQDTheme = { toggleTheme, getTheme, applyTheme };
})();
