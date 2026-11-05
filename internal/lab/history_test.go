package lab

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestHistoryRetainsSnapshotsAcrossScenarioChangesAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	sc := DefaultScenario()
	engine := NewEngine(sc)
	upstream := httptest.NewServer(DemoHandler(store))
	proxy := httptest.NewServer(NewProxy(targetURL(t, upstream.URL), engine, store))
	run, err := RunDemo(context.Background(), proxy.URL, "resilient", engine, store)
	proxy.Close()
	upstream.Close()
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	if run.ScenarioSnapshot == nil || run.Fixture != "workout-v1" {
		store.Close()
		t.Fatal("new experiment omitted configuration or fixture")
	}
	changed := DefaultScenario()
	changed.Rules[0].Kind = "http_error"
	changed.Rules[0].Status = 503
	engine.Set(changed)
	if err := store.SaveScenario(changed); err != nil {
		store.Close()
		t.Fatal(err)
	}
	store.Close()
	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	runs, err := reopened.Runs()
	if err != nil || len(runs) != 1 {
		t.Fatalf("missing history after restart: %v, %v", runs, err)
	}
	if runs[0].ScenarioSnapshot.Rules[0].Kind != "drop_response" {
		t.Fatal("history used the edited configuration")
	}
	saved, err := reopened.Run(run.ID)
	if err != nil || saved.ID != run.ID || saved.StoredWorkouts != 1 {
		t.Fatalf("wrong retained result: %+v, %v", saved, err)
	}
}

func TestHistoryRetentionAndLegacyRecords(t *testing.T) {
	store := testStore(t)
	empty, err := store.Runs()
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty history must be an array: %+v, %v", empty, err)
	}
	for i := 0; i < 105; i++ {
		// Old records have no snapshot or fixture. Their original shape remains valid.
		if err := store.SaveRun(Run{ID: fmt.Sprintf("%032x", i), Scenario: "Legacy experiment", Mode: "fragile", Attempts: []Attempt{}, StoredWorkouts: 2}); err != nil {
			t.Fatal(err)
		}
	}
	runs, err := store.Runs()
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 100 || runs[0].ID != fmt.Sprintf("%032x", 104) || runs[99].ID != fmt.Sprintf("%032x", 5) {
		t.Fatal("history retention or newest-first ordering is incorrect")
	}
	if runs[0].ScenarioSnapshot != nil || runs[0].Fixture != "" {
		t.Fatal("legacy records must not invent configurations")
	}
	if _, err := store.Run(fmt.Sprintf("%032x", 0)); err != sql.ErrNoRows {
		t.Fatalf("expired experiment was retained: %v", err)
	}
}

func TestHistoryAPIExportsRecordedConfiguration(t *testing.T) {
	store := testStore(t)
	snapshot := DefaultScenario()
	run := Run{ID: "0123456789abcdef0123456789abcdef", Scenario: snapshot.Name, ScenarioSnapshot: &snapshot, Fixture: "workout-v1", Mode: "resilient", Attempts: []Attempt{}, StoredWorkouts: 1, Passed: true}
	if err := store.SaveRun(run); err != nil {
		t.Fatal(err)
	}
	legacy := Run{ID: "abcdef0123456789abcdef0123456789", Scenario: "Legacy", Attempts: []Attempt{}}
	if err := store.SaveRun(legacy); err != nil {
		t.Fatal(err)
	}
	changed := DefaultScenario()
	changed.Name = "Current rules are different"
	changed.Rules[0].Kind = "latency"
	changed.Rules[0].DelayMS = 200
	control := &Control{Store: store, Engine: NewEngine(changed), Assets: fstest.MapFS{"index.html": {Data: []byte("ok")}}}
	server := httptest.NewServer(control.Handler())
	defer server.Close()
	response, err := http.Get(server.URL + "/api/runs")
	if err != nil {
		t.Fatal(err)
	}
	var listing struct {
		Runs []Run `json:"runs"`
	}
	err = json.NewDecoder(response.Body).Decode(&listing)
	response.Body.Close()
	if err != nil || len(listing.Runs) != 2 || listing.Runs[0].ID != legacy.ID {
		t.Fatalf("wrong API history: %+v, %v", listing, err)
	}
	response, err = http.Get(server.URL + "/api/runs/" + run.ID + "/scenario")
	if err != nil {
		t.Fatal(err)
	}
	var exported Scenario
	err = json.NewDecoder(response.Body).Decode(&exported)
	response.Body.Close()
	if response.StatusCode != 200 || err != nil || exported.Rules[0].Kind != "drop_response" || exported.Name != snapshot.Name {
		t.Fatalf("export did not use recorded rules: %+v, %v", exported, err)
	}
	if response.Header.Get("Content-Disposition") == "" {
		t.Fatal("missing scenario download header")
	}
	response, err = http.Get(server.URL + "/api/runs/" + run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var exportedRun Run
	err = json.NewDecoder(response.Body).Decode(&exportedRun)
	response.Body.Close()
	if err != nil || exportedRun.ID != run.ID || exportedRun.ScenarioSnapshot == nil {
		t.Fatal("result export is incomplete")
	}
	for _, tc := range []struct {
		path   string
		status int
	}{{"/api/runs/unknown", 404}, {"/api/runs/unknown/scenario", 404}, {"/api/runs/" + legacy.ID + "/scenario", 409}} {
		response, err := http.Get(server.URL + tc.path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != tc.status {
			t.Fatalf("%s: got %d, expected %d", tc.path, response.StatusCode, tc.status)
		}
	}
}
