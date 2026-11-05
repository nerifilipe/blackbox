import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Activity, ArrowDown, ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCircle2, ChevronRight, Clock3, Code2, Copy, FileJson, FlaskConical, History, Layers3, Loader2, Network, Play, Plus, Radio, RotateCcw, Search, Settings2, ShieldCheck, Terminal, Unplug, Upload, X, XCircle, Zap } from 'lucide-react';
import ExperimentHistory from './ExperimentHistory';
import type { Scenario, TrafficEvent, Run, State } from './types';


const presets: Scenario[] = [
 { version: 1, name: 'The lost response', description: 'The server saves the workout. The response never arrives. Is a retry safe?', rules: [{ id: 'lost-response', name: 'Drop the first response', method: 'POST', path: '/workouts', kind: 'drop_response', limit: 1, delayMs: 0, status: 0, enabled: true }] },
 { version: 1, name: 'The slow lane', description: 'Add 1.5 seconds before the first request reaches the server. Watch the latency change.', rules: [{ id: 'slow-lane', name: 'Delay the first request', method: 'POST', path: '/workouts', kind: 'latency', limit: 1, delayMs: 1500, status: 0, enabled: true }] },
 { version: 1, name: 'Third time lucky', description: 'Return 503 twice, then let the request through. Can the client recover?', rules: [{ id: 'third-time', name: 'Fail the first two requests', method: 'POST', path: '/workouts', kind: 'http_error', limit: 2, delayMs: 0, status: 503, enabled: true }] },
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
 useEffect(() => { if (editing) dialog.current?.showModal(); else dialog.current?.close(); }, [editing]);
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
 function openEditor() { if (state) { setDraft(JSON.stringify(state.scenario, null, 2)); setEditing(true); } }
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
  <aside className="sidebar">
   <a href="#" className="brand" onClick={e => { e.preventDefault(); setPage('lab'); }} aria-label="Blackbox home"><span className="brand-mark"><Layers3 size={21}/></span>BLACKBOX</a>
   <div className="workspace"><span className="workspace-icon"><Terminal size={17}/></span><div><strong>Local workspace</strong><span>Personal environment</span></div><ChevronRight size={14}/></div>
   <div className="nav-label">WORKSPACE</div>
   <nav aria-label="Main navigation">
    <button className={page === 'lab' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('lab')}><FlaskConical size={18}/>Failure lab<span className="nav-counter">01</span></button>
    <button className={page === 'traffic' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('traffic')}><Activity size={18}/>Request stream<span className="nav-counter">{events.length}</span></button>
    <button className={page === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('history')}><History size={18}/>Experiments</button>
    <button className={page === 'guide' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('guide')}><BookOpen size={18}/>Field guide<ArrowUpRight size={14}/></button>
   </nav>
   <div className="sidebar-bottom">
    <div className="local-note"><span className="tiny-cross">+</span><strong>Your machine.<br/>Your experiments.</strong><p>Traffic metadata stays in your local SQLite database.</p><span className="local-label"><ShieldCheck size={13}/> LOCAL BY DESIGN</span></div>
    <div className="sidebar-version"><span className="status-dot"/>Blackbox <span>v0.3.0</span></div>
   </div>
  </aside>

  <div className="main-shell">
   <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13}/><strong>{page === 'lab' ? 'Failure lab' : page === 'traffic' ? 'Request stream' : page === 'history' ? 'Experiments' : 'Field guide'}</strong></div><div className="topbar-status"><span className={`status-dot ${connectionError ? 'offline' : ''}`}/>{connectionError ? 'Disconnected' : state ? 'Local proxy online' : 'Connecting'}<span className="topbar-divider"/><span className="mono">HTTP / 1.1</span></div></header>
   <main>
    {connectionError && <div className="message error" role="alert"><Unplug size={16}/>{connectionError}</div>}
    {error && <div className="message error" role="alert"><XCircle size={16}/><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
    {notice && <div className="message success" role="status"><Check size={16}/><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={15}/></button></div>}

    {page === 'history' && <ExperimentHistory lastRunID={lastRun?.id} disabled={disable} onOpenLab={() => setPage('lab')} onRestore={run => void action(async () => { if (!run.scenarioSnapshot) throw new Error('This experiment has no saved configuration.'); await api('/scenario', 'PUT', run.scenarioSnapshot); setMode(run.mode); setPage('lab'); setNotice('Saved configuration restored and armed. Run a new experiment to compare results.'); })}/>}

    {(page === 'lab' || page === 'traffic') && <>
     <section className="page-heading"><div><div className="eyebrow"><span/> ENGINEERING FOR THE UNEXPECTED</div><h1>{page === 'lab' ? 'Make failure repeatable.' : 'Every request. In focus.'}</h1><p>{page === 'lab' ? 'Break the connection. Understand the consequence.' : 'Inspect what reached the server — and what made it back.'}</p></div><button className="button primary" disabled={disable || !state?.demoAvailable} onClick={() => void runExperiment()}>{running ? <Loader2 size={16} className="spin"/> : <Play size={15} fill="currentColor"/>}{running ? 'Experiment running…' : 'Run experiment'}<span className="button-arrow"><ArrowUpRight size={16}/></span></button></section>

     <section className="connection-strip" aria-label="Proxy connection"><div className="connection-node"><span className="node-icon"><Terminal size={17}/></span><div><label>CLIENT ENTRY POINT</label><button className="copy-address" disabled={!state} onClick={() => state && void copy(state.proxyUrl)}><code>{state?.proxyUrl || 'Connecting…'}</code><Copy size={12}/></button></div></div><div className="connection-line"><span/><ArrowRight size={16}/></div><div className="proxy-node"><span className="brand-mark small"><Layers3 size={16}/></span><strong>Blackbox</strong><span className="mini-tag">PROXY</span></div><div className="connection-line"><span/><ArrowRight size={16}/></div><div className="connection-node"><span className="node-icon"><Network size={17}/></span><div><label>{state?.demoAvailable ? 'BUNDLED WORKOUT API' : 'UPSTREAM TARGET'}</label><code>{state?.target || '—'}</code></div><span className="status-dot"/></div></section>

     {page === 'lab' && <>
      <div className="section-title"><h2><span className="section-number">01</span>Choose your failure</h2><div className="inline-actions"><button disabled={disable} onClick={() => fileInput.current?.click()}><Upload size={14}/>Import</button><a href="/api/scenario" download="blackbox-scenario.json"><ArrowDownToLine size={14}/>Export JSON</a></div></div>
      <input ref={fileInput} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Import scenario JSON" onChange={e => void importScenario(e)}/>
      <div className="scenario-grid">{presets.map((preset, index) => <button key={preset.name} disabled={disable} className={`scenario-card ${activePreset === index ? 'selected' : ''}`} onClick={() => applyScenario(preset)}><div className="scenario-top"><span className="scenario-icon">{index === 0 ? <Unplug size={20}/> : index === 1 ? <Clock3 size={20}/> : <Zap size={20}/>}</span><span className="scenario-index">0{index + 1}</span>{activePreset === index ? <span className="radio selected"><span/></span> : <span className="radio"/>}</div><h3>{preset.name}</h3><p>{preset.description}</p><div className="scenario-meta"><span>{faultLabel(preset.rules[0].kind)}</span><span>{index === 0 ? '1 response' : index === 1 ? '+1,500 ms' : '503 × 2'}</span></div></button>)}</div>

      <div className="experiment-grid">
       <section className="panel controls-panel"><div className="panel-header"><h2><Settings2 size={16}/>Experiment setup</h2><button className="icon-button" title="Edit scenario" aria-label="Edit scenario" disabled={disable} onClick={openEditor}><Code2 size={16}/></button></div>
        <div className="controls-body"><div className="label-row"><label>ACTIVE SCENARIO</label><span className={`pill ${remaining ? 'amber' : ''}`}><span className="status-dot"/>{remaining ? 'Armed' : 'Exhausted'}</span></div><div className="active-name">{state?.scenario.name || 'Loading scenario…'}</div>
         <div className="rule-list">{state?.scenario.rules.map(rule => <div className="rule-item" key={rule.id}><div><span className="method">{rule.method}</span><code>{rule.path}</code></div><div className="rule-secondary"><span>{rule.enabled ? faultLabel(rule.kind) : 'Disabled'}</span><span>{state.counts[rule.id] || 0} / {rule.limit} used</span></div></div>)}{state?.scenario.rules.length === 0 && <p className="muted">No fault rules. All requests pass through.</p>}</div>
         <div className="label-row client-label"><label>DEMO CLIENT BEHAVIOR</label><span className="hint-tag">COMPARE BOTH</span></div>
         <div className="segmented" aria-label="Demo client behavior"><button aria-pressed={mode === 'fragile'} disabled={busy} className={mode === 'fragile' ? 'chosen' : ''} onClick={() => setMode('fragile')}><Unplug size={14}/>Unprotected</button><button aria-pressed={mode === 'resilient'} disabled={busy} className={mode === 'resilient' ? 'chosen' : ''} onClick={() => setMode('resilient')}><ShieldCheck size={14}/>Idempotent</button></div>
         <p className="client-explanation">{mode === 'fragile' ? 'Retries create a new write. A lost response can turn one workout into two.' : 'Retries reuse the same idempotency key. The server returns the original workout.'}</p>
         {!state?.demoAvailable && state && <p className="client-explanation amber-text">The demo is disabled for custom targets. Send your own requests to the proxy.</p>}
        </div><div className="panel-footer"><button disabled={disable} onClick={() => void action(async () => { await api('/scenario/reset', 'POST', {}); setNotice('Fault counters reset. The scenario is armed again.'); })}><RotateCcw size={13}/>Re-arm faults</button><button disabled={disable} onClick={openEditor}>Edit rules<ArrowUpRight size={13}/></button></div>
       </section>

       <section className="panel result-panel"><div className="panel-header"><h2><FlaskConical size={16}/>Experiment result</h2>{lastRun ? <span className="mono muted small-text">{time(lastRun.startedAt)}</span> : <span className="mini-tag">AWAITING RUN</span>}</div>
        {running ? <div className="result-empty"><div className="empty-orbit running"><Loader2 className="spin" size={27}/></div><h3>Putting the system under pressure.</h3><p>Real HTTP requests. Deliberate failures.<br/>Waiting for the client to recover.</p></div> : lastRun ? <div className="result-body">
         <div className={`verdict ${lastRun.passed ? 'passed' : 'failed'}`}>{lastRun.passed ? <CheckCircle2 size={28}/> : <XCircle size={28}/>}<div><span>INVARIANT {lastRun.passed ? 'HELD' : 'BROKEN'}</span><h3>{lastRun.passed ? 'One action. One workout.' : lastRun.storedWorkouts > 1 ? 'One action. Duplicate writes.' : 'The client did not recover.'}</h3></div></div>
         <p className="result-context">{lastRun.scenario} <span>·</span> {lastRun.mode === 'resilient' ? 'Idempotent client' : 'Unprotected client'}</p>
         <div className="attempt-flow">{lastRun.attempts.map((attempt, index) => <div className="attempt" key={attempt.number}><div className={`attempt-symbol ${attempt.outcome === 'received' ? 'good' : 'bad'}`}>{attempt.outcome === 'received' ? <Check size={16}/> : <Unplug size={16}/>}</div><div><strong>Attempt {attempt.number}</strong><span>{attempt.outcome === 'received' ? `${attempt.status} · received` : attempt.status ? `${attempt.status} · HTTP error` : 'Connection lost'}</span></div>{index < lastRun.attempts.length - 1 && <ArrowRight className="attempt-arrow" size={17}/>}</div>)}</div>
         <div className="assertion"><code>stored_workouts == 1</code><span className={lastRun.passed ? 'green-text' : 'red-text'}>actual: {lastRun.storedWorkouts}<span className="assertion-icon">{lastRun.passed ? <Check size={14}/> : <X size={14}/>}</span></span></div>
         <div className="result-footer"><span>{lastRun.attempts.length} request{lastRun.attempts.length > 1 ? 's' : ''} · {lastRun.durationMs.toLocaleString()} ms</span><span className="mono">run / {lastRun.id.slice(0, 8)}</span></div>
        </div> : <div className="result-empty"><div className="empty-orbit"><FlaskConical size={28}/><span className="orbit-dot"/></div><h3>A little chaos. A lot of clarity.</h3><p>Run the unprotected client first.<br/>Then add idempotency and compare the outcome.</p><button disabled={disable || !state?.demoAvailable} onClick={() => void runExperiment()}>Run your first experiment<ArrowRight size={15}/></button></div>}
       </section>
      </div>
     </>}

     <section className="traffic-section"><div className="section-title"><h2><span className="section-number">{page === 'lab' ? '02' : '01'}</span>Request stream<span className="live-label"><Radio size={12}/>LIVE</span></h2><span className="small-text muted">Latest {events.length} requests · refreshes every second</span></div>
      <div className="metrics"><div><span>REQUESTS OBSERVED</span><strong>{events.length.toString().padStart(2, '0')}<Activity size={20}/></strong></div><div><span>FAULTS APPLIED</span><strong>{faults.toString().padStart(2, '0')}<Zap size={20}/></strong></div><div><span>AVERAGE DURATION</span><strong>{Math.round(avg).toLocaleString()}<small>ms</small><div className="spark-bars" aria-hidden="true">{events.slice(0, 24).reverse().map(e => <i key={e.id} style={{ height: `${Math.max(3, Math.min(25, e.durationMs / Math.max(...events.map(x => x.durationMs), 1) * 25))}px` }}/>)}</div></strong></div></div>
      <div className="panel traffic-panel"><div className="traffic-toolbar"><div className="traffic-filters"><button className={!onlyFaults ? 'chosen' : ''} onClick={() => setOnlyFaults(false)}>All traffic<span>{events.length}</span></button><button className={onlyFaults ? 'chosen' : ''} onClick={() => setOnlyFaults(true)}>Injected faults<span>{faults}</span></button></div><div className="search"><Search size={14}/><input aria-label="Filter requests" placeholder="Filter requests…" value={query} onChange={e => setQuery(e.target.value)}/></div></div>
       <div className="request-table"><div className="request-row table-head"><span>TIME<ArrowDown size={11}/></span><span>REQUEST</span><span>RESULT</span><span>FAULT</span><span>DURATION</span><span/></div>
        {filtered.length ? filtered.map(event => <button key={event.id} className="request-row data-row" onClick={() => setSelected(event)} aria-label={`Inspect ${event.method} ${event.path}, ${event.status || 'connection dropped'}`}><span className="mono muted">{time(event.startedAt)}</span><span className="request-path"><span className="method">{event.method}</span><code>{event.path}</code></span><span><span className={`status-code ${event.status >= 200 && event.status < 400 ? 'ok' : 'bad'}`}>{event.status || 'DROP'}</span></span><span className={event.fault ? 'fault-name' : 'muted'}>{event.fault ? faultLabel(event.fault) : '—'}</span><span className="mono duration">{event.durationMs.toFixed(1)} <span>ms</span></span><ChevronRight size={14}/></button>) : <div className="traffic-empty"><Activity size={23}/><strong>{events.length ? 'No matching requests' : 'Your next request starts the story.'}</strong><p>{events.length ? 'Try another filter or switch to all traffic.' : 'Run an experiment or point your application at the proxy address above.'}</p></div>}
       </div><div className="table-footer"><span><ShieldCheck size={12}/>Metadata only. No headers or bodies recorded.</span><span>Newest first · up to 200 visible</span></div>
      </div>
     </section>
    </>}

    {page === 'guide' && <section className="guide"><div className="eyebrow"><span/> THE BLACKBOX FIELD GUIDE</div><h1>Learn from the breakage.</h1><p className="guide-lead">A small, deliberate failure can reveal a big assumption.</p><div className="guide-cards"><article className="panel"><span className="section-number">01</span><h2>Run the comparison</h2><p>Choose <strong>The lost response</strong> and run the <strong>Unprotected</strong> client. The API saves the first workout, but its response is dropped. A retry creates a second workout.</p><p>Switch to <strong>Idempotent</strong> and run again. Both attempts carry the same key, so the API returns the original write. Each experiment gets a fresh dataset and re-arms the rules.</p><button className="button secondary" onClick={() => setPage('lab')}>Open failure lab<ArrowRight size={14}/></button></article><article className="panel"><span className="section-number">02</span><h2>Connect your own API</h2><p>Restart the server with your upstream origin. Then configure your application's API base URL to use the proxy.</p><pre>blackbox serve -target http://127.0.0.1:8000</pre><p>Client entry point:</p><pre>http://127.0.0.1:9091</pre><p>Edit a rule to match an exact path and method. Requests that do not match are forwarded normally. The built-in experiment is disabled for custom targets.</p></article><article className="panel"><span className="section-number">03</span><h2>Keep a reproducible case</h2><p>Export the scenario to version control. Run it against the bundled demo from your terminal:</p><pre>blackbox run -scenario case.json -mode resilient</pre><p>The CLI returns exit code 0 when one workout is stored and the client receives a successful response. Failed assertions return exit code 1.</p><p>Rules reproduce the fault schedule. Reproducing an external application also requires known initial data and controlled client traffic.</p></article><article className="panel"><span className="section-number">04</span><h2>Know the boundaries</h2><p>HTTP request/response only. No WebSockets, HTTPS interception, automatic database snapshots or distributed replay.</p><p>The first eligible rule wins. Its budget is reserved atomically when a request arrives; concurrent traffic shares that budget. Re-arming affects future requests.</p><p>Only method, path, timing, status and fault metadata are stored. Query strings, headers and bodies are omitted. Paths can still contain sensitive identifiers.</p><p>Local history retains 5,000 requests and 100 demo results. Fault counters reset on restart.</p></article></div></section>}
    <footer className="page-footer"><span>BLACKBOX<span className="footer-slash">/</span>OBSERVE. DISRUPT. UNDERSTAND.</span><span>Built for the things that don't go to plan.<Plus size={13}/></span></footer>
   </main>
  </div>

  <dialog ref={dialog} onCancel={() => setEditing(false)} onClose={() => setEditing(false)} className="editor-dialog"><div className="dialog-heading"><div><span className="eyebrow">SCENARIO / JSON</span><h2>Edit the experiment</h2></div><button className="icon-button" onClick={() => setEditing(false)} aria-label="Close editor"><X size={20}/></button></div><p className="muted">Rules match exact paths. The first eligible rule wins. Saving re-arms every rule.</p><textarea aria-label="Scenario JSON" spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)}/><p className="editor-help">Kinds: <code>drop_response</code>, <code>latency</code> (delayMs: 1–10000), <code>http_error</code> (status: 400–599). Limit: 1–10000.</p>{error && <div role="alert" className="message error">{error}</div>}<div className="dialog-actions"><button className="button secondary" onClick={() => setEditing(false)}>Cancel</button><button className="button primary" disabled={busy} onClick={() => void action(async () => { let parsed: unknown; try { parsed = JSON.parse(draft); } catch { throw new Error('Check the JSON syntax before saving.'); } await api('/scenario', 'PUT', parsed); setEditing(false); setNotice('Scenario saved and armed.'); })}><Check size={15}/>Save scenario</button></div></dialog>

  <dialog ref={detailsDialog} onCancel={() => setSelected(null)} onClose={() => setSelected(null)} className="details-dialog">{selected && <><div className="dialog-heading"><div><span className="eyebrow">REQUEST / {selected.id.toString().padStart(4, '0')}</span><h2><span className="method">{selected.method}</span>{selected.path}</h2></div><button className="icon-button" aria-label="Close request details" onClick={() => setSelected(null)}><X size={20}/></button></div><dl className="detail-list"><div><dt>Outcome</dt><dd>{outcomeLabel(selected.outcome)}</dd></div><div><dt>Client received</dt><dd>{selected.status || 'No HTTP response'}</dd></div><div><dt>Upstream status</dt><dd>{selected.upstreamStatus || 'No upstream response'}</dd></div><div><dt>Duration</dt><dd>{selected.durationMs.toFixed(2)} ms</dd></div><div><dt>Applied fault</dt><dd>{faultLabel(selected.fault)}</dd></div><div><dt>Rule</dt><dd>{selected.rule || 'None'}</dd></div><div><dt>Started at</dt><dd>{new Date(selected.startedAt).toLocaleString()}</dd></div><div><dt>Experiment</dt><dd className="mono">{selected.runId || 'External request'}</dd></div></dl><div className="detail-note"><FileJson size={19}/><p>{selected.outcome === 'response_dropped' ? 'The upstream returned a response, but Blackbox closed the client connection before delivering it. Check the upstream status above.' : 'This is the observed request metadata. The request and response contents are not captured.'}</p></div></>}</dialog>
 </div>;
}

export default App;
