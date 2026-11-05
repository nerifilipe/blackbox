package lab

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

func DemoHandler(store *Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("POST /workouts", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RunID string `json:"runId"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.RunID == "" || cleanRunID(body.RunID) != body.RunID {
			writeError(w, 400, "invalid demo run ID")
			return
		}
		key := r.Header.Get("Idempotency-Key")
		if len(key) > 100 {
			writeError(w, 400, "invalid idempotency key")
			return
		}
		id, reused, err := store.SaveWorkout(body.RunID, key)
		if err != nil {
			writeError(w, 409, err.Error())
			return
		}
		status := 201
		if reused {
			status = 200
		}
		writeJSON(w, status, map[string]any{"id": id, "reused": reused, "name": "Morning strength"})
	})
	return mux
}

// Each run starts with a fresh logical dataset (run ID). No shared data is reset.
// The client performs visible, explicit retries, with transport retry disabled.
func RunDemo(ctx context.Context, proxyURL, mode string, engine *Engine, store *Store) (Run, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return Run{}, err
	}
	start := time.Now()
	scenario, _ := engine.Snapshot()
	engine.Reset()
	run := Run{ID: hex.EncodeToString(random), Mode: mode, Scenario: scenario.Name, StartedAt: start.UTC().Format(time.RFC3339Nano), Attempts: []Attempt{}}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DisableKeepAlives = true
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 12 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	body, _ := json.Marshal(map[string]string{"runId": run.ID})
	success := false
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, "POST", proxyURL+"/workouts", bytes.NewReader(body))
		if err != nil {
			return run, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Blackbox-Run", run.ID)
		if mode == "resilient" {
			req.Header.Set("Idempotency-Key", run.ID)
		}
		a := Attempt{Number: attempt, Outcome: "connection_lost"}
		resp, err := client.Do(req)
		if err == nil {
			a.Status = resp.StatusCode
			_, readErr := io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			if readErr != nil {
				a.Outcome = "connection_lost"
			} else if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				a.Outcome = "received"
				success = true
			} else {
				a.Outcome = "http_error"
			}
		}
		run.Attempts = append(run.Attempts, a)
		if success {
			break
		}
		if ctx.Err() != nil {
			return run, ctx.Err()
		}
		if attempt < 3 {
			select {
			case <-time.After(time.Duration(attempt) * 150 * time.Millisecond):
			case <-ctx.Done():
				return run, ctx.Err()
			}
		}
	}
	var err error
	run.StoredWorkouts, err = store.CountWorkouts(run.ID)
	if err != nil {
		return run, err
	}
	run.Passed = success && run.StoredWorkouts == 1
	run.DurationMS = time.Since(start).Milliseconds()
	return run, store.SaveRun(run)
}
