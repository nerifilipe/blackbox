package lab

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := OpenStore(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func targetURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
func TestRuleBudgetIsAtomic(t *testing.T) {
	sc := DefaultScenario()
	sc.Rules[0].Limit = 7
	engine := NewEngine(sc)
	var hits atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if engine.Match("POST", "/workouts") != nil {
				hits.Add(1)
			}
		}()
	}
	wg.Wait()
	if hits.Load() != 7 {
		t.Fatalf("injected %d faults; expected exactly 7", hits.Load())
	}
	engine.Reset()
	if engine.Match("POST", "/workouts") == nil {
		t.Fatal("reset did not re-arm")
	}
	if engine.Match("GET", "/workouts") != nil || engine.Match("POST", "/workouts/extra") != nil {
		t.Fatal("rule matched a different method or path")
	}
}

func TestRuleOrderAndValidation(t *testing.T) {
	sc := DefaultScenario()
	first := sc.Rules[0]
	first.ID = "first"
	first.Kind = "http_error"
	first.Status = 503
	sc.Rules = append([]Rule{first}, sc.Rules...)
	e := NewEngine(sc)
	if r := e.Match("POST", "/workouts"); r == nil || r.ID != "first" {
		t.Fatal("first eligible rule must win")
	}
	if r := e.Match("POST", "/workouts"); r == nil || r.ID != "lost-response" {
		t.Fatal("exhausted rule should fall through")
	}
	cases := []struct {
		name   string
		change func(*Scenario)
	}{
		{"version", func(s *Scenario) { s.Version = 2 }}, {"duplicate IDs", func(s *Scenario) { s.Rules = append(s.Rules, s.Rules[0]) }},
		{"query", func(s *Scenario) { s.Rules[0].Path = "/workouts?token=secret" }}, {"unbounded", func(s *Scenario) { s.Rules[0].Limit = 0 }},
		{"unknown kind", func(s *Scenario) { s.Rules[0].Kind = "unknown" }}, {"negative delay", func(s *Scenario) { s.Rules[0].Kind = "latency"; s.Rules[0].DelayMS = -1 }},
		{"invalid error", func(s *Scenario) { s.Rules[0].Kind = "http_error"; s.Rules[0].Status = 200 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := DefaultScenario()
			tc.change(&s)
			if s.Validate() == nil {
				t.Fatal("accepted invalid scenario")
			}
		})
	}
}

func TestLostResponseCreatesDuplicatesOnlyWithoutIdempotency(t *testing.T) {
	for _, mode := range []string{"fragile", "resilient"} {
		t.Run(mode, func(t *testing.T) {
			store := testStore(t)
			engine := NewEngine(DefaultScenario())
			upstream := httptest.NewServer(DemoHandler(store))
			defer upstream.Close()
			proxy := httptest.NewServer(NewProxy(targetURL(t, upstream.URL), engine, store))
			defer proxy.Close()
			run, err := RunDemo(context.Background(), proxy.URL, mode, engine, store)
			if err != nil {
				t.Fatal(err)
			}
			expected := 1
			if mode == "fragile" {
				expected = 2
			}
			if run.StoredWorkouts != expected {
				t.Fatalf("stored %d; expected %d", run.StoredWorkouts, expected)
			}
			if run.Passed != (mode == "resilient") {
				t.Fatalf("unexpected assertion outcome: %+v", run)
			}
			if len(run.Attempts) != 2 || run.Attempts[0].Status != 0 || run.Attempts[0].Outcome != "connection_lost" {
				t.Fatalf("the client did not observe a genuine dropped response: %+v", run.Attempts)
			}
			events := waitEvents(t, store, 2)
			if events[1].Outcome != "response_dropped" || events[1].Status != 0 || events[1].UpstreamStatus != 201 {
				t.Fatalf("incorrect observation of dropped response: %+v", events[1])
			}
			last, err := store.LastRun()
			if err != nil || last == nil || last.ID != run.ID {
				t.Fatal("run not persisted")
			}
		})
	}
}

func waitEvents(t *testing.T, s *Store, n int) []Event {
	t.Helper()
	end := time.Now().Add(time.Second)
	for time.Now().Before(end) {
		events, err := s.Events()
		if err != nil {
			t.Fatal(err)
		}
		if len(events) >= n {
			return events
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("events were not persisted")
	return nil
}

func TestHTTPErrorDoesNotReachUpstream(t *testing.T) {
	store := testStore(t)
	sc := DefaultScenario()
	sc.Rules[0].Kind = "http_error"
	sc.Rules[0].Status = 503
	sc.Rules[0].Limit = 2
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(201) }))
	defer upstream.Close()
	proxy := httptest.NewServer(NewProxy(targetURL(t, upstream.URL), NewEngine(sc), store))
	defer proxy.Close()
	for i, expected := range []int{503, 503, 201} {
		resp, err := http.Post(proxy.URL+"/workouts", "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != expected {
			t.Fatalf("attempt %d: status %d", i, resp.StatusCode)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("upstream called %d times", calls.Load())
	}
	events := waitEvents(t, store, 3)
	if events[2].UpstreamStatus != 0 || events[2].Outcome != "error_injected" {
		t.Fatal("injected error was misreported as upstream response")
	}
}

