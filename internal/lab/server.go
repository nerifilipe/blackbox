package lab

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
)

type Control struct {
	Store         *Store
	Engine        *Engine
	Target        string
	ProxyURL      string
	DemoAvailable bool
	Assets        fs.FS
	operation     sync.Mutex
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeError(w, 415, "Content-Type must be application/json")
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeError(w, 400, "invalid JSON: "+err.Error())
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeError(w, 400, "expected one JSON document")
		return false
	}
	return true
}

func (c *Control) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		events, err := c.Store.Events()
		if err != nil {
			writeError(w, 500, "could not load history")
			return
		}
		run, err := c.Store.LastRun()
		if err != nil {
			writeError(w, 500, "could not load experiment")
			return
		}
		sc, counts := c.Engine.Snapshot()
		writeJSON(w, 200, map[string]any{"target": c.Target, "proxyUrl": c.ProxyURL, "demoAvailable": c.DemoAvailable, "scenario": sc, "counts": counts, "events": events, "lastRun": run})
	})
	mux.HandleFunc("GET /api/scenario", func(w http.ResponseWriter, r *http.Request) {
		sc, _ := c.Engine.Snapshot()
		w.Header().Set("Content-Disposition", `attachment; filename="blackbox-scenario.json"`)
		writeJSON(w, 200, sc)
	})
	mux.HandleFunc("GET /api/runs", func(w http.ResponseWriter, r *http.Request) {
		runs, err := c.Store.Runs()
		if err != nil {
			writeError(w, 500, "could not load experiment history")
			return
		}
		writeJSON(w, 200, map[string]any{"runs": runs})
	})
	loadRun := func(w http.ResponseWriter, r *http.Request) (Run, bool) {
		run, err := c.Store.Run(r.PathValue("id"))
		if err == sql.ErrNoRows {
			writeError(w, 404, "experiment not found or no longer retained")
			return run, false
		}
		if err != nil {
			writeError(w, 500, "could not load experiment")
			return run, false
		}
		return run, true
	}
	mux.HandleFunc("GET /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		run, ok := loadRun(w, r)
		if !ok {
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="blackbox-experiment.json"`)
		writeJSON(w, 200, run)
	})
	mux.HandleFunc("GET /api/runs/{id}/scenario", func(w http.ResponseWriter, r *http.Request) {
		run, ok := loadRun(w, r)
		if !ok {
			return
		}
		if run.ScenarioSnapshot == nil {
			writeError(w, 409, "this older experiment has no saved scenario configuration")
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="blackbox-scenario.json"`)
		writeJSON(w, 200, run.ScenarioSnapshot)
	})
	mux.HandleFunc("PUT /api/scenario", func(w http.ResponseWriter, r *http.Request) {
		var sc Scenario
		if !readJSON(w, r, &sc) {
			return
		}
		if err := sc.Validate(); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if !c.operation.TryLock() {
			writeError(w, 409, "an experiment is running")
			return
		}
		defer c.operation.Unlock()
		if err := c.Store.SaveScenario(sc); err != nil {
			writeError(w, 500, "could not save scenario")
			return
		}
		c.Engine.Set(sc)
		writeJSON(w, 200, sc)
	})
	mux.HandleFunc("POST /api/scenario/reset", func(w http.ResponseWriter, r *http.Request) {
		var body struct{}
		if !readJSON(w, r, &body) {
			return
		}
		if !c.operation.TryLock() {
			writeError(w, 409, "an experiment is running")
			return
		}
		defer c.operation.Unlock()
		c.Engine.Reset()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/demo/run", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Mode string `json:"mode"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Mode != "resilient" && body.Mode != "fragile" {
			writeError(w, 400, "mode must be resilient or fragile")
			return
		}
		if !c.DemoAvailable {
			writeError(w, 409, "demo requires the bundled target; restart without -target")
			return
		}
		if !c.operation.TryLock() {
			writeError(w, 409, "an experiment is already running")
			return
		}
		defer c.operation.Unlock()
		run, err := RunDemo(r.Context(), c.ProxyURL, body.Mode, c.Engine, c.Store)
		if err != nil {
			writeError(w, 500, "experiment interrupted or could not be persisted")
			return
		}
		writeJSON(w, 200, run)
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeError(w, 404, "endpoint not found") })
	static := http.FileServer(http.FS(c.Assets))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/" {
			if _, err := fs.Stat(c.Assets, "index.html"); err != nil {
				http.Error(w, "Build the frontend first: cd web && npm ci && npm run build", 503)
				return
			}
		}
		static.ServeHTTP(w, r)
	})
	return localOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	}))
}

// Bindings are loopback-only. Host and Origin checks also prevent a browser
// visiting another site from mutating the unauthenticated local control plane.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			writeError(w, 403, "local host required")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host || u.Scheme != "http" {
				writeError(w, 403, "same-origin requests required")
				return
			}
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeError(w, 403, "cross-site requests are disabled")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func ValidateAddress(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("listen address must use a loopback IP, e.g. 127.0.0.1:9090")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return fmt.Errorf("listen port must be between 1 and 65535")
	}
	return nil
}
func ValidateTarget(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, fmt.Errorf("target must be an http(s) origin, without credentials, path or query")
	}
	return u, nil
}
