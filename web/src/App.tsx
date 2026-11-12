import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ArrowDownToLine, ArrowRight, Check, ChevronRight, Copy, Loader2, Play, RotateCcw, Search, Upload, X } from 'lucide-react';
import ExperimentHistory from './ExperimentHistory';
import type { Scenario, TrafficEvent, Run, State } from './types';


const presets: Scenario[] = [
 { version: 1, name: 'The lost response', description: 'Save the write. Drop the response.', rules: [{ id: 'lost-response', name: 'Drop the first response', method: 'POST', path: '/workouts', kind: 'drop_response', limit: 1, delayMs: 0, status: 0, enabled: true }] },
 { version: 1, name: 'The slow lane', description: 'Hold the request for 1.5 seconds.', rules: [{ id: 'slow-lane', name: 'Delay the first request', method: 'POST', path: '/workouts', kind: 'latency', limit: 1, delayMs: 1500, status: 0, enabled: true }] },
 { version: 1, name: 'Third time lucky', description: 'Return two 503s, then let it through.', rules: [{ id: 'third-time', name: 'Fail the first two requests', method: 'POST', path: '/workouts', kind: 'http_error', limit: 2, delayMs: 0, status: 503, enabled: true }] },
];
const faultLabel = (kind: string) => ({ drop_response: 'Response drop', latency: 'Latency', http_error: 'HTTP error' }[kind] || 'Pass-through');
const outcomeLabel = (outcome: string) => outcome.replaceAll('_', ' ');
const time = (value: string) => new Date(value).toLocaleTimeString('en-GB', { hour12: false });

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
 const response = await fetch(`/api${path}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
 const data = await response.json();
 if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
 return data as T;
}

function App() {
 const [state, setState] = useState<State | null>(null);
 const [connectionError, setConnectionError] = useState('');
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const [busy, setBusy] = useState(false);
 const [running, setRunning] = useState(false);
 const [mode, setMode] = useState('fragile');
 const [page, setPage] = useState('lab');
 const [query, setQuery] = useState('');
 const [onlyFaults, setOnlyFaults] = useState(false);
 const [selected, setSelected] = useState<TrafficEvent | null>(null);
 const [editing, setEditing] = useState(false);
 const [draft, setDraft] = useState('');
 const fileInput = useRef<HTMLInputElement>(null);
 const dialog = useRef<HTMLDialogElement>(null);
 const detailsDialog = useRef<HTMLDialogElement>(null);

 async function refresh() {
  const next = await api<State>('/state'); setState(next); setConnectionError('');
 }
 useEffect(() => {
  let stopped = false; let timer: ReturnType<typeof setTimeout>;
  const controller = new AbortController();
  async function poll() {
   try {
    const response = await fetch('/api/state', { signal: controller.signal });
    if (!response.ok) throw new Error('The local server is not responding.');
    const data: State = await response.json();
    if (!stopped) { setState(data); setConnectionError(''); }
   } catch { if (!stopped) setConnectionError('Connection lost. Start Blackbox to reconnect; the data below may be out of date.'); }
   if (!stopped) timer = setTimeout(poll, 1000);
  }
  void poll();
  return () => { stopped = true; controller.abort(); clearTimeout(timer); };
 }, []);
 useEffect(() => {
  if (editing) {
   dialog.current?.showModal();
   dialog.current?.querySelector('textarea')?.focus();
  } else dialog.current?.close();
 }, [editing]);
 useEffect(() => { window.scrollTo(0, 0); }, [page]);
 useEffect(() => { if (selected) detailsDialog.current?.showModal(); else detailsDialog.current?.close(); }, [selected]);

 async function action(fn: () => Promise<void>) {
  setBusy(true); setError(''); setNotice('');
  try { await fn(); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong.'); }
  finally { setBusy(false); }
 }
 async function runExperiment() {
  setRunning(true);
  await action(async () => { await api<Run>('/demo/run', 'POST', { mode }); });
  setRunning(false);
 }
 function applyScenario(scenario: Scenario) {
  void action(async () => { await api('/scenario', 'PUT', scenario); setNotice(`“${scenario.name}” is armed. Fault counters reset.`); });
 }
 async function importScenario(e: ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0]; if (!file) return;
  await action(async () => {
   if (file.size > 65536) throw new Error('Scenario files must be smaller than 64 KB.');
   const data = JSON.parse(await file.text());
   await api('/scenario', 'PUT', data); setNotice('Scenario imported and armed.');
  });
  e.target.value = '';
 }
 function openEditor() { if (state) { setError(''); setDraft(JSON.stringify(state.scenario, null, 2)); setEditing(true); } }
 async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); setNotice('Copied to clipboard.'); } catch { setError('Clipboard is unavailable. Select and copy the address manually.'); }
 }

 const events = state?.events ?? [];
 const filtered = events.filter(e => (!onlyFaults || e.fault) && `${e.method} ${e.path} ${e.status} ${e.outcome}`.toLowerCase().includes(query.toLowerCase()));
 const faults = events.filter(e => e.fault).length;
 const avg = events.length ? events.reduce((sum, e) => sum + e.durationMs, 0) / events.length : 0;
 const remaining = state?.scenario.rules.reduce((n, r) => n + (r.enabled ? Math.max(0, r.limit - (state.counts[r.id] ?? 0)) : 0), 0) ?? 0;
 const lastRun = state?.lastRun;
 const activePreset = presets.findIndex(p => JSON.stringify(p.rules) === JSON.stringify(state?.scenario.rules));
 const disable = busy || !state || !!connectionError;


 return <div className="app-shell">
  <a className="skip-link" href="#main">Skip to content</a>
  <header className="site-header">
   <div className="header-inner"><a href="#" className="brand" onClick={e => { e.preventDefault(); setPage('lab'); }} aria-label="Blackbox home"><span className="brand-mark" aria-hidden="true"/>blackbox<span className="brand-caption">HTTP failure lab</span></a><div className="connection-status"><span className={`status-dot ${connectionError ? 'offline' : !state ? 'connecting' : ''}`}/>{connectionError ? 'Disconnected' : state ? 'Local proxy online' : 'Connecting'}</div></div>
   <nav className="main-nav" aria-label="Main navigation">{[{id:'lab',label:'Failure lab'},{id:'traffic',label:'Request stream'},{id:'history',label:'Experiments'},{id:'guide',label:'Field guide'}].map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} className={page === item.id ? 'active' : ''} onClick={() => { setPage(item.id); window.scrollTo(0,0); }}>{item.label}{item.id === 'traffic' && <span className="nav-count">{events.length}</span>}</button>)}</nav>
  </header>
  <main id="main" tabIndex={-1}>
   {connectionError && <div className="message error" role="alert">{connectionError}</div>}
   {error && !editing && <div className="message error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16}/></button></div>}
   {notice && <div className="message success" role="status"><Check size={16}/><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={16}/></button></div>}
   {page === 'history' && <ExperimentHistory lastRunID={lastRun?.id} disabled={disable} onOpenLab={() => setPage('lab')} onRestore={run => void action(async () => { if (!run.scenarioSnapshot) throw new Error('This experiment has no saved configuration.'); await api('/scenario', 'PUT', run.scenarioSnapshot); setMode(run.mode); setPage('lab'); setNotice('Saved configuration restored and armed. Run a new experiment to compare results.'); })}/>}
   {(page === 'lab' || page === 'traffic') && <>
    <section className="page-heading"><div><div className="eyebrow">LOCAL WORKSPACE / {page === 'lab' ? '01' : '02'}</div><h1>{page === 'lab' ? 'Failure lab' : 'Request stream'}</h1><p>{page === 'lab' ? 'A controlled failure. An observable consequence.' : 'What reached the server, and what made it back.'}</p></div><span className="heading-note">{state?.demoAvailable ? 'Bundled workout API' : state ? 'External API' : 'Connecting to your workspace'}<span>HTTP · local SQLite history</span></span></section>
    <section className="connection-strip" aria-label="Proxy connection"><div><span className="field-label">Send requests to</span><button className="copy-address" disabled={!state} aria-label="Copy proxy address" onClick={() => state && void copy(state.proxyUrl)}><code>{state?.proxyUrl || 'Connecting…'}</code><Copy size={13}/></button></div><div className="connection-route" aria-hidden="true"><span/><span className="route-label">blackbox</span><ArrowRight size={16}/></div><div><span className="field-label">Forwarded to</span><code>{state?.target || 'Waiting for target…'}</code></div></section>
    {page === 'lab' && <div className="experiment-grid">
     <section className="setup-panel" aria-label="Experiment setup">
      <div className="section-title"><h2>Configure the experiment</h2><div className="inline-actions"><button disabled={disable} onClick={() => fileInput.current?.click()}><Upload size={14}/>Import</button><a href="/api/scenario" download="blackbox-scenario.json"><ArrowDownToLine size={14}/>Export JSON</a></div></div>
      <input ref={fileInput} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Import scenario JSON" onChange={e => void importScenario(e)}/>
      <div className="step-label"><span>01</span>Choose a failure</div>
      <div className="scenario-list" aria-label="Failure presets">{presets.map((preset,index) => <button key={preset.name} disabled={disable} aria-pressed={activePreset === index} className={`scenario-card ${activePreset === index ? 'selected' : ''}`} onClick={() => applyScenario(preset)}><span className="radio" aria-hidden="true"/><span className="scenario-copy"><strong>{preset.name}</strong><span>{preset.description}</span></span><span className="scenario-meta">{index === 0 ? 'DROP × 1' : index === 1 ? '1,500 ms' : '503 × 2'}</span></button>)}</div>
      <div className="active-rule"><div className="rule-heading"><span className="active-name">{state?.scenario.name || 'Loading scenario…'}</span><span className={`pill ${remaining ? 'armed' : ''}`}>{remaining ? 'Armed' : 'Exhausted'}</span></div><div className="rule-list">{state?.scenario.rules.map(rule => <div className="rule-item" key={rule.id}><div><span className="method">{rule.method}</span><code>{rule.path}</code></div><div className="rule-secondary"><span>{rule.enabled ? faultLabel(rule.kind) : 'Disabled'}</span><span>{state.counts[rule.id] || 0} / {rule.limit} used</span></div></div>)}</div>{state?.scenario.rules.length === 0 && <p className="muted">No fault rules. All requests pass through.</p>}<div className="rule-actions"><button disabled={disable} onClick={() => void action(async () => { await api('/scenario/reset', 'POST', {}); setNotice('Fault counters reset. The scenario is armed again.'); })}><RotateCcw size={13}/>Re-arm faults</button><button aria-label="Edit scenario" disabled={disable} onClick={openEditor}>Edit rules<ArrowRight size={13}/></button></div></div>
      {state?.demoAvailable && <><div className="step-label"><span>02</span>Choose a client</div><div className="segmented" aria-label="Demo client behavior"><button aria-pressed={mode === 'fragile'} disabled={disable} className={mode === 'fragile' ? 'chosen' : ''} onClick={() => setMode('fragile')}>Unprotected</button><button aria-pressed={mode === 'resilient'} disabled={disable} className={mode === 'resilient' ? 'chosen' : ''} onClick={() => setMode('resilient')}>Idempotent</button></div><p className="client-explanation">{mode === 'fragile' ? 'Every retry creates a new write. A lost response can create a duplicate.' : 'Retries reuse the same key. This demo API returns the original workout.'}</p></>}
      {!state?.demoAvailable && state && <p className="external-note">The demo is disabled for custom targets. Send your own requests to the proxy.</p>}
      <button className="button primary run-button" disabled={disable || !state?.demoAvailable} onClick={() => void runExperiment()}>{running ? <Loader2 size={16} className="spin"/> : <Play size={14} fill="currentColor"/>}{running ? 'Experiment running…' : 'Run experiment'}<ArrowRight size={16}/></button>{state?.demoAvailable && <p className="run-note">Fresh dataset and fault counters on every run.</p>}
     </section>
     <section className="result-panel" aria-label="Experiment result" aria-busy={running}>
      <div className="result-heading"><h2>Latest result</h2><span className="mono muted small-text">{lastRun && !running ? time(lastRun.startedAt) : '—'}</span></div>
      <div aria-live="polite" className="result-content">
       {running ? <div className="result-empty"><Loader2 className="spin" size={28}/><h3>Waiting for the client.</h3><p>The proxy is applying your fault rules.<br/>The result appears when the retries finish.</p></div> : lastRun ? <div className="result-body">
        <div className={`verdict ${lastRun.passed ? 'passed' : 'failed'}`}><span className="verdict-dot"/>{lastRun.passed ? 'Invariant held' : 'Invariant broken'}</div>
        <div className="result-number"><strong className={lastRun.passed ? 'green-text' : 'red-text'}>{lastRun.storedWorkouts}</strong><div>workout{lastRun.storedWorkouts === 1 ? '' : 's'} stored<span>Expected exactly 1</span></div></div>
        <h3>{lastRun.passed ? 'One action. One workout.' : lastRun.storedWorkouts > 1 ? 'One action. Duplicate writes.' : 'The client did not recover.'}</h3>
        <p className="result-context">{lastRun.scenario} <span>·</span> {lastRun.mode === 'resilient' ? 'Idempotent client' : 'Unprotected client'}</p>
        <div className="attempt-flow">{lastRun.attempts.map(attempt => <div className="attempt" key={attempt.number}><span className={`attempt-symbol ${attempt.outcome === 'received' ? 'good' : 'bad'}`}>{attempt.outcome === 'received' ? <Check size={15}/> : <X size={15}/>}</span><div><strong>Attempt {attempt.number}</strong><span>{attempt.outcome === 'received' ? `${attempt.status} · received` : attempt.status ? `${attempt.status} · HTTP error` : 'Connection lost'}</span></div></div>)}</div>
        <div className="assertion"><code>stored_workouts == 1</code><span className={lastRun.passed ? 'green-text' : 'red-text'}>actual: {lastRun.storedWorkouts}</span></div><div className="result-footer"><span>{lastRun.attempts.length} requests · {lastRun.durationMs.toLocaleString()} ms</span><span className="mono">{lastRun.id.slice(0,8)}</span></div><button className="text-link result-compare" onClick={() => setPage('history')}>Compare saved experiments<ArrowRight size={14}/></button>
       </div> : <div className="result-empty"><span className="empty-diagram" aria-hidden="true"><i/><span/><i className="break"/><span/><i/></span><h3>{state?.demoAvailable === false ? 'Your API. Your experiment.' : 'Start with a lost response.'}</h3><p>{state?.demoAvailable === false ? 'Send traffic through the proxy, then inspect each request in the stream below.' : 'Run the unprotected client first. Then repeat with idempotency and compare the writes.'}</p><span className="empty-caption">{state?.demoAvailable === false ? 'External requests appear in the request stream.' : 'The API writes successfully. Does the client know?'}</span></div>}
      </div><div className="result-bottom-note">{state?.demoAvailable === false ? 'Any result above belongs to a previous bundled demo.' : 'Results are saved locally with their original fault rules.'}</div>
     </section>
    </div>}
    <section className="traffic-section" aria-label="Request stream"><div className="section-title"><h2>Request stream<span className="live-label"><span className="status-dot"/>Live</span></h2><span className="traffic-summary">{events.length} requests <span>/</span> {faults} faults <span>/</span> {Math.round(avg)} ms avg.</span></div>
     <div className="traffic-panel"><div className="traffic-toolbar"><div className="traffic-filters"><button aria-pressed={!onlyFaults} className={!onlyFaults ? 'chosen' : ''} onClick={() => setOnlyFaults(false)}>All traffic<span>{events.length}</span></button><button aria-pressed={onlyFaults} className={onlyFaults ? 'chosen' : ''} onClick={() => setOnlyFaults(true)}>Injected faults<span>{faults}</span></button></div><div className="search"><Search size={15}/><input aria-label="Filter requests" placeholder="Filter by path, method or status" value={query} onChange={e => setQuery(e.target.value)}/></div></div>
      <div className="request-table"><div className="request-row table-head" aria-hidden="true"><span>Time</span><span>Request</span><span>Result</span><span>Fault</span><span>Duration</span><span/></div>{filtered.length ? filtered.map(event => <button key={event.id} className="request-row data-row" onClick={() => setSelected(event)} aria-label={`Inspect ${event.method} ${event.path}, ${event.status || 'connection dropped'}`}><span className="mono muted request-time">{time(event.startedAt)}</span><span className="request-path"><span className="method">{event.method}</span><code>{event.path}</code></span><span><span className={`status-code ${event.status >= 200 && event.status < 400 ? 'ok' : 'bad'}`}>{event.status || 'DROP'}</span></span><span className={event.fault ? 'fault-name' : 'muted'}>{event.fault ? faultLabel(event.fault) : '—'}</span><span className="mono duration">{event.durationMs.toFixed(1)} <span>ms</span></span><ChevronRight size={14}/></button>) : <div className="traffic-empty"><strong>{events.length ? 'No matching requests' : 'No requests yet'}</strong><p>{events.length ? 'Try another filter or switch to all traffic.' : 'Run an experiment or send a request to the proxy.'}</p></div>}</div>
      <div className="table-footer"><span>Metadata only. No headers or bodies recorded.</span><span>Newest first · up to 200 visible</span></div>
     </div>
    </section>
   </>}
   {page === 'guide' && <section className="guide"><div className="page-heading"><div><div className="eyebrow">REFERENCE / 04</div><h1>Field guide</h1><p>Set up a failure, read the evidence, keep the case.</p></div></div><div className="guide-cards">
    <article><span className="section-number">01</span><div><h2>Run the comparison</h2><p>Choose <strong>The lost response</strong> and run the <strong>Unprotected</strong> client. The API saves the first workout, but its response is dropped. A retry creates a second workout.</p><p>Switch to <strong>Idempotent</strong> and run again. Both attempts carry the same key, so the demo API returns the original write. Each experiment gets a fresh dataset and re-arms the rules.</p><button className="button secondary" onClick={() => setPage('lab')}>Open failure lab<ArrowRight size={14}/></button></div></article>
    <article><span className="section-number">02</span><div><h2>Connect your own API</h2><p>Restart the server with your upstream origin. Configure your application's API base URL to use the proxy.</p><pre>blackbox serve -target http://127.0.0.1:8000</pre><p>Client entry point:</p><pre>http://127.0.0.1:9091</pre><p>Edit a rule to match an exact path and method. Other requests pass through. The built-in experiment is disabled for custom targets. An idempotency header only works when your API implements deduplication.</p></div></article>
    <article><span className="section-number">03</span><div><h2>Keep a reproducible case</h2><p>Export the scenario to version control. Run it against the bundled demo from your terminal:</p><pre>blackbox run -scenario case.json -mode resilient</pre><p>Exit code 0 means one workout was stored and the client received a successful response. Failed assertions return exit code 1.</p><p>Rules reproduce the fault schedule. External applications also require known initial data and controlled client traffic.</p></div></article>
    <article><span className="section-number">04</span><div><h2>Know the boundaries</h2><p>HTTP request/response only. No WebSockets, HTTPS interception, database snapshots or distributed replay.</p><p>The first eligible rule wins. Concurrent traffic shares its budget. Re-arming affects future requests.</p><p>Only method, path, timing, status and fault metadata are stored. Paths can still contain sensitive identifiers. Local history retains 5,000 requests and 100 demo results. Fault counters reset on restart.</p></div></article>
   </div></section>}
   <footer className="page-footer"><span><span className="brand-mark" aria-hidden="true"/>blackbox</span><span>Local HTTP experiments. Stored on your machine.</span><a href="#main">Back to top ↑</a></footer>
  </main>
  <dialog ref={dialog} aria-labelledby="editor-title" onCancel={() => setEditing(false)} onClose={() => setEditing(false)} className="editor-dialog"><div className="dialog-heading"><div><span className="eyebrow">SCENARIO / JSON</span><h2 id="editor-title">Edit fault rules</h2></div><button className="icon-button" onClick={() => setEditing(false)} aria-label="Close editor"><X size={20}/></button></div><p className="muted">Paths match exactly. The first eligible rule wins. Saving re-arms every rule.</p><textarea aria-label="Scenario JSON" spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)}/><p className="editor-help">Kinds: <code>drop_response</code>, <code>latency</code> (delayMs: 1–10000), <code>http_error</code> (status: 400–599). Limit: 1–10000.</p>{error && <div role="alert" className="message error">{error}</div>}<div className="dialog-actions"><button className="button secondary" onClick={() => setEditing(false)}>Cancel</button><button className="button primary" disabled={busy} onClick={() => void action(async () => { let parsed: unknown; try { parsed = JSON.parse(draft); } catch { throw new Error('Check the JSON syntax before saving.'); } await api('/scenario', 'PUT', parsed); setEditing(false); setNotice('Scenario saved and armed.'); })}><Check size={15}/>Save scenario</button></div></dialog>
  <dialog ref={detailsDialog} aria-labelledby="request-title" onCancel={() => setSelected(null)} onClose={() => setSelected(null)} className="details-dialog">{selected && <><div className="dialog-heading"><div><span className="eyebrow">REQUEST / {selected.id.toString().padStart(4,'0')}</span><h2 id="request-title"><span className="method">{selected.method}</span>{' '}{selected.path}</h2></div><button className="icon-button" aria-label="Close request details" onClick={() => setSelected(null)}><X size={20}/></button></div><div className="response-comparison"><div><span>Upstream returned</span><strong>{selected.upstreamStatus || '—'}</strong></div><ArrowRight size={20}/><div><span>Client received</span><strong className={!selected.status ? 'red-text' : ''}>{selected.status || 'Nothing'}</strong></div></div><dl className="detail-list"><div><dt>Outcome</dt><dd>{outcomeLabel(selected.outcome)}</dd></div><div><dt>Client received</dt><dd>{selected.status || 'No HTTP response'}</dd></div><div><dt>Upstream status</dt><dd>{selected.upstreamStatus || 'No upstream response'}</dd></div><div><dt>Duration</dt><dd>{selected.durationMs.toFixed(2)} ms</dd></div><div><dt>Applied fault</dt><dd>{faultLabel(selected.fault)}</dd></div><div><dt>Rule</dt><dd>{selected.rule || 'None'}</dd></div><div><dt>Started at</dt><dd>{new Date(selected.startedAt).toLocaleString()}</dd></div><div><dt>Experiment</dt><dd className="mono">{selected.runId || 'External request'}</dd></div></dl><p className="detail-note">{selected.outcome === 'response_dropped' ? 'The upstream returned a response. Blackbox closed the client connection before delivering it. The client cannot tell whether its write succeeded.' : 'Observed request metadata. Request and response contents are not captured.'}</p></>}</dialog>
 </div>;
}
export default App;