func TestLatencyAndCancellation(t *testing.T) {
	store := testStore(t)
	sc := DefaultScenario()
	sc.Rules[0].Kind = "latency"
	sc.Rules[0].DelayMS = 150
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(204) }))
	defer upstream.Close()
	engine := NewEngine(sc)
	proxy := httptest.NewServer(NewProxy(targetURL(t, upstream.URL), engine, store))
	defer proxy.Close()
	start := time.Now()
	resp, err := http.Post(proxy.URL+"/workouts", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if time.Since(start) < 140*time.Millisecond {
		t.Fatal("latency was not applied")
	}
	engine.Reset()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", proxy.URL+"/workouts", strings.NewReader("{}"))
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, _ := http.DefaultClient.Do(req)
		if response != nil {
			response.Body.Close()
		}
	}()
	end := time.Now().Add(time.Second)
	for time.Now().Before(end) {
		_, counts := engine.Snapshot()
		if counts[sc.Rules[0].ID] == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
	events := waitEvents(t, store, 2)
	if calls.Load() != 1 {
		t.Fatal("cancelled delayed request reached upstream")
	}
	if events[0].Outcome != "client_cancelled" {
		t.Fatalf("wrong cancellation event %+v", events[0])
	}
}

func TestProxyPreservesPayloadAndQueryWithoutRecordingSecrets(t *testing.T) {
	store := testStore(t)
	sc := DefaultScenario()
	sc.Rules = nil
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if string(b) != "private-body" || r.URL.Query().Get("token") != "private-query" || r.Header.Get("Authorization") != "Bearer private-header" {
			t.Error("proxy changed request")
		}
		w.Header().Set("X-Upstream", "yes")
		w.WriteHeader(202)
		w.Write([]byte("response-body"))
	}))
	defer upstream.Close()
	proxy := httptest.NewServer(NewProxy(targetURL(t, upstream.URL), NewEngine(sc), store))
	defer proxy.Close()
	req, _ := http.NewRequest("POST", proxy.URL+"/other?token=private-query", strings.NewReader("private-body"))
	req.Header.Set("Authorization", "Bearer private-header")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 202 || string(b) != "response-body" || resp.Header.Get("X-Upstream") != "yes" {
		t.Fatal("proxy changed response")
	}
	events := waitEvents(t, store, 1)
	raw, _ := json.Marshal(events)
	if bytes.Contains(raw, []byte("private-")) || bytes.Contains(raw, []byte("response-body")) {
		t.Fatal("sensitive payload leaked into history")
	}
}

func TestStatePersistsAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	sc := DefaultScenario()
	sc.Name = "Saved case"
	if err = s.SaveScenario(sc); err != nil {
		t.Fatal(err)
	}
	if err = s.AddEvent(Event{Method: "GET", Path: "/health", Status: 200}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	loaded, err := reopened.LoadScenario()
	if err != nil || loaded.Name != sc.Name {
		t.Fatal("scenario did not persist")
	}
	events, err := reopened.Events()
	if err != nil || len(events) != 1 || events[0].Path != "/health" {
		t.Fatal("event history did not persist")
	}
}

func TestControlRejectsCrossOriginAndInvalidScenarios(t *testing.T) {
	store := testStore(t)
	engine := NewEngine(DefaultScenario())
	control := &Control{Store: store, Engine: engine, Assets: fstest.MapFS{"index.html": {Data: []byte("ok")}}}
	server := httptest.NewServer(control.Handler())
	defer server.Close()
	body, _ := json.Marshal(DefaultScenario())
	for _, tc := range []struct {
		name, origin, host string
		status             int
	}{{"cross origin", "https://evil.example", "", 403}, {"DNS rebinding", "", "evil.example", 403}, {"allowed", "", "", 200}} {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("PUT", server.URL+"/api/scenario", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.host != "" {
				req.Host = tc.host
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != tc.status {
				t.Fatalf("status %d", resp.StatusCode)
			}
		})
	}
	req, _ := http.NewRequest("PUT", server.URL+"/api/scenario", strings.NewReader(`{"version":1,"name":"bad","rules":[{"id":"bad"}]}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatal("invalid scenario accepted")
	}
	sc, _ := engine.Snapshot()
	if sc.Name != "The lost response" {
		t.Fatal("invalid update changed active scenario")
	}
	req, _ = http.NewRequest("POST", server.URL+"/api/demo/run", strings.NewReader(`{"mode":"resilient"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 409 {
		t.Fatal("demo must be disabled for custom targets")
	}
}

func TestDuplicateWritesAreAtomic(t *testing.T) {
	store := testStore(t)
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := store.SaveWorkout("abcd", "same-key"); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	n, err := store.CountWorkouts("abcd")
	if err != nil || n != 1 {
		t.Fatalf("concurrent duplicate writes: %d, %v", n, err)
	}
	if _, _, err = store.SaveWorkout("ffff", "same-key"); err == nil {
		t.Fatal("same key with a different payload should be rejected")
	}
}
