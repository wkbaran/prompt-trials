// Prompt Trials control app. Plain DOM, no build step; all text goes in as text nodes.
/** Every link to the promptfoo viewer uses this name, so the browser reuses one tab. (No rel=noopener: it would force a new window each time.) */
const VIEWER_TAB = 'prompt-trials-viewer';
const main = document.getElementById('main');
const drawer = document.getElementById('drawer');

/** h('div', {class: 'x', onclick: fn}, child, 'text', [more]) */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  return data;
}

/** Logs written before colour was switched off still hold escape codes. */
const stripAnsi = (t) => t.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
const fmtMs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtN = (n) => Math.round(n).toLocaleString();
const fmtUsd = (n) => (n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDur = (a, b) => (b ? fmtMs(new Date(b) - new Date(a)) : '');

function showError(err) {
  return h('div', { class: 'notice bad', role: 'alert' }, err.message ?? String(err));
}

function closeDrawer() {
  drawer.hidden = true;
  drawer.replaceChildren();
}
/** replaceChildren turns undefined and false into text, so drop them first. */
const kids = (list) => list.flat(Infinity).filter((k) => k != null && k !== false);
function openDrawer(...content) {
  drawer.replaceChildren(...kids([h('button', { onclick: closeDrawer, style: 'float:right' }, 'Close'), ...content]));
  drawer.hidden = false;
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

// ---------------------------------------------------------------- routing
let stopLive = () => {};
const routes = [
  [/^#\/run$/, 'run', viewNewRun],
  [/^#\/runs$/, 'runs', viewRuns],
  [/^#\/runs\/([\w-]+)$/, 'runs', viewRun],
  [/^#\/recordings$/, 'recordings', viewRecordings],
  [/^#\/recordings\/([\w.-]+)$/, 'recordings', viewRecordingDir],
  [/^#\/recordings\/([\w.-]+)\/([\w.-]+)$/, 'recordings', viewStep],
  [/^#\/suites\/(new)(?:\/([\w-]+))?$/, 'cases', viewSuiteForm],
  [/^#\/suites\/([\w-]+)\/(edit)$/, 'cases', viewSuiteForm],
  [/^#\/cases$/, 'cases', viewCases],
  [/^#\/cases\/([\w.-]+)$/, 'cases', viewCases],
];
async function route() {
  stopLive();
  stopLive = () => {};
  closeDrawer();
  const hash = location.hash || '#/run';
  for (const [re, nav, view] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    document.querySelectorAll('[data-nav]').forEach((a) => (a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    main.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
    try {
      main.replaceChildren(await view(...m.slice(1).map((x) => (x === undefined ? undefined : decodeURIComponent(x)))));
    } catch (e) {
      main.replaceChildren(showError(e));
    }
    main.focus({ preventScroll: true });
    return;
  }
  location.hash = '#/run';
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- new run
async function viewNewRun() {
  const [{ suites }, { models, error }] = await Promise.all([api('suites'), api('models')]);
  const suite = h('select', { id: 'suite' }, suites.map((s) => h('option', { value: s.name }, `${s.name} (${s.cases} cases)`)));
  const repeat = h('input', { type: 'number', id: 'repeat', value: 1, min: 1, max: 50 });
  const conc = h('input', { type: 'number', id: 'conc', value: 1, min: 1, max: 16 });
  const checks = models.map((m) => h('input', { type: 'checkbox', value: m.id, checked: m.id === '@reference', onchange: guard }));
  const warn = h('div');
  const msg = h('div');
  let force = false;

  const chosen = () => checks.filter((c) => c.checked).map((c) => c.value);
  async function guard() {
    force = false;
    warn.replaceChildren();
    const ms = chosen();
    if (!ms.length) return;
    const { warnings } = await api(`guard?models=${encodeURIComponent(ms.join(','))}`);
    if (warnings.length) {
      warn.replaceChildren(h('div', { class: 'notice' }, h('strong', {}, 'Check the GPU first'), h('ul', {}, warnings.map((w) => h('li', {}, w))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => (force = e.target.checked) }), 'Run anyway')));
    }
  }
  async function start(e) {
    e.preventDefault();
    msg.replaceChildren();
    try {
      const run = await api('runs', { body: { suite: suite.value, models: chosen(), repeat: Number(repeat.value), concurrency: Number(conc.value), force } });
      location.hash = `#/runs/${run.id}`;
    } catch (err) {
      msg.replaceChildren(showError(err.status === 409 ? new Error('Tick "Run anyway" above to start despite the warnings.') : err));
      if (err.status === 409) guard();
    }
  }

  return h('form', { class: 'stack', onsubmit: start },
    h('div', {}, h('h1', {}, 'New run'), h('p', { class: 'lede' }, 'Replay a suite’s recorded steps against the models you choose and compare how each one behaves.')),
    error && showError(new Error(error)),
    h('div', { class: 'panel' },
      h('label', { for: 'suite' }, 'Suite'), suite,
      h('h3', {}, 'Models'),
      models.map((m, i) => h('label', { class: 'check' }, checks[i], h('span', {}, m.label, ' ', h('span', { class: 'muted small' }, m.detail), m.gpu ? h('span', { class: 'tag', style: 'margin-left:.4rem' }, 'GPU') : null))),
      h('div', { class: 'row' },
        h('div', {}, h('label', { for: 'repeat' }, 'Repeats per test'), repeat),
        h('div', {}, h('label', { for: 'conc' }, 'Parallel requests'), conc)),
      h('p', { class: 'muted small' }, 'Local models answer one request at a time; keep parallel requests at 1 for them. Repeats show how much a model’s answers vary.')),
    warn, msg,
    h('div', {}, h('button', { class: 'primary', type: 'submit' }, 'Start run')));
}

// ---------------------------------------------------------------- run list and detail
function strip(totals) {
  return h('span', { class: 'strip' }, totals.flatMap((t) => [...Array(t.total)].map((_, i) => h('span', { class: `cell${i < t.passed ? '' : ' fail'}`, title: `${t.label}: ${t.passed}/${t.total}` }))));
}

function tally(totals) {
  const passed = totals.reduce((a, t) => a + t.passed, 0);
  const total = totals.reduce((a, t) => a + t.total, 0);
  return h('span', { class: 'tally' }, `${passed}/${total}`);
}

const RUNS_FILTER_KEY = 'prompt-trials.runs-suite';
const rememberedSuite = () => { try { return localStorage.getItem(RUNS_FILTER_KEY) ?? ''; } catch { return ''; } };
const rememberSuite = (v) => { try { localStorage.setItem(RUNS_FILTER_KEY, v); } catch { /* the filter just resets next time */ } };

async function viewRuns() {
  const { runs } = await api('runs');
  if (!runs.length) return h('div', {}, h('h1', {}, 'Runs'), h('p', { class: 'lede' }, 'Nothing has run yet. '), h('a', { href: '#/run' }, 'Start a run'));
  const suites = [...new Set(runs.map((r) => r.suite))].sort();
  let chosen = suites.includes(rememberedSuite()) ? rememberedSuite() : '';
  const count = h('span', { class: 'muted small' });
  const body = h('tbody');
  const open = (r) => (location.hash = `#/runs/${r.id}`);

  function paint() {
    const shown = chosen ? runs.filter((r) => r.suite === chosen) : runs;
    count.textContent = `${shown.length} of ${runs.length} runs`;
    body.replaceChildren(...shown.map((r) => h('tr', { class: 'link', tabindex: 0, onclick: () => open(r), onkeydown: (e) => e.key === 'Enter' && open(r) },
      h('td', { class: 'nowrap' }, fmtWhen(r.startedAt)), h('td', { class: 'nowrap' }, r.suite), h('td', {}, r.models.join(', ')),
      h('td', { class: 'strip-cell' }, r.totals ? [strip(r.totals), tally(r.totals)] : ''), h('td', { class: 'nowrap' }, fmtDur(r.startedAt, r.endedAt)),
      h('td', {}, h('span', { class: `status ${r.status}` }, r.status)))));
  }
  paint();

  const pick = h('select', { id: 'runs-suite', onchange: (e) => { chosen = e.target.value; rememberSuite(chosen); paint(); } },
    h('option', { value: '' }, 'All suites'), suites.map((name) => h('option', { value: name, selected: name === chosen }, name)));
  return h('div', {},
    h('h1', {}, 'Runs'),
    h('div', { class: 'row', style: 'margin-bottom:.9rem' },
      h('div', { class: 'fit' }, h('label', { for: 'runs-suite', style: 'margin-top:0' }, 'Suite'), pick),
      h('div', { class: 'fit' }, count)),
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Started', 'Suite', 'Models', 'Result', 'Took', 'Status'].map((t) => h('th', {}, t)))),
      body)));
}

function cellButton(model, test, c, i) {
  return h('button', { class: `cell${c.success ? '' : ' fail'}`, title: `${model}: ${c.success ? 'passed' : 'failed'}`, 'aria-label': `${model} repeat ${i + 1}: ${c.success ? 'passed' : 'failed'}`,
    onclick: () => openDrawer(
      h('h3', {}, test.description),
      h('p', {}, h('strong', {}, model), ' · ', h('span', { class: `status ${c.success ? 'done' : 'failed'}` }, c.success ? 'passed' : 'failed')),
      c.reason && h('div', { class: 'notice bad' }, c.reason),
      h('p', { class: 'small muted' }, `${fmtMs(c.latencyMs)} · ${fmtN(c.promptTokens)} in (${fmtN(c.cachedTokens)} cached) · ${fmtN(c.completionTokens)} out · ${fmtUsd(c.cost)}`),
      h('h3', {}, 'What the model did'), h('pre', {}, c.output || '(nothing)'),
      test.fixture && h('p', { class: 'small muted' }, 'Fixture: ', h('span', { class: 'mono' }, test.fixture))) });
}

function resultsView(summary) {
  const labels = summary.models.map((m) => m.label);
  return h('div', {},
    h('h2', {}, 'By model'),
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Passed'), ['Avg time', 'Tokens in', 'cached', 'Tokens out', 'Cost'].map((t) => h('th', { class: 'num' }, t)))),
      h('tbody', {}, summary.models.map((m) => h('tr', {},
        h('td', {}, m.label),
        h('td', { class: 'nowrap' }, h('span', { class: 'bar' }, h('i', { style: `width:${m.total ? (100 * m.passed) / m.total : 0}%` })), `${m.passed}/${m.total}`),
        h('td', { class: 'num' }, fmtMs(m.avgLatencyMs)), h('td', { class: 'num' }, fmtN(m.promptTokens)), h('td', { class: 'num' }, fmtN(m.cachedTokens)),
        h('td', { class: 'num' }, fmtN(m.completionTokens)), h('td', { class: 'num' }, fmtUsd(m.cost))))))),
    h('h2', {}, 'By test'),
    h('p', { class: 'muted small' }, 'One square per attempt. Select a square to see what the model did.'),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Test'), labels.map((l) => h('th', {}, l)))),
      h('tbody', {}, summary.tests.map((t) => h('tr', {}, h('td', {}, t.description),
        labels.map((l) => {
          const cells = t.cells[l] ?? [];
          return h('td', {}, h('span', { class: 'strip big' }, cells.map((c, i) => cellButton(l, t, c, i))),
            cells.length > 1 ? h('span', { class: 'tally' }, `${cells.filter((c) => c.success).length}/${cells.length}`) : null);
        })))))));
}

async function viewRun(id) {
  const first = await api(`runs/${id}`);
  const wrap = h('div', { class: 'stack' });
  let timer;
  stopLive = () => clearTimeout(timer);

  async function paint(data) {
    const { run, summary } = data;
    const { up, port } = await api('viewer').catch(() => ({ up: false }));
    const logBox = h('pre', { class: 'log', id: 'log' }, stripAnsi(data.log ?? ''));
    wrap.replaceChildren(...kids([
      h('div', {}, h('h1', {}, run.suite), h('p', { class: 'lede' }, `${run.models.join(', ')} · ${run.repeat}× · ${fmtWhen(run.startedAt)} `, h('span', { class: `status ${run.status}` }, run.status))),
      run.error && showError(new Error(run.error)),
      run.status === 'running' && h('div', {}, h('button', { class: 'danger', onclick: () => api(`runs/${id}/cancel`, { method: 'POST', body: {} }) }, 'Cancel run')),
      summary && summary.tests.length ? resultsView(summary) : run.status === 'running' ? h('p', { class: 'muted' }, 'Running… results appear when it finishes.') : null,
      run.evalId && up && h('p', {}, h('a', { href: `http://${location.hostname}:${port}/eval/${run.evalId}`, target: VIEWER_TAB }, 'Open in the promptfoo viewer')),
      h('h2', {}, 'Log'), logBox]));
    if (run.status === 'running') {
      const es = new EventSource(`/api/runs/${id}/log`);
      logBox.textContent = '';
      es.onmessage = (e) => {
        logBox.textContent += JSON.parse(e.data);
        logBox.scrollTop = logBox.scrollHeight;
      };
      es.addEventListener('done', async () => {
        es.close();
        timer = setTimeout(async () => paint(await api(`runs/${id}`)), 300);
      });
      es.onerror = () => es.close();
      stopLive = () => es.close();
    }
  }
  await paint(first);
  return wrap;
}

// ---------------------------------------------------------------- recordings
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'run';

const shortModel = (m) => m.replace(/^(openai|anthropic|ollama_chat|ollama)\//, '').replace(/:latest$/, '');
const fmtSpan = (ms) => (ms >= 120000 ? `${Math.round(ms / 60000)} min` : fmtMs(ms));
const MIN_RUN = 5;

/** The "recent runs from LiteLLM" panel: finds runs in the proxy's logs and imports one with a click. */
function litellmPanel() {
  const days = h('select', { 'aria-label': 'How far back', onchange: load }, [[1, 'Last day'], [3, 'Last 3 days'], [7, 'Last 7 days']].map(([v, t]) => h('option', { value: v, selected: v === 3 }, t)));
  const hideShort = h('input', { type: 'checkbox', checked: true, onchange: () => paint() });
  const showHidden = h('input', { type: 'checkbox', onchange: () => paint() });
  const hiddenCount = h('span');
  const body = h('div');
  let runs = [];
  const panel = h('section', { class: 'panel stack' },
    h('div', { class: 'row' }, h('div', {}, h('h2', { style: 'margin:0' }, 'Import from LiteLLM'),
      h('p', { class: 'muted small', style: 'margin:.2rem 0 0' }, 'Runs the proxy has logged. Importing copies a run’s requests into a recordings folder.')),
      h('div', { class: 'fit' }, days)),
    h('div', { class: 'row' },
      h('label', { class: 'check fit', style: 'margin:0' }, hideShort, `Hide runs of fewer than ${MIN_RUN} requests`),
      h('label', { class: 'check fit', style: 'margin:0' }, showHidden, 'Show runs I hid', hiddenCount)),
    body);

  async function importRun(r, button) {
    const day = new Date(r.start).toISOString().slice(0, 10);
    const folder = prompt('Save this run in the recordings folder named:', `${day}-${slug(r.label)}`);
    if (!folder) return;
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const out = await api('litellm/import', { body: { start: r.start, end: r.end, folder } });
      if (!out.written) throw new Error('Nothing was imported. Does the proxy keep request bodies (store_prompts_in_spend_logs)?');
      location.hash = `#/recordings/${folder}`;
    } catch (e) {
      button.disabled = false;
      button.textContent = 'Import';
      body.prepend(showError(e));
    }
  }

  async function hide(r, hidden) {
    try {
      await api('litellm/hide', { body: { start: r.start, hidden } });
      r.hidden = hidden;
      paint();
    } catch (e) {
      body.prepend(showError(e));
    }
  }

  function paint() {
    const nHidden = runs.filter((r) => r.hidden).length;
    hiddenCount.textContent = nHidden ? ` (${nHidden})` : '';
    const shown = runs.filter((r) => (showHidden.checked || !r.hidden) && (!hideShort.checked || r.requests >= MIN_RUN));
    if (!shown.length) return body.replaceChildren(h('p', { class: 'muted' }, runs.length ? `Nothing to show. ${runs.length} run(s) are hidden by the filters above.` : 'No runs in that period.'));
    body.replaceChildren(h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Started'), h('th', {}, 'Run'), h('th', { class: 'num' }, 'Requests'), h('th', { class: 'wide' }, 'Models'), h('th', { class: 'num wide' }, 'Tokens in'), h('th', { class: 'num' }, 'Cost'), h('th', {}, ''))),
      h('tbody', {}, shown.map((r) => {
        const names = r.models.map(shortModel);
        return h('tr', {},
          h('td', { class: 'nowrap' }, fmtWhen(r.start), h('div', { class: 'muted small' }, fmtSpan(new Date(r.end) - new Date(r.start)))),
          h('td', { style: 'min-width:9rem' }, r.label),
          h('td', { class: 'num' }, r.requests),
          h('td', { class: 'wide', title: names.join(', ') }, names.slice(0, 2).join(', '), names.length > 2 ? h('span', { class: 'muted' }, ` +${names.length - 2}`) : null),
          h('td', { class: 'num wide' }, fmtN(r.promptTokens)),
          h('td', { class: 'num' }, fmtUsd(r.spend)),
          h('td', { class: 'nowrap' },
            r.imported
              ? h('a', { href: `#/recordings/${r.importedAs}` }, `In ${r.importedAs}`)
              : r.hidden ? null : h('button', { type: 'button', onclick: (e) => importRun(r, e.target) }, 'Import'),
            r.imported ? null : h('button', { type: 'button', class: 'quiet', onclick: () => hide(r, !r.hidden) }, r.hidden ? 'Show again' : 'Hide')));
      })))));
  }

  async function load() {
    body.replaceChildren(h('p', { class: 'muted' }, 'Looking for runs…'));
    try {
      const out = await api(`litellm/recent?days=${days.value}`);
      if (!out.configured) return body.replaceChildren(h('p', { class: 'muted' }, 'LiteLLM isn’t set up for this app. It needs LITELLM_URL and LITELLM_API_KEY in its environment.'));
      runs = out.runs;
      paint();
    } catch (e) {
      body.replaceChildren(showError(e));
    }
  }
  load();
  return panel;
}

/** Deletes a recordings folder after asking. Cases and fixtures made from it are separate copies and stay. */
async function removeRecordings(name, count, after) {
  const ok = confirm(`Delete the folder “${name}” and its ${count} recorded requests?\n\nCases and fixtures you made from it are not affected. You can import the run again from LiteLLM while it is still in the proxy’s logs.`);
  if (!ok) return;
  try {
    await api(`recordings/${encodeURIComponent(name)}`, { method: 'DELETE' });
    after();
  } catch (e) {
    alert(e.message);
  }
}

async function viewRecordings() {
  const { dirs } = await api('recordings');
  return h('div', { class: 'stack' },
    h('div', {}, h('h1', {}, 'Recordings'), h('p', { class: 'lede' }, 'Every recorded request is a snapshot of an agent mid-task. Pick one to turn it into a test case.')),
    litellmPanel(),
    dirs.length
      ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Folder'), h('th', { class: 'num' }, 'Requests'), h('th', {}, ''))),
          h('tbody', {}, dirs.map((d) => h('tr', { class: 'link', tabindex: 0, onclick: () => (location.hash = `#/recordings/${d.name}`), onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/recordings/${d.name}`) },
            h('td', {}, d.name), h('td', { class: 'num' }, d.files),
            h('td', { class: 'nowrap' }, h('button', { type: 'button', class: 'danger', onclick: (e) => { e.stopPropagation(); removeRecordings(d.name, d.files, () => route()); } }, 'Delete')))))))
      : h('p', { class: 'muted' }, 'No recordings yet. Import a run above.'));
}

async function viewRecordingDir(dir) {
  const { conversations } = await api(`recordings/${encodeURIComponent(dir)}`);
  return h('div', {}, h('p', { class: 'crumb' }, h('a', { href: '#/recordings' }, 'All recordings')), h('h1', {}, dir),
    h('p', {}, h('button', { type: 'button', class: 'danger', onclick: () => removeRecordings(dir, conversations.reduce((n, c) => n + c.steps.length, 0), () => (location.hash = '#/recordings')) }, 'Delete this folder')),
    h('p', { class: 'lede' }, `${conversations.length} conversations. Each row is one request, the model’s next step in that conversation.`),
    conversations.map((c) => h('section', {},
      h('h3', {}, c.key),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { class: 'num' }, 'Messages'), h('th', { class: 'num' }, 'Time'), h('th', {}, 'The model answered'))),
        h('tbody', {}, c.steps.map((s) => h('tr', { class: 'link', tabindex: 0, onclick: () => (location.hash = `#/recordings/${dir}/${s.file}`), onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/recordings/${dir}/${s.file}`) },
          h('td', { class: 'num' }, s.messages), h('td', { class: 'num' }, fmtMs(s.ms)), h('td', {}, s.answer)))))))));
}

function messageView(m) {
  const head = m.toolCalls.length ? m.toolCalls.map((c) => c.split(' ')[0]).join(', ') : m.content.replace(/\s+/g, ' ').slice(0, 110);
  return h('details', { class: 'msg' },
    h('summary', {}, h('span', { class: `role ${m.role}` }, m.role), h('span', { class: 'muted' }, head), h('span', { class: 'muted small' }, m.chars ? `${fmtN(m.chars)} chars` : '')),
    h('div', {}, m.content && h('pre', {}, m.content), m.chars > m.content.length && h('p', { class: 'small muted' }, `Showing the first ${fmtN(m.content.length)} of ${fmtN(m.chars)} characters; the fixture keeps all of it.`),
      m.toolCalls.map((c) => h('pre', {}, c))));
}

async function viewStep(dir, file) {
  const [d, { suites }] = await Promise.all([api(`recordings/${encodeURIComponent(dir)}/${encodeURIComponent(file)}`), api('suites')]);
  const answer = h('div', { class: 'msg answer panel' },
    h('strong', {}, 'The model’s next step'),
    d.answer.toolCalls.map((c) => h('pre', {}, `${c.name}(${JSON.stringify(c.arguments, null, 1).slice(0, 3000)})`)),
    d.answer.content && h('pre', {}, d.answer.content.slice(0, 3000)));
  return h('div', { class: 'stack' },
    h('div', {}, h('p', { class: 'crumb' }, h('a', { href: `#/recordings/${dir}` }, dir)), h('h1', {}, 'Make a case from this step'),
      h('p', { class: 'lede' }, `${d.messages.length} messages · ${d.model ?? 'model unknown'} · ${fmtMs(d.latencyMs)}. A case replays everything above the next step and checks what a model does there. `,
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); document.getElementById('case-form')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); } }, 'Go to the case form'))),
    h('div', {}, h('h2', {}, 'Conversation so far'), d.messages.map(messageView), answer),
    caseBuilder({ suites: suites.map((s) => s.name), tools: d.tools, recording: { dir, file } }));
}

