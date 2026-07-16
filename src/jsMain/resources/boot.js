(function () {
  // Fallback splash removal — Main.kt removes #boot-splash as soon as
  // ComposeViewport mounts; this covers the app somehow skipping that path.
  document.getElementById('boot-splash')?.remove();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('service-worker.js').catch(function () { /* ignore */ });
    });
  }
})();
