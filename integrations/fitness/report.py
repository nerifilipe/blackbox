"""Portable, offline evidence report. Values are escaped; tokens and payloads are omitted."""

import base64
import html
import json
from pathlib import Path


def esc(value):
    return html.escape(str(value))


def render(report):
    passed = report["passed"]
    cases = report["cases"]
    count = sum(c["passed"] for c in cases)
    checks = sum(len(c["checks"]) for c in cases)
    cards, slides = [], []
    slides.append(f"""<section class="slide"><span class="eyebrow">01 / THE QUESTION</span>
      <h2>What if the server saved,<br>but the response never arrived?</h2>
      <p>A real Fitness Tracker API. A real PostgreSQL database.<br>Blackbox between the client and the server.</p>
      <div class="flow"><b>Test client</b><i>→</i><b>Blackbox proxy</b><i>→</i><b>Fitness API</b><i>→</i><b>PostgreSQL</b></div>
      <p class="muted">Recorded evidence · {esc(report["startedAt"])}</p></section>""")
    explanations = {
        "lost-response": (
            "The first request commits. Blackbox drops its HTTP 200 response. The client retries the exact same mutation_id.",
            "The retry returns applied_version = 2. PostgreSQL still contains one mutation receipt.",
        ),
        "temporary-503": (
            "Blackbox rejects two requests with HTTP 503 before they reach the API. The test client retries after 150 ms and 300 ms.",
            "The database is unchanged after each 503. The third request applies the change once.",
        ),
        "concurrent-edit": (
            "Two simulated devices submit different mutations based on version 1. Blackbox delays one request by 300 ms.",
            "One succeeds. The other receives workout_conflict (409). The winning edit remains intact.",
        ),
    }
    for index, case in enumerate(cases):
        status = "PASS" if case["passed"] else "FAIL"
        steps = "".join(
            f'<div class="step"><small>{esc(a["label"])}</small><strong>{a["status"] or "LOST"}</strong><span>{esc(a["errorCode"] or ("No HTTP response" if not a["status"] else "HTTP response"))}</span></div>'
            for a in case["attempts"]
        )
        final = case["states"][-1]["database"]
        metrics = f'<div class="metrics"><div><strong>1 → {final["version"]}</strong><small>workout version</small></div><div><strong>{final["mutations"]}</strong><small>mutation receipts</small></div><div><strong>{final["sets"]}</strong><small>sets stored</small></div></div>'
        rows = "".join(
            f'<tr><td class="{"ok" if c["passed"] else "bad"}">{"PASS" if c["passed"] else "FAIL"}</td><td>{esc(c["name"])}</td><td><code>{esc(json.dumps(c["actual"]))}</code></td><td><code>{esc(json.dumps(c["expected"]))}</code></td></tr>'
            for c in case["checks"]
        )
        events = "".join(
            f"<tr><td>{esc(e['method'])}</td><td>{e['status'] or '—'}</td><td>{e['upstreamStatus'] or '—'}</td><td>{esc(e['outcome'])}</td><td>{e['durationMs']:.1f} ms</td></tr>"
            for e in case["events"]
        )
        states = "".join(
            f"<tr><td>{esc(s['label'])}</td><td>{s['database']['version']}</td><td>{s['database']['mutations']}</td><td>{s['database']['sets']}</td></tr>"
            for s in case["states"]
        )
        intro, conclusion = explanations[case["id"]]
        cards.append(f'''<article id="{esc(case["id"])}"><div class="case-title"><span class="eyebrow">EXPERIMENT 0{index + 1}</span><b class="badge {"ok" if case["passed"] else "bad"}">{status}</b></div>
          <h2>{esc(case["name"])}</h2><p>{intro}</p><div class="steps">{steps}</div>{metrics}
          <details><summary>Inspect {len(case["checks"])} assertions and proxy evidence</summary>
          <h3>Assertions</h3><div class="table"><table><thead><tr><th>Result</th><th>Invariant</th><th>Actual</th><th>Expected</th></tr></thead><tbody>{rows}</tbody></table></div>
          <h3>Proxy observations · completion order</h3><div class="table"><table><thead><tr><th>Method</th><th>Client status</th><th>Upstream status</th><th>Outcome</th><th>Duration</th></tr></thead><tbody>{events}</tbody></table></div>
          <h3>Direct PostgreSQL reads</h3><div class="table"><table><thead><tr><th>Checkpoint</th><th>Version</th><th>Receipts</th><th>Sets</th></tr></thead><tbody>{states}</tbody></table></div>
          <h3>Exact fault configuration</h3><pre>{esc(json.dumps(case["scenario"], indent=2))}</pre></details></article>''')
        slides.append(
            f"""<section class="slide"><span class="eyebrow">0{index + 2} / {esc(case["id"].upper())} · {status}</span><h2>{esc(case["name"])}</h2><p>{intro}</p><div class="steps">{steps}</div>{metrics}<p>{conclusion if case["passed"] else "The expected behavior was not verified. Inspect the failed assertions in the report."}</p></section>"""
        )
    slides.append(
        f"""<section class="slide"><span class="eyebrow">05 / THE EVIDENCE</span><h2>{count} of 3 scenarios passed.<br>{checks} explicit assertions.</h2><p>HTTP observations + direct PostgreSQL reads.<br>Unmodified backend at revision <code>{esc(report["fixture"]["revision"][:12])}</code>.</p><div class="flow"><b>Reproduce</b><i>→</i><b>Inject failure</b><i>→</i><b>Verify state</b><i>→</i><b>Export evidence</b></div><p class="muted">This tests the backend with a Python test client.<br>It does not exercise the mobile app or prove all possible concurrent schedules.</p></section>"""
    )
    template = (Path(__file__).with_name("report.html")).read_text(encoding="utf-8")
    values = {
        "REPORT_DATA": base64.b64encode(json.dumps(report, indent=2).encode()).decode(),
        "STATUS": "VERIFIED" if passed else "INCOMPLETE / FAILED",
        "STATUS_CLASS": "ok" if passed else "bad",
        "COUNT": str(count),
        "CHECKS": str(checks),
        "STARTED": esc(report["startedAt"]),
        "REVISION": esc(report["fixture"]["revision"]),
        "VERSION": esc(report.get("blackboxVersion") or "unavailable"),
        "POSTGRES": esc(report.get("postgresVersion", "unavailable")),
        "CLEANUP": "Complete: owned services stopped and test schema removed."
        if report["cleanupCompleted"]
        else "Not confirmed. Inspect local service logs.",
        "CARDS": "".join(cards),
        "SLIDES": "".join(slides),
        "ERROR": f'<p class="bad">{esc(report["error"]["type"])}: {esc(report["error"]["message"])}</p>'
        if report.get("error")
        else "",
    }
    for key, value in values.items():
        template = template.replace("{{" + key + "}}", value)
    return template


def write_report(output, report):
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (output / "report.html").write_text(render(report), encoding="utf-8")