// ---------------------------------------------------------------- case builder
let catalogCache;
async function catalog() {
  catalogCache ??= (await api('catalog')).assertions;
  return catalogCache;
}

/** A list of checks with its "add" menu. `items` is edited in place; `payload()` is what the API takes. */
function assertionList(initial) {
  const items = initial.map((a) => ({ id: a.id, values: { ...a.values } }));
  const results = new Map();
  const addSel = h('select', { 'aria-label': 'Add a check' });
  const listBox = h('div');

  function fieldInput(f, item) {
    const v = item.values[f.key];
    if (f.kind === 'bool') return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(v), onchange: (e) => (item.values[f.key] = e.target.checked) }), f.label);
    const label = h('label', {}, f.label, f.required ? '' : ' (optional)');
    if (f.kind === 'list') {
      const chips = h('div', { class: 'tags' });
      const input = h('input', { type: 'text', placeholder: 'Type a tool name and press Enter', list: 'tools-list' });
      const paint = () => chips.replaceChildren(...(item.values[f.key] ?? []).map((n, i) => h('span', { class: 'tag' }, n, h('button', { type: 'button', 'aria-label': `Remove ${n}`, onclick: () => { item.values[f.key].splice(i, 1); paint(); } }, '×'))));
      const add = () => { const t = input.value.trim(); if (t) { (item.values[f.key] ??= []).push(t); input.value = ''; paint(); } };
      input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
      input.addEventListener('change', add);
      item.values[f.key] ??= [];
      paint();
      return h('div', {}, label, input, chips);
    }
    const input = h('input', { type: f.kind === 'number' ? 'number' : 'text', value: v ?? '', placeholder: f.placeholder ?? '', oninput: (e) => (item.values[f.key] = e.target.value) });
    return h('div', {}, label, input, f.help && h('div', { class: 'muted small' }, f.help));
  }

  async function paint() {
    const cat = await catalog();
    listBox.replaceChildren(...items.map((item, i) => {
      const spec = cat.find((s) => s.id === item.id);
      const r = results.get(item);
      return h('div', { class: 'assert' },
        h('header', {}, h('strong', {}, spec.label), h('button', { type: 'button', class: 'danger', onclick: () => { items.splice(i, 1); paint(); } }, 'Remove')),
        h('div', { class: 'muted small' }, spec.help),
        spec.fields.map((f) => fieldInput(f, item)),
        r && h('div', { class: `result ${r.pass ? 'pass' : 'fail'}` }, `${r.pass ? 'Passes' : 'Fails'} on the recorded answer: ${r.reason}`));
    }));
  }

  (async () => {
    const cat = await catalog();
    addSel.replaceChildren(h('option', { value: '' }, 'Add a check…'), ...cat.map((s) => h('option', { value: s.id }, s.label)));
    addSel.addEventListener('change', () => {
      if (!addSel.value) return;
      const item = { id: addSel.value, values: {} };
      for (const f of cat.find((s) => s.id === addSel.value).fields) if (f.kind === 'bool') item.values[f.key] = f.default ?? false;
      items.push(item);
      addSel.value = '';
      paint();
    });
    await paint();
  })();

  return {
    node: h('div', {}, listBox, addSel),
    payload: () => items.map((a) => ({ id: a.id, values: a.values })),
    showResults(rs) { items.forEach((it, i) => results.set(it, rs[i])); return paint(); },
  };
}

