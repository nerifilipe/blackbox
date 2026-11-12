import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeftRight, ArrowRight, CheckCircle2, Clock3, FlaskConical, History, Loader2, RotateCcw, Search, ShieldCheck, Unplug, XCircle } from 'lucide-react';
import type { Run, Scenario } from './types';

type Props = { lastRunID?: string; disabled: boolean; onOpenLab: () => void; onRestore: (run: Run) => void };
const timestamp = (value: string) => new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const modeLabel = (run: Run) => run.mode === 'resilient' ? 'Idempotent' : 'Unprotected';

// Compare behavior, not display labels or irrelevant settings. Order matters:
// the proxy applies the first eligible rule. Disabled rules do not participate.
function configuration(scenario: Scenario) {
 return JSON.stringify({ version: scenario.version, rules: scenario.rules.filter(rule => rule.enabled).map(rule => ({
  method: rule.method, path: rule.path, kind: rule.kind, limit: rule.limit,
  delayMs: rule.kind === 'latency' ? rule.delayMs : 0,
  status: rule.kind === 'http_error' ? rule.status : 0,
 })) });
}

function RunCard({ run, slot, disabled, onRestore }: { run?: Run; slot: string; disabled: boolean; onRestore: Props['onRestore'] }) {
 if (!run) return <article className="panel comparison-empty"><History size={26}/><h3>Select a {slot.toLowerCase()}</h3><p>Choose a retained experiment to inspect its recorded result.</p></article>;
 return <article className="panel comparison-card" aria-label={`${slot} experiment`}>
  <div className="panel-header"><h2><span className="slot-label">{slot === 'Baseline' ? 'A' : 'B'}</span>{slot}</h2><span className="mono muted small-text">{run.id.slice(0, 8)}</span></div>
  <div className="comparison-card-body">
   <div className={`history-verdict ${run.passed ? 'green-text' : 'red-text'}`}>{run.passed ? <CheckCircle2 size={23}/> : <XCircle size={23}/>}<span>INVARIANT {run.passed ? 'HELD' : 'BROKEN'}</span></div>
   <h3>{run.scenario}</h3><div className="run-context"><span>{modeLabel(run)} client</span><span>{timestamp(run.startedAt)}</span></div>
   <div className="run-metrics"><div><span>STORED WORKOUTS</span><strong>{run.storedWorkouts}<small>expected 1</small></strong></div><div><span>ATTEMPTS</span><strong>{run.attempts.length}</strong></div><div><span>DURATION</span><strong>{run.durationMs.toLocaleString()}<small>ms</small></strong></div></div>
   <ol className="history-attempts">{run.attempts.map(attempt => <li key={attempt.number}><span className={attempt.outcome === 'received' ? 'green-text' : 'red-text'}>{attempt.outcome === 'received' ? <CheckCircle2 size={15}/> : <Unplug size={15}/>}</span><strong>Attempt {attempt.number}</strong><span>{attempt.status || 'No response'}</span><small>{attempt.outcome.replaceAll('_', ' ')}</small></li>)}</ol>
   {run.scenarioSnapshot ? <details className="recorded-rules"><summary>Recorded fault rules <span>{run.scenarioSnapshot.rules.length}</span></summary><pre>{JSON.stringify(run.scenarioSnapshot.rules, null, 2)}</pre></details> : <p className="legacy-note">Legacy run: the result was saved before configuration snapshots were introduced. Its original rules cannot be recovered.</p>}
  </div>
  <div className="comparison-actions"><a href={`/api/runs/${encodeURIComponent(run.id)}`} download="blackbox-experiment.json"><ArrowDownToLine size={13}/>Export result</a><button disabled={disabled || !run.scenarioSnapshot} onClick={() => onRestore(run)}><RotateCcw size={13}/>Restore setup</button></div>
 </article>;
}

