package lab

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

type Rule struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Method  string `json:"method"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Limit   int    `json:"limit"`
	DelayMS int    `json:"delayMs"`
	Status  int    `json:"status"`
	Enabled bool   `json:"enabled"`
}

type Scenario struct {
	Version     int    `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Rules       []Rule `json:"rules"`
}

func DefaultScenario() Scenario {
	return Scenario{Version: 1, Name: "The lost response", Description: "The server saves the workout. The response never arrives. Is a retry safe?", Rules: []Rule{{ID: "lost-response", Name: "Drop the first response", Method: "POST", Path: "/workouts", Kind: "drop_response", Limit: 1, Enabled: true}}}
}

func (s Scenario) Validate() error {
	if s.Version != 1 {
		return errors.New("scenario version must be 1")
	}
	if len(strings.TrimSpace(s.Name)) == 0 || len(s.Name) > 100 {
		return errors.New("scenario name must contain 1–100 characters")
	}
	if len(s.Description) > 500 || len(s.Rules) > 20 {
		return errors.New("maximum 20 rules and 500 description characters")
	}
	ids := map[string]bool{}
	for _, r := range s.Rules {
		if r.ID == "" || len(r.ID) > 64 || ids[r.ID] {
			return errors.New("rule IDs must be unique and contain 1–64 characters")
		}
		ids[r.ID] = true
		if len(r.Name) > 100 {
			return errors.New("rule name is too long")
		}
		switch r.Method {
		case "*", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS":
		default:
			return fmt.Errorf("invalid method for rule %s", r.ID)
		}
		if !strings.HasPrefix(r.Path, "/") || len(r.Path) > 500 || strings.ContainsAny(r.Path, "?#\r\n") {
			return errors.New("rule path must be an exact URL path without query or fragment")
		}
		if r.Limit < 1 || r.Limit > 10000 {
			return errors.New("rule limit must be between 1 and 10000")
		}
		switch r.Kind {
		case "latency":
			if r.DelayMS < 1 || r.DelayMS > 10000 {
				return errors.New("delay must be between 1 and 10000 milliseconds")
			}
		case "http_error":
			if r.Status < 400 || r.Status > 599 {
				return errors.New("injected status must be between 400 and 599")
			}
		case "drop_response":
		default:
			return errors.New("unknown fault kind")
		}
	}
	return nil
}

// The mutex makes budget reservation atomic across concurrent requests.
// First eligible rule wins. A budget is consumed when the request is admitted,
// including a request which is subsequently cancelled by its client.
type Engine struct {
	mu       sync.Mutex
	scenario Scenario
	used     map[string]int
}

func NewEngine(s Scenario) *Engine {
	return &Engine{scenario: cloneScenario(s), used: map[string]int{}}
}
func cloneScenario(s Scenario) Scenario { s.Rules = append([]Rule{}, s.Rules...); return s }
func (e *Engine) Set(s Scenario) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.scenario = cloneScenario(s)
	e.used = map[string]int{}
}
func (e *Engine) Snapshot() (Scenario, map[string]int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	counts := map[string]int{}
	for k, v := range e.used {
		counts[k] = v
	}
	return cloneScenario(e.scenario), counts
}
func (e *Engine) Reset() { e.mu.Lock(); defer e.mu.Unlock(); e.used = map[string]int{} }
func (e *Engine) Match(method, path string) *Rule {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, r := range e.scenario.Rules {
		if r.Enabled && (r.Method == "*" || r.Method == method) && r.Path == path && e.used[r.ID] < r.Limit {
			e.used[r.ID]++
			return &r
		}
	}
	return nil
}

type Event struct {
	ID             int64   `json:"id"`
	StartedAt      string  `json:"startedAt"`
	Method         string  `json:"method"`
	Path           string  `json:"path"`
	Status         int     `json:"status"`
	UpstreamStatus int     `json:"upstreamStatus"`
	DurationMS     float64 `json:"durationMs"`
	Fault          string  `json:"fault"`
	Rule           string  `json:"rule"`
	Outcome        string  `json:"outcome"`
	RunID          string  `json:"runId"`
}

type Attempt struct {
	Number  int    `json:"number"`
	Status  int    `json:"status"`
	Outcome string `json:"outcome"`
}
type Run struct {
	ID               string    `json:"id"`
	StartedAt        string    `json:"startedAt"`
	Mode             string    `json:"mode"`
	Scenario         string    `json:"scenario"`
	ScenarioSnapshot *Scenario `json:"scenarioSnapshot,omitempty"`
	Fixture          string    `json:"fixture,omitempty"`
	Attempts         []Attempt `json:"attempts"`
	StoredWorkouts   int       `json:"storedWorkouts"`
	Passed           bool      `json:"passed"`
	DurationMS       int64     `json:"durationMs"`
}