function caseBuilder({ suites, suite, tools = [], recording, fixture, description = '', assertions = [], index }) {
  const root = h('form', { class: 'panel stack', id: 'case-form', onsubmit: (e) => e.preventDefault() });
  const list = assertionList(assertions);
  const suiteSel = h('select', {}, suites.map((s) => h('option', { value: s, selected: s === suite }, s)));
  if (suite) suiteSel.disabled = true;
  const desc = h('input', { type: 'text', value: description, placeholder: 'What this case should show, in a sentence' });
  const fname = h('input', { type: 'text', value: '', placeholder: 'after-first-batch' });
  const msg = h('div');

  const body = (extra = {}) => ({ suite: suite ?? suiteSel.value, description: desc.value, recording, fixture, fixtureName: fname.value, index, assertions: list.payload(), ...extra });
  async function check() {
    msg.replaceChildren();
    try {
      const { results: rs } = await api('cases', { body: body({ check: true }) });
      await list.showResults(rs);
    } catch (e) {
      msg.replaceChildren(showError(e));
    }
  }
  async function save() {
    msg.replaceChildren();
    try {
      await api('cases', { body: body() });
      location.hash = `#/cases/${suite ?? suiteSel.value}`;
    } catch (e) {
      msg.replaceChildren(showError(e));
    }
  }

  root.append(
    h('datalist', { id: 'tools-list' }, tools.map((t) => h('option', { value: t }))),
    h('h2', { style: 'margin-top:0' }, 'The case'),
    h('div', { class: 'row' },
      h('div', {}, h('label', {}, 'Suite'), suiteSel),
      recording && h('div', {}, h('label', {}, 'Fixture file name'), fname)),
    h('label', {}, 'Description'), desc,
    h('h3', {}, 'What should the next step satisfy?'),
    list.node,
    msg,
    h('div', { class: 'row' },
      recording || fixture ? h('div', { class: 'fit' }, h('button', { type: 'button', onclick: check }, 'Try against the recorded answer')) : null,
      h('div', { class: 'fit' }, h('button', { type: 'button', class: 'primary', onclick: save }, 'Save case'))),
    h('p', { class: 'muted small' }, 'Cases are saved to the suite’s private cases file and the fixture to fixtures/. Both stay out of git.'));
  return root;
}