export default function ExperimentHistory({ lastRunID, disabled, onOpenLab, onRestore }: Props) {
 const [runs, setRuns] = useState<Run[]>([]);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState('');
 const [revision, setRevision] = useState(0);
 const [baselineID, setBaselineID] = useState('');
 const [candidateID, setCandidateID] = useState('');
 const [query, setQuery] = useState('');
 const initialized = useRef(false);
 useEffect(() => {
  const controller = new AbortController(); let active = true;
  setLoading(true);
  async function load() {
   try {
    const response = await fetch('/api/runs', { signal: controller.signal });
    if (!response.ok) throw new Error('Could not load experiment history.');
    const data: { runs: Run[] } = await response.json();
    if (!active) return;
    setRuns(data.runs); setError('');
    if (!initialized.current && data.runs.length) {
     initialized.current = true;
     setBaselineID(data.runs.length > 1 ? data.runs[1].id : data.runs[0].id);
     setCandidateID(data.runs.length > 1 ? data.runs[0].id : '');
    }
   } catch { if (active) setError('Could not load experiment history. Previously loaded results may be out of date.'); }
   finally { if (active) setLoading(false); }
  }
  void load();
  return () => { active = false; controller.abort(); };
 }, [lastRunID, revision]);

 const baseline = runs.find(run => run.id === baselineID);
 const candidate = runs.find(run => run.id === candidateID);
 const known = !!baseline?.scenarioSnapshot && !!candidate?.scenarioSnapshot && !!baseline.fixture && !!candidate.fixture;
 const comparable = known && baseline.fixture === candidate.fixture && configuration(baseline.scenarioSnapshot!) === configuration(candidate.scenarioSnapshot!);
 const changed = comparable && baseline.passed !== candidate.passed;
 const filtered = runs.filter(run => `${run.scenario} ${run.mode} ${modeLabel(run)} ${run.id}`.toLowerCase().includes(query.toLowerCase()));
 const title = !known ? 'Configuration unavailable.' : !comparable ? 'Different fault configurations.' : changed ? candidate.passed ? 'The invariant recovered.' : 'The invariant regressed.' : candidate.passed ? 'Both runs held the invariant.' : 'Both runs broke the invariant.';

 function select(slot: 'baseline' | 'candidate', id: string) {
  if (slot === 'baseline') { setBaselineID(id); if (candidateID === id) setCandidateID(''); }
  else { setCandidateID(id); if (baselineID === id) setBaselineID(''); }
 }

 return <section className="history-page">
  <div className="page-heading"><div><div className="eyebrow"><span/> SAVED RUNS / 03</div><h1>Experiments</h1><p>Compare two runs. Keep the evidence behind the result.</p></div><button className="button secondary" onClick={onOpenLab}><FlaskConical size={15}/>Open failure lab<ArrowRight size={15}/></button></div>
  {error && <div role="alert" className="message error"><XCircle size={16}/>{error}</div>}
  <div className="section-title"><h2><span className="section-number">01</span>Compare experiments</h2><button className="history-refresh" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? <Loader2 size={13} className="spin"/> : <RotateCcw size={13}/>}Refresh history</button></div>
  {loading && !runs.length ? <div className="panel history-loading" role="status"><Loader2 size={22} className="spin"/>Loading experiment history…</div> : error && !runs.length ? <div className="panel history-empty"><Unplug size={28}/><h2>History is unavailable.</h2><p>Use Refresh history to try loading the saved results again.</p></div> : !runs.length ? <div className="panel history-empty"><div className="empty-orbit"><History size={27}/></div><h2>No saved experiments yet.</h2><p>Run the unprotected client, then the idempotent client.<br/>Both results will be saved for comparison.</p><button className="button primary" onClick={onOpenLab}>Start an experiment<ArrowRight size={14}/></button></div> : <>
   <div className="comparison-selectors">
    {(['baseline', 'candidate'] as const).map(slot => { const id = slot === 'baseline' ? baselineID : candidateID; return <label key={slot}><span>{slot === 'baseline' ? 'A / BASELINE' : 'B / COMPARISON'}</span><select aria-label={slot === 'baseline' ? 'Baseline experiment' : 'Comparison experiment'} value={id} onChange={event => select(slot, event.target.value)}><option value="">Choose an experiment</option>{id && !runs.some(run => run.id === id) && <option value={id}>No longer retained — choose another</option>}{runs.map(run => <option key={run.id} value={run.id}>{timestamp(run.startedAt)} · {modeLabel(run)} · {run.scenario} · {run.id.slice(0, 8)}</option>)}</select></label>; })}
    <button className="icon-button swap-runs" aria-label="Swap baseline and comparison" disabled={!baseline || !candidate} onClick={() => { setBaselineID(candidateID); setCandidateID(baselineID); }}><ArrowLeftRight size={19}/></button>
   </div>
   {baseline && candidate && <div className={`comparison-summary ${comparable ? changed ? candidate.passed ? 'improved' : 'regressed' : 'matched' : 'incomparable'}`} role="status"><div className="summary-symbol">{comparable ? <ShieldCheck size={24}/> : <Clock3 size={24}/>}</div><div><h2>{title}</h2><p>{!known ? 'At least one run has no recorded configuration or fixture version. Results are shown without attributing the difference to a fix.' : !comparable ? 'The saved rules or demo fixture differ. These results do not isolate the effect of the client change.' : 'Same ordered fault rules and demo fixture. Each run started with a fresh logical dataset.'}</p></div><div className="workout-delta"><span>WORKOUTS STORED</span><strong>{baseline.storedWorkouts}<ArrowRight size={19}/>{candidate.storedWorkouts}</strong></div></div>}
   <div className="comparison-grid"><RunCard slot="Baseline" run={baseline} disabled={disabled || !!error} onRestore={onRestore}/><RunCard slot="Comparison" run={candidate} disabled={disabled || !!error} onRestore={onRestore}/></div>
   <p className="comparison-footnote">Durations include injected delays and retry waits. These runs are functional evidence, not a performance benchmark. External traffic can consume the same fault budgets.</p>
   <div className="section-title history-list-title"><h2><span className="section-number">02</span>Saved experiments<span className="mini-tag">{runs.length} / 100</span></h2><div className="search"><Search size={14}/><input aria-label="Search experiments" placeholder="Scenario, client or run ID…" value={query} onChange={event => setQuery(event.target.value)}/></div></div>
   <div className="panel history-table-wrap"><table className="history-table"><thead><tr><th>EXPERIMENT</th><th>CLIENT</th><th>RESULT</th><th>WRITES</th><th>COMPARE</th></tr></thead><tbody>{filtered.map(run => <tr key={run.id} className={baselineID === run.id || candidateID === run.id ? 'selected-run' : ''}><td><strong>{run.scenario}</strong><span>{timestamp(run.startedAt)} <code>{run.id.slice(0, 8)}</code></span></td><td>{modeLabel(run)}</td><td><span className={`status-code ${run.passed ? 'ok' : 'bad'}`}>{run.passed ? 'HELD' : 'BROKEN'}</span>{!run.scenarioSnapshot && <span className="legacy-badge">LEGACY</span>}</td><td className="mono">{run.storedWorkouts}</td><td><div className="slot-buttons"><button aria-label={`Use ${run.id} as baseline`} aria-pressed={baselineID === run.id} onClick={() => select('baseline', run.id)}>A</button><button aria-label={`Use ${run.id} as comparison`} aria-pressed={candidateID === run.id} onClick={() => select('candidate', run.id)}>B</button></div></td></tr>)}</tbody></table>{!filtered.length && <div className="traffic-empty"><Search size={22}/><strong>No matching experiments</strong><p>Try a scenario name, client mode or run ID.</p></div>}<div className="table-footer"><span><History size={12}/>Completed runs only. The oldest results expire after 100 runs.</span><span>Newest first</span></div></div>
  </>}
 </section>;
}
