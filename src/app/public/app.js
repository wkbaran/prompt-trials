// Prompt Trials control app. Plain DOM, no build step; all text goes in as text nodes.
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
      main.replaceChildren(await view(...m.slice(1).map(decodeURIComponent)));
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

async function viewRuns() {
  const { runs } = await api('runs');
  if (!runs.length) return h('div', {}, h('h1', {}, 'Runs'), h('p', { class: 'lede' }, 'Nothing has run yet. '), h('a', { href: '#/run' }, 'Start a run'));
  return h('div', {},
    h('h1', {}, 'Runs'),
    h('div', { class: 'scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Started', 'Suite', 'Models', 'Result', 'Took', 'Status'].map((t) => h('th', {}, t)))),
      h('tbody', {}, runs.map((r) => h('tr', { class: 'link', tabindex: 0, onclick: () => (location.hash = `#/runs/${r.id}`), onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/runs/${r.id}`) },
        h('td', {}, fmtWhen(r.startedAt)), h('td', {}, r.suite), h('td', {}, r.models.join(', ')),
        h('td', {}, r.totals ? strip(r.totals) : ''), h('td', {}, fmtDur(r.startedAt, r.endedAt)),
        h('td', {}, h('span', { class: `status ${r.status}` }, r.status))))))));
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
        h('td', {}, h('span', { class: 'bar' }, h('i', { style: `width:${m.total ? (100 * m.passed) / m.total : 0}%` })), `${m.passed}/${m.total}`),
        h('td', { class: 'num' }, fmtMs(m.avgLatencyMs)), h('td', { class: 'num' }, fmtN(m.promptTokens)), h('td', { class: 'num' }, fmtN(m.cachedTokens)),
        h('td', { class: 'num' }, fmtN(m.completionTokens)), h('td', { class: 'num' }, fmtUsd(m.cost))))))),
    h('h2', {}, 'By test'),
    h('p', { class: 'muted small' }, 'One square per attempt. Select a square to see what the model did.'),
    h('div', { class: 'scroll' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Test'), labels.map((l) => h('th', {}, l)))),
      h('tbody', {}, summary.tests.map((t) => h('tr', {}, h('td', {}, t.description),
        labels.map((l) => h('td', {}, h('span', { class: 'strip big' }, (t.cells[l] ?? []).map((c, i) => cellButton(l, t, c, i)))))))))));
}

async function viewRun(id) {
  const first = await api(`runs/${id}`);
  const wrap = h('div', { class: 'stack' });
  let timer;
  stopLive = () => clearTimeout(timer);

  async function paint(data) {
    const { run, summary } = data;
    const { up, port } = await api('viewer').catch(() => ({ up: false }));
    const logBox = h('pre', { class: 'log', id: 'log' }, data.log ?? '');
    wrap.replaceChildren(...kids([
      h('div', {}, h('h1', {}, run.suite), h('p', { class: 'lede' }, `${run.models.join(', ')} · ${run.repeat}× · ${fmtWhen(run.startedAt)} `, h('span', { class: `status ${run.status}` }, run.status))),
      run.error && showError(new Error(run.error)),
      run.status === 'running' && h('div', {}, h('button', { class: 'danger', onclick: () => api(`runs/${id}/cancel`, { method: 'POST', body: {} }) }, 'Cancel run')),
      summary && summary.tests.length ? resultsView(summary) : run.status === 'running' ? h('p', { class: 'muted' }, 'Running… results appear when it finishes.') : null,
      run.evalId && up && h('p', {}, h('a', { href: `http://${location.hostname}:${port}/eval/${run.evalId}`, target: '_blank', rel: 'noopener' }, 'Open in the promptfoo viewer')),
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
async function viewRecordings() {
  const { dirs } = await api('recordings');
  if (!dirs.length) return h('div', {}, h('h1', {}, 'Recordings'), h('p', { class: 'lede' }, 'No recordings yet. Import them from LiteLLM or capture them with the recording proxy (see the README), into recordings/<name>.'));
  return h('div', {}, h('h1', {}, 'Recordings'),
    h('p', { class: 'lede' }, 'Every recorded request is a snapshot of an agent mid-task. Pick one to turn it into a test case.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Folder'), h('th', { class: 'num' }, 'Requests'))),
      h('tbody', {}, dirs.map((d) => h('tr', { class: 'link', tabindex: 0, onclick: () => (location.hash = `#/recordings/${d.name}`), onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/recordings/${d.name}`) },
        h('td', {}, d.name), h('td', { class: 'num' }, d.files)))))));
}

async function viewRecordingDir(dir) {
  const { conversations } = await api(`recordings/${encodeURIComponent(dir)}`);
  return h('div', {}, h('p', { class: 'small' }, h('a', { href: '#/recordings' }, 'All recordings')), h('h1', {}, dir),
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
    h('div', {}, h('p', { class: 'small' }, h('a', { href: `#/recordings/${dir}` }, dir)), h('h1', {}, 'Make a case from this step'),
      h('p', { class: 'lede' }, `${d.messages.length} messages · ${d.model ?? 'model unknown'} · ${fmtMs(d.latencyMs)}. A case replays everything above the next step and checks what a model does there.`)),
    h('div', {}, h('h2', {}, 'Conversation so far'), d.messages.map(messageView), answer),
    caseBuilder({ suites: suites.map((s) => s.name), tools: d.tools, recording: { dir, file } }));
}

// ---------------------------------------------------------------- case builder
let catalogCache;
async function catalog() {
  catalogCache ??= (await api('catalog')).assertions;
  return catalogCache;
}

function caseBuilder({ suites, suite, tools = [], recording, fixture, description = '', assertions = [], index }) {
  const root = h('form', { class: 'panel stack', onsubmit: (e) => e.preventDefault() });
  const state = { items: assertions.map((a) => ({ id: a.id, values: { ...a.values } })) };
  const suiteSel = h('select', {}, suites.map((s) => h('option', { value: s, selected: s === suite }, s)));
  if (suite) suiteSel.disabled = true;
  const desc = h('input', { type: 'text', value: description, placeholder: 'What this case should show, in a sentence' });
  const fname = h('input', { type: 'text', value: '', placeholder: 'after-first-batch' });
  const addSel = h('select', {});
  const results = new Map();
  const msg = h('div');
  const listBox = h('div');

  function fieldInput(spec, f, item) {
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

  async function paintList() {
    const cat = await catalog();
    listBox.replaceChildren(...state.items.map((item, i) => {
      const spec = cat.find((s) => s.id === item.id);
      const r = results.get(item);
      return h('div', { class: 'assert' },
        h('header', {}, h('strong', {}, spec.label), h('button', { type: 'button', class: 'danger', onclick: () => { state.items.splice(i, 1); paintList(); } }, 'Remove')),
        h('div', { class: 'muted small' }, spec.help),
        spec.fields.map((f) => fieldInput(spec, f, item)),
        r && h('div', { class: `result ${r.pass ? 'pass' : 'fail'}` }, `${r.pass ? 'Passes' : 'Fails'} on the recorded answer: ${r.reason}`));
    }));
  }

  async function body(extra = {}) {
    return { suite: suite ?? suiteSel.value, description: desc.value, recording, fixture, fixtureName: fname.value, index,
      assertions: state.items.map((a) => ({ id: a.id, values: a.values })), ...extra };
  }
  async function check() {
    msg.replaceChildren();
    try {
      const { results: rs } = await api('cases', { body: await body({ check: true }) });
      state.items.forEach((it, i) => results.set(it, rs[i]));
      await paintList();
    } catch (e) {
      msg.replaceChildren(showError(e));
    }
  }
  async function save() {
    msg.replaceChildren();
    try {
      const s = suite ?? suiteSel.value;
      await api('cases', { body: await body() });
      location.hash = `#/cases/${s}`;
    } catch (e) {
      msg.replaceChildren(showError(e));
    }
  }

  (async () => {
    const cat = await catalog();
    addSel.replaceChildren(h('option', { value: '' }, 'Add an assertion…'), ...cat.map((s) => h('option', { value: s.id }, s.label)));
    addSel.addEventListener('change', () => {
      if (!addSel.value) return;
      state.items.push({ id: addSel.value, values: {} });
      const spec = cat.find((s) => s.id === addSel.value);
      for (const f of spec.fields) if (f.kind === 'bool') state.items.at(-1).values[f.key] = f.default ?? false;
      addSel.value = '';
      paintList();
    });
    await paintList();
  })();

  root.append(
    h('datalist', { id: 'tools-list' }, tools.map((t) => h('option', { value: t }))),
    h('h2', { style: 'margin-top:0' }, 'The case'),
    h('div', { class: 'row' },
      h('div', {}, h('label', {}, 'Suite'), suiteSel),
      recording && h('div', {}, h('label', {}, 'Fixture file name'), fname)),
    h('label', {}, 'Description'), desc,
    h('h3', {}, 'What should the next step satisfy?'),
    listBox, addSel,
    msg,
    h('div', { class: 'row' },
      recording || fixture ? h('div', { class: 'fit' }, h('button', { type: 'button', onclick: check }, 'Try against the recorded answer')) : null,
      h('div', { class: 'fit' }, h('button', { type: 'button', class: 'primary', onclick: save }, 'Save case'))),
    h('p', { class: 'muted small' }, 'Cases are saved to the suite’s cases.private.yaml and the fixture to fixtures/. Both stay out of git.'));
  return root;
}

// ---------------------------------------------------------------- cases
async function viewCases(suiteName) {
  const { suites } = await api('suites');
  if (!suites.length) return h('div', {}, h('h1', {}, 'Cases'), h('p', {}, 'No suites found.'));
  const current = suiteName ?? suites[0].name;
  const [{ cases }, cat] = await Promise.all([api(`cases/${encodeURIComponent(current)}`), catalog()]);
  const describe = (a) => {
    const spec = a.id && cat.find((s) => s.id === a.id);
    const bits = spec ? Object.entries(a.values ?? {}).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`) : [JSON.stringify(a.raw)];
    return `${spec ? spec.label : a.raw.type}${bits.length ? ` (${bits.join('; ')})` : ''}`;
  };
  return h('div', { class: 'stack' },
    h('div', {}, h('h1', {}, 'Cases'), h('p', { class: 'lede' }, 'Each case is a recorded step plus the checks that decide whether a model’s next step is right.')),
    h('div', { class: 'row' }, h('div', { class: 'fit' }, h('label', { for: 'suite-pick', style: 'margin-top:0' }, 'Suite'),
      h('select', { id: 'suite-pick', onchange: (e) => (location.hash = `#/cases/${e.target.value}`) }, suites.map((s) => h('option', { value: s.name, selected: s.name === current }, s.name))))),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Case'), h('th', {}, 'Checks'), h('th', {}, ''))),
      h('tbody', {}, cases.map((c) => h('tr', {},
        h('td', {}, c.description, h('div', { class: 'muted small mono' }, `${c.file} → ${c.fixture}`)),
        h('td', {}, c.assertions.map((a) => h('div', { class: 'small' }, describe(a)))),
        h('td', {}, c.editable ? h('div', { class: 'row' },
          h('button', { class: 'fit', onclick: () => editCase(c, suites.map((s) => s.name), current) }, 'Edit'),
          h('button', { class: 'fit danger', onclick: async () => { if (confirm(`Delete “${c.description}”? The fixture file stays.`)) { await api(`cases/${current}/${c.index}`, { method: 'DELETE' }); route(); } } }, 'Delete')) : h('span', { class: 'muted small' }, 'example'))))))),
    h('p', { class: 'muted small' }, 'Create a case from a ', h('a', { href: '#/recordings' }, 'recording'), '. Cases in cases.yaml are shipped examples and are read-only here.'));
}

async function editCase(c, suites, suite) {
  const known = c.assertions.filter((a) => a.id).map((a) => ({ id: a.id, values: a.values }));
  const unknown = c.assertions.length - known.length;
  main.replaceChildren(...kids([
    h('p', { class: 'small' }, h('a', { href: `#/cases/${suite}` }, 'Back to cases')),
    h('h1', {}, 'Edit case'),
    unknown ? h('div', { class: 'notice' }, `${unknown} check(s) in this case use settings the builder can’t show. Saving here drops them; edit the YAML by hand to keep them.`) : null,
    caseBuilder({ suites, suite, fixture: c.fixture, description: c.description, assertions: known, index: c.index, tools: [] })]));
}

// ---------------------------------------------------------------- viewer link
api('viewer').then(({ up, port }) => {
  const a = document.getElementById('viewer-link');
  if (up) { a.href = `http://${location.hostname}:${port}/`; a.hidden = false; }
}).catch(() => {});

route();