// ---------------------------------------------------------------- suite settings
async function viewSuiteForm(a, b) {
  // #/suites/new, #/suites/new/<copy from>, #/suites/<name>/edit
  const editing = b === 'edit';
  const source = editing ? a : a === 'new' ? b : undefined;
  const detail = source ? await api(`suites/${encodeURIComponent(source)}`) : undefined;
  if (editing && detail.kind !== 'user') throw new Error('Suites that ship with the repo are read-only. Copy it to change it.');
  const name = h('input', { type: 'text', value: '', placeholder: 'medium-experiments', disabled: editing, 'aria-label': 'Suite name' });
  const desc = h('input', { type: 'text', value: detail?.description ?? '', placeholder: 'What this suite checks' });
  const list = assertionList((detail?.defaultAssertions ?? []).filter((x) => x.id).map((x) => ({ id: x.id, values: x.values })));
  const hidden = (detail?.defaultAssertions ?? []).filter((x) => !x.id).length;
  const msg = h('div');
  async function save() {
    msg.replaceChildren();
    try {
      const body = { description: desc.value, defaultAssertions: list.payload() };
      if (editing) await api(`suites/${encodeURIComponent(a)}`, { method: 'PUT', body });
      else await api('suites', { body: { ...body, name: name.value.trim(), copyFrom: source } });
      location.hash = `#/cases/${editing ? a : name.value.trim()}`;
    } catch (e) {
      msg.replaceChildren(showError(e));
    }
  }
  return h('div', { class: 'stack' },
    h('div', {}, h('p', { class: 'crumb' }, h('a', { href: editing ? `#/cases/${a}` : '#/cases' }, 'Cases')),
      h('h1', {}, editing ? `Settings for ${a}` : source ? `Copy ${source}` : 'New suite'),
      h('p', { class: 'lede' }, editing ? 'The checks below run on every case in this suite, in addition to the checks on each case.' : source ? 'Creates your own editable suite with the same checks and a copy of every case. Fixtures are shared, not copied.' : 'A suite groups cases that test one kind of agent step. Add its cases from a recording afterwards.')),
    h('form', { class: 'panel stack', onsubmit: (e) => e.preventDefault() },
      !editing && h('div', {}, h('label', {}, 'Name'), name, h('div', { class: 'muted small' }, 'Lowercase letters, digits and dashes.')),
      h('div', {}, h('label', {}, 'Description'), desc),
      h('h3', {}, 'Checks for every case'),
      hidden ? h('div', { class: 'notice' }, `${hidden} check(s) use settings the editor can't show. They are dropped when you save.`) : null,
      list.node, msg,
      h('div', { class: 'row' }, h('div', { class: 'fit' }, h('button', { type: 'button', class: 'primary', onclick: save }, editing ? 'Save settings' : 'Create suite')))));
}

