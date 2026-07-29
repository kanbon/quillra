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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting preview…</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; background: #f7f7f6; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #262626; }
  body { min-height: 100vh; min-height: 100dvh; }
  button { font: inherit; }
  .wrap { min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: clamp(20px, 5vw, 56px); }
  .card { width: min(100%, 430px); padding: clamp(24px, 5vw, 38px); border: 1px solid #e7e5e4; border-radius: 24px; background: rgba(255,255,255,.94); box-shadow: 0 20px 60px rgba(28,25,23,.08), 0 2px 8px rgba(28,25,23,.04); }
  .eyebrow { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 17px; color: #78716c; font-size: 11px; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; }
  .signal { width: 7px; height: 7px; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 4px #dcfce7; }
  h1 { margin: 0; text-align: center; color: #1c1917; font-size: clamp(20px, 5vw, 25px); font-weight: 690; letter-spacing: -.025em; line-height: 1.18; }
  .warm-state { display: flex; flex-direction: column; align-items: center; margin-top: 28px; }
  .preview-mark { position: relative; width: 74px; height: 58px; display: grid; place-items: center; border: 1px solid #e7e5e4; border-radius: 15px; background: #fafaf9; box-shadow: inset 0 0 0 4px #fff; color: #78716c; }
  .preview-mark svg { width: 34px; height: 34px; }
  .pulse { position: absolute; right: -3px; bottom: -3px; width: 15px; height: 15px; border: 3px solid #fff; border-radius: 999px; background: #dc2626; animation: breathe 1.45s ease-in-out infinite; }
  .warm-state.ready .pulse { background: #22c55e; animation: none; }
  .warm-state.failed .pulse { background: #ef4444; animation: none; }
  .rail { position: relative; width: min(100%, 250px); height: 4px; margin-top: 25px; overflow: hidden; border-radius: 999px; background: #e7e5e4; }
  .rail::after { content: ""; position: absolute; inset: 0; width: 42%; border-radius: inherit; background: #292524; animation: travel 1.15s cubic-bezier(.4,0,.2,1) infinite; }
  .warm-state.ready .rail::after { width: 100%; animation: none; background: #22c55e; }
  .warm-state.failed .rail::after { width: 100%; animation: none; background: #ef4444; }
  .steps { list-style: none; margin: 28px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .step { display: grid; grid-template-columns: 28px minmax(0,1fr); align-items: center; gap: 11px; min-height: 44px; padding: 8px 10px; border-radius: 12px; color: #a8a29e; font-size: 13px; line-height: 1.35; transition: color .2s ease, background .2s ease, opacity .2s ease; opacity: .72; }
  .step.active { color: #292524; background: #f5f5f4; opacity: 1; }
  .step.done { color: #57534e; opacity: 1; }
  .step.failed { color: #b91c1c; background: #fef2f2; opacity: 1; }
  .bullet { position: relative; width: 22px; height: 22px; display: grid; place-items: center; }
  .bullet > * { position: absolute; display: none; }
  .bullet .dot { display: block; width: 6px; height: 6px; border-radius: 999px; background: #d6d3d1; }
  .bullet .spinner { width: 16px; height: 16px; border: 2px solid #d6d3d1; border-top-color: #292524; border-radius: 999px; animation: spin .85s linear infinite; }
  .bullet .check, .bullet .x { width: 19px; height: 19px; }
  .bullet .check { color: #16a34a; }
  .bullet .x { color: #dc2626; }
  .step.active .dot, .step.done .dot, .step.failed .dot { display: none; }
  .step.active .spinner, .step.done .check, .step.failed .x { display: block; }
  .detail { margin: 22px auto 0; max-width: 330px; min-height: 2.8em; color: #78716c; font-size: 13px; line-height: 1.55; text-align: center; text-wrap: balance; }
  .retry { display: block; min-width: 118px; margin: 22px auto 0; padding: 10px 18px; border: 0; border-radius: 10px; background: #292524; color: #fff; cursor: pointer; font-size: 13px; font-weight: 650; box-shadow: 0 4px 12px rgba(28,25,23,.14); transition: transform .15s ease, background .15s ease; }
  .retry:hover { background: #44403c; transform: translateY(-1px); }
  .retry:focus-visible { outline: 3px solid rgba(220,38,38,.22); outline-offset: 3px; }
  .hidden { display: none !important; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes breathe { 0%,100% { transform: scale(.78); opacity: .65; } 50% { transform: scale(1); opacity: 1; } }
  @keyframes travel { 0% { transform: translateX(-120%); } 100% { transform: translateX(340%); } }
  @media (max-width: 520px) {
    .wrap { align-items: center; padding: 16px; }
    .card { border-radius: 20px; padding: 25px 20px; }
    .steps { margin-top: 22px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .001ms !important; }
  }
</style>
</head>
<body>
<main class="wrap">
  <section class="card" aria-labelledby="label" aria-describedby="detail">
    <div class="eyebrow"><span class="signal" aria-hidden="true"></span>Secure live preview</div>
    <h1 id="label" aria-live="polite">Waking your preview</h1>
    <div id="warm-state" class="warm-state" aria-hidden="true">
      <div class="preview-mark">
        <svg fill="none" viewBox="0 0 32 32" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <rect x="4.5" y="6.5" width="23" height="19" rx="4"></rect>
          <path d="M5 11h22M9 9h.01M12 9h.01"></path>
          <path d="M11 18.5l3 2.5 6-6"></path>
        </svg>
        <span class="pulse"></span>
      </div>
      <div class="rail" aria-hidden="true"></div>
    </div>
    <ul id="cold-steps" class="steps hidden">
      <li class="step" data-stage="cloning">
        <span class="bullet">
          <span class="dot"></span><span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        <span>Fetching your site files</span>
      </li>
      <li class="step" data-stage="installing">
        <span class="bullet">
          <span class="dot"></span><span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        <span>Installing this project's tools</span>
      </li>
      <li class="step" data-stage="starting">
        <span class="bullet">
          <span class="dot"></span><span class="spinner"></span>
          <svg class="check" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          <svg class="x" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </span>
        <span>Opening your preview</span>
      </li>
    </ul>
    <p class="detail" id="detail" aria-live="polite">This prepared project should be ready in a moment.</p>
    <button id="retry" class="retry hidden">Retry</button>
  </section>
</main>
<script>
(function() {
  var stages = ['cloning', 'installing', 'starting', 'ready'];
  var steps = document.querySelectorAll('.step');
  var warmState = document.getElementById('warm-state');
  var coldSteps = document.getElementById('cold-steps');
  var currentMode = '';
  var currentStage = '';
  var currentStageIndex = -1;
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

  function modeFor(stage, requestedMode) {
    if (requestedMode === 'cold' || requestedMode === 'warm') return requestedMode;
    if (currentMode === 'cold') return 'cold';
    return stage === 'cloning' || stage === 'installing' ? 'cold' : 'warm';
  }

  function setMode(nextMode) {
    if (nextMode === currentMode) return;
    currentMode = nextMode;
    currentStage = '';
    currentStageIndex = -1;
    stagePolls = 0;
    warmState.classList.remove('ready', 'failed');
    if (nextMode === 'cold') {
      warmState.classList.add('hidden');
      coldSteps.classList.remove('hidden');
    } else {
      warmState.classList.remove('hidden');
      coldSteps.classList.add('hidden');
      document.getElementById('label').textContent = 'Waking your preview';
    }
  }

  function setStage(stage, requestedMode) {
    if (errored) return false;
    setMode(modeFor(stage, requestedMode));
    var idx = stages.indexOf(stage);
    if (idx === -1) idx = 0;
    if (idx < currentStageIndex) return false;
    if (idx > currentStageIndex) {
      currentStageIndex = idx;
      currentStage = stages[idx];
      stagePolls = 0;
    }
    if (currentMode === 'warm') {
      warmState.classList.remove('failed');
      if (currentStage === 'ready') warmState.classList.add('ready');
      return true;
    }
    steps.forEach(function(s) {
      var sIdx = stages.indexOf(s.dataset.stage);
      s.classList.remove('active', 'done', 'failed');
      if (sIdx < currentStageIndex) s.classList.add('done');
      else if (sIdx === currentStageIndex) s.classList.add('active');
    });
    return true;
  }

  function showError(label, detail) {
    if (errored) return;
    errored = true;
    stopPolling();
    document.getElementById('label').textContent = label || 'Preview unavailable';
    document.getElementById('detail').textContent =
      detail || 'Something went wrong while starting your preview.';
    var retry = document.getElementById('retry');
    retry.textContent = window.parent === window && editorUrl ? 'Return to Quillra' : 'Retry';
    retry.classList.remove('hidden');
    if (currentMode === 'warm') {
      warmState.classList.add('failed');
      return;
    }
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
    if (currentMode === 'cold') {
      document.getElementById('label').textContent =
        stage === 'installing' ? 'Finishing the one-time setup' : 'Preparing your project';
      document.getElementById('detail').textContent =
        detail || 'The first setup can take a little longer. Your preview will open automatically.';
      return;
    }
    document.getElementById('label').textContent = 'Almost there';
    document.getElementById('detail').textContent =
      detail || 'The secure preview is waking up and will open automatically.';
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
    currentMode = '';
    currentStage = '';
    currentStageIndex = -1;
    stagePolls = 0;
    document.getElementById('retry').classList.add('hidden');
    setMode('warm');
    document.getElementById('label').textContent = 'Restarting your preview';
    document.getElementById('detail').textContent = 'Quillra is starting a fresh secure preview…';
    setStage('starting', 'warm');
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
    var delay = 500;
    if (failedPolls > 0) delay = 1500;
    else if (currentStage === 'starting') delay = 250;
    else if (currentStage === 'installing') {
      if (stagePolls >= 30) delay = 5000;
      else if (stagePolls >= 10) delay = 2000;
      else delay = 1000;
    }
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
          setMode(modeFor(data.stage, data.mode));
          showError(data.label, data.detail);
          return;
        }
        var acceptedStage = setStage(data.stage, data.mode);
        stagePolls++;
        if (currentStage === 'ready') {
          stopPolling();
          if (currentMode === 'cold') {
            steps.forEach(function(s) {
              s.classList.remove('active', 'failed');
              s.classList.add('done');
            });
          } else {
            warmState.classList.add('ready');
          }
          setTimeout(function() {
            try {
              var nextUrl = new URL(window.location.href);
              nextUrl.searchParams.delete('__quillra_parent');
              window.location.replace(nextUrl.toString());
            } catch (_) {
              window.location.reload();
            }
          }, 50);
        } else if (stagePolls >= 30) {
          if (acceptedStage) showSlow(currentStage, data.detail);
        } else if (acceptedStage) {
          if (data.label) document.getElementById('label').textContent = data.label;
          if (data.detail) document.getElementById('detail').textContent = data.detail;
        }
      })
      .catch(recordPollFailure)
      .then(scheduleNextPoll);
  }

  document.getElementById('retry').onclick = retryPreview;
  setMode('warm');
  tick();
})();
</script>
</body>
</html>`;
}
