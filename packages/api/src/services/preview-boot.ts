/** Polling document shown while a project's dev server is starting. */
export function previewBootHtml(
  port: number,
  capability: string,
  statusUrl = `/api/preview-status?port=${port}&cap=${encodeURIComponent(capability)}`,
  credentials: "omit" | "include" = "omit",
  editorUrl = "",
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Starting preview…</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #fafafa; font-family: -apple-system, system-ui, sans-serif; color: #525252; }
  .wrap { display: flex; align-items: center; justify-content: center; height: 100%; padding: 24px; }
  .card { width: 100%; max-width: 360px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 22px; color: #262626; text-align: center; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .step { display: flex; align-items: center; gap: 12px; font-size: 13px; line-height: 1.4; transition: color .25s, opacity .25s; color: #a3a3a3; opacity: 0.6; }
  .step.active { color: #262626; opacity: 1; }
  .step.done { color: #525252; opacity: 1; }
  .step.failed { color: #b91c1c; opacity: 1; }
  .bullet { width: 18px; height: 18px; flex-shrink: 0; position: relative; }
  .bullet > * { position: absolute; inset: 0; margin: auto; display: none; }
  .bullet .dot { width: 6px; height: 6px; border-radius: 50%; background: #d4d4d4; display: block; }
  .bullet .spinner { width: 14px; height: 14px; border: 2px solid #e5e5e5; border-top-color: #262626; border-radius: 50%; animation: spin 0.9s linear infinite; box-sizing: border-box; }
  .bullet .check, .bullet .x { width: 18px; height: 18px; }
  .bullet .check { color: #22c55e; }
  .bullet .x { color: #ef4444; }
  .step.active .dot, .step.done .dot, .step.failed .dot { display: none; }
  .step.active .spinner { display: block; }
  .step.done .check { display: block; }
  .step.failed .x { display: block; }
  .detail { margin: 22px 0 0; font-size: 12px; line-height: 1.5; color: #a3a3a3; text-align: center; min-height: 1.2em; }
  .retry { display: block; margin: 22px auto 0; padding: 8px 18px; font-size: 12px; font-weight: 500; background: #262626; color: white; border: none; border-radius: 8px; cursor: pointer; }
  .retry:hover { background: #525252; }
  .hidden { display: none !important; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1 id="label">Starting your preview</h1>
    <ul class="steps">
      <li class="step" data-stage="cloning">
        <span class="bullet">
          <span class="dot"></span><span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        Fetching your site files
      </li>
      <li class="step" data-stage="installing">
        <span class="bullet">
          <span class="dot"></span><span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        Setting things up (one-time, can take a minute)
      </li>
      <li class="step" data-stage="starting">
        <span class="bullet">
          <span class="dot"></span><span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        Opening your preview
      </li>
    </ul>
    <p class="detail" id="detail">Getting things ready…</p>
    <button id="retry" class="retry hidden">Retry</button>
  </div>
</div>
<script>
(function() {
  var stages = ['cloning', 'installing', 'starting', 'ready'];
  var steps = document.querySelectorAll('.step');
  var currentStage = '';
  var stagePolls = 0;
  var pollTimer = 0;
  var stopped = false;
  var errored = false;
  var failedPolls = 0;
  var maxFailedPolls = 5;
  var editorUrl = ${JSON.stringify(editorUrl)};
  var retryNonce = '';
  try {
    retryNonce = new URL(window.location.href).searchParams.get('__quillra_parent') || '';
  } catch (_) {}

  function setStage(stage) {
    if (errored) return;
    var idx = stages.indexOf(stage);
    if (idx === -1) idx = 0;
    steps.forEach(function(s) {
      var sIdx = stages.indexOf(s.dataset.stage);
      s.classList.remove('active', 'done', 'failed');
      if (sIdx < idx) s.classList.add('done');
      else if (sIdx === idx) s.classList.add('active');
    });
  }

  function showError(label, detail) {
    if (errored) return;
    errored = true;
    stopPolling();
    document.getElementById('label').textContent = label || 'Preview unavailable';
    document.getElementById('detail').textContent = detail || 'Something went wrong while starting your preview.';
    var retry = document.getElementById('retry');
    retry.textContent = window.parent === window && editorUrl ? 'Return to Quillra' : 'Retry';
    retry.classList.remove('hidden');
    var active = document.querySelector('.step.active');
    if (active) {
      active.classList.remove('active');
      active.classList.add('failed');
    } else {
      steps[steps.length - 1].classList.add('failed');
    }
  }

  function showSlow(stage, detail) {
    if (errored) return;
    document.getElementById('label').textContent =
      stage === 'installing' ? 'Still setting things up' : 'Still starting your preview';
    document.getElementById('detail').textContent =
      detail || 'The first setup can take a few minutes. This page will open automatically when it is ready.';
  }

  function recordPollFailure() {
    if (stopped || errored) return;
    failedPolls++;
    if (failedPolls >= maxFailedPolls) {
      showError(
        'Preview status unavailable',
        'Quillra could not check the preview status. Check your connection and try again.'
      );
    }
  }

  function retryPreview() {
    if (!errored) return;
    if (!window.parent || window.parent === window || typeof window.parent.postMessage !== 'function') {
      if (editorUrl) {
        window.location.assign(editorUrl);
        return;
      }
      window.location.reload();
      return;
    }
    errored = false;
    stopped = false;
    failedPolls = 0;
    stagePolls = 0;
    document.getElementById('retry').classList.add('hidden');
    document.getElementById('label').textContent = 'Retrying your preview';
    document.getElementById('detail').textContent = 'Asking Quillra to start a fresh preview…';
    setStage(currentStage || 'cloning');
    window.parent.postMessage({ type: 'quillra:retry-preview', nonce: retryNonce }, '*');
    pollTimer = setTimeout(function() {
      pollTimer = 0;
      tick();
    }, 750);
  }

  function stopPolling() {
    stopped = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = 0; }
  }

  function scheduleNextPoll() {
    if (stopped) return;
    var delay = stagePolls >= 30 ? 5000 : 1500;
    pollTimer = setTimeout(function() {
      pollTimer = 0;
      tick();
    }, delay);
  }

  function tick() {
    if (stopped) return;
    fetch(${JSON.stringify(statusUrl)}, { credentials: ${JSON.stringify(credentials)} })
      .then(function(r) {
        if (!r.ok) throw new Error('Preview status request failed');
        return r.json();
      })
      .then(function(data) {
        if (stopped) return;
        failedPolls = 0;
        if (data.stage === 'error') {
          showError(data.label, data.detail);
          return;
        }
        if (data.stage !== currentStage) {
          currentStage = data.stage;
          stagePolls = 0;
        }
        stagePolls++;
        setStage(data.stage);
        if (data.stage === 'ready') {
          stopPolling();
          steps.forEach(function(s) { s.classList.remove('active', 'failed'); s.classList.add('done'); });
          setTimeout(function() {
            try {
              var nextUrl = new URL(window.location.href);
              nextUrl.searchParams.delete('__quillra_parent');
              window.location.replace(nextUrl.toString());
            } catch (_) {
              window.location.reload();
            }
          }, 400);
        } else if (stagePolls >= 30) {
          // A slow package install is not a failure. The backend lifecycle is
          // authoritative, so keep polling until it reports ready or error.
          showSlow(data.stage, data.detail);
        } else {
          if (data.label) document.getElementById('label').textContent = data.label;
          if (data.detail) document.getElementById('detail').textContent = data.detail;
        }
      })
      .catch(recordPollFailure)
      .then(scheduleNextPoll);
  }
  document.getElementById('retry').onclick = retryPreview;
  tick();
})();
</script>
</body>
</html>`;
}