// ---------------------------------------------------------------- cases
async function viewCases(suiteName) {
  const { suites } = await api('suites');
  if (!suites.length) return h('div', {}, h('h1', {}, 'Cases'), h('p', {}, 'No suites found.'));
  const meta = suites.find((s) => s.name === suiteName) ?? suites[0];
  const current = meta.name;
  const [{ cases }, cat] = await Promise.all([api(`cases/${encodeURIComponent(current)}`), catalog()]);
  const describe = (a) => {
    const spec = a.id && cat.find((s) => s.id === a.id);
    const bits = spec ? Object.entries(a.values ?? {}).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`) : [JSON.stringify(a.raw)];
    return `${spec ? spec.label : a.raw.type}${bits.length ? ` (${bits.join('; ')})` : ''}`;
  };
  const mine = meta.kind === 'user';
  return h('div', { class: 'stack' },
    h('div', {}, h('h1', {}, 'Cases'), h('p', { class: 'lede' }, 'Each case is a recorded step plus the checks that decide whether a model’s next step is right.')),
    h('div', { class: 'row' },
      h('div', {}, h('label', { for: 'suite-pick', style: 'margin-top:0' }, 'Suite'),
        h('select', { id: 'suite-pick', onchange: (e) => (location.hash = `#/cases/${e.target.value}`) },
          suites.map((s) => h('option', { value: s.name, selected: s.name === current }, s.kind === 'user' ? `${s.name} (yours)` : s.name)))),
      h('div', { class: 'fit row' },
        h('button', { type: 'button', class: 'fit', onclick: () => (location.hash = '#/suites/new') }, 'New suite'),
        mine
          ? [h('button', { type: 'button', class: 'fit', onclick: () => (location.hash = `#/suites/${current}/edit`) }, 'Suite settings'),
             h('button', { type: 'button', class: 'fit danger', onclick: async () => { if (confirm(`Delete the suite “${current}”? Its cases move to a trash folder; fixtures stay.`)) { await api(`suites/${encodeURIComponent(current)}`, { method: 'DELETE' }); location.hash = '#/cases'; } } }, 'Delete suite')]
          : h('button', { type: 'button', class: 'fit', onclick: () => (location.hash = `#/suites/new/${current}`) }, 'Copy as new suite'))),
    meta.description && h('p', { class: 'muted', style: 'margin-bottom:.2rem' }, meta.description),
    mine ? null : h('p', { class: 'muted small' }, 'This suite’s settings ship with the repo and can’t be changed here. You can still add cases to it and edit the ones you add.'),
    cases.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Case'), h('th', {}, 'Checks'), h('th', {}, ''))),
      h('tbody', {}, cases.map((c) => h('tr', {},
        h('td', {}, c.description, h('div', { class: 'muted small mono' }, `${c.file} → ${c.fixture}`)),
        h('td', {}, c.assertions.map((a) => h('div', { class: 'small' }, describe(a)))),
        h('td', {}, c.editable ? h('div', { class: 'row' },
          h('button', { class: 'fit', onclick: () => editCase(c, suites.map((s) => s.name), current) }, 'Edit'),
          h('button', { class: 'fit danger', onclick: async () => { if (confirm(`Delete “${c.description}”? The fixture file stays.`)) { await api(`cases/${current}/${c.index}`, { method: 'DELETE' }); route(); } } }, 'Delete')) : h('span', { class: 'muted small' }, 'example')))))))
      : h('p', { class: 'muted' }, 'This suite has no cases yet.'),
    h('p', { class: 'muted small' }, 'Create a case from a ', h('a', { href: '#/recordings' }, 'recording'), '.', cases.some((c) => !c.editable) ? ' Cases marked “example” come with the repo and can’t be changed here.' : ''));
}

async function editCase(c, suites, suite) {
  const known = c.assertions.filter((a) => a.id).map((a) => ({ id: a.id, values: a.values }));
  const unknown = c.assertions.length - known.length;
  main.replaceChildren(...kids([
    h('p', { class: 'crumb' }, h('a', { href: `#/cases/${suite}` }, 'Back to cases')),
    h('h1', {}, 'Edit case'),
    unknown ? h('div', { class: 'notice' }, `${unknown} check(s) in this case use settings the builder can’t show. Saving here drops them; edit the YAML by hand to keep them.`) : null,
    caseBuilder({ suites, suite, fixture: c.fixture, description: c.description, assertions: known, index: c.index, tools: [] })]));
}

// ---------------------------------------------------------------- theme
const THEME_KEY = 'prompt-trials.theme';
const themeBtn = document.getElementById('theme-btn');
const themeLabel = () => (document.documentElement.getAttribute('data-theme') === 'light' ? '🌙 Dark' : '☀️ Light');
themeBtn.textContent = themeLabel();
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // the choice just won't persist
  }
  themeBtn.textContent = themeLabel();
});

// ---------------------------------------------------------------- viewer link
api('viewer').then(({ up, port }) => {
  const a = document.getElementById('viewer-link');
  a.target = VIEWER_TAB;
  if (up) { a.href = `http://${location.hostname}:${port}/`; a.hidden = false; }
}).catch(() => {});

route();
