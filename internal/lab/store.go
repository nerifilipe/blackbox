package lab

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

func OpenStore(path string) (*Store, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), scenario TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS demo_workouts (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, request_key TEXT UNIQUE);
 CREATE INDEX IF NOT EXISTS demo_run_idx ON demo_workouts(run_id);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db}, nil
}
func (s *Store) Close() error { return s.db.Close() }
func (s *Store) SaveScenario(sc Scenario) error {
	b, err := json.Marshal(sc)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO settings(id,scenario) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET scenario=excluded.scenario`, string(b))
	return err
}
func (s *Store) LoadScenario() (Scenario, error) {
	var raw string
	err := s.db.QueryRow(`SELECT scenario FROM settings WHERE id=1`).Scan(&raw)
	if err == sql.ErrNoRows {
		sc := DefaultScenario()
		return sc, s.SaveScenario(sc)
	}
	if err != nil {
		return Scenario{}, err
	}
	var sc Scenario
	err = json.Unmarshal([]byte(raw), &sc)
	if err != nil {
		return sc, err
	}
	return sc, sc.Validate()
}
func (s *Store) AddEvent(e Event) error {
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO events(payload) VALUES(?)`, string(b)); err != nil {
		return err
	}
	// Bound history on disk; the UI reads the most recent 200.
	if _, err = tx.Exec(`DELETE FROM events WHERE id <= (SELECT MAX(id)-5000 FROM events)`); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) Events() ([]Event, error) {
	rows, err := s.db.Query(`SELECT id,payload FROM events ORDER BY id DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []Event{}
	for rows.Next() {
		var e Event
		var raw string
		var id int64
		if err = rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &e); err != nil {
			return nil, err
		}
		e.ID = id
		events = append(events, e)
	}
	return events, rows.Err()
}
func (s *Store) SaveRun(run Run) error {
	b, err := json.Marshal(run)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO runs(payload) VALUES(?)`, string(b)); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM runs WHERE id <= (SELECT MAX(id)-100 FROM runs)`); err != nil {
		return err
	}
	// Demo rows have no user content. Keep only the current and recent runs.
	if _, err = tx.Exec(`DELETE FROM demo_workouts WHERE run_id NOT IN (SELECT json_extract(payload,'$.id') FROM runs)`); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) LastRun() (*Run, error) {
	var raw string
	err := s.db.QueryRow(`SELECT payload FROM runs ORDER BY id DESC LIMIT 1`).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r Run
	err = json.Unmarshal([]byte(raw), &r)
	return &r, err
}
func (s *Store) SaveWorkout(runID, key string) (int64, bool, error) {
	var value any
	if key != "" {
		value = key
	}
	res, err := s.db.Exec(`INSERT INTO demo_workouts(run_id,request_key) VALUES(?,?) ON CONFLICT(request_key) DO NOTHING`, runID, value)
	if err != nil {
		return 0, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	if n == 0 {
		var id int64
		var existingRun string
		err = s.db.QueryRow(`SELECT id,run_id FROM demo_workouts WHERE request_key=?`, key).Scan(&id, &existingRun)
		if err == nil && existingRun != runID {
			err = fmt.Errorf("idempotency key already belongs to a different request")
		}
		return id, true, err
	}
	id, err := res.LastInsertId()
	return id, false, err
}
func (s *Store) CountWorkouts(run string) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM demo_workouts WHERE run_id=?`, run).Scan(&n)
	return n, err
}
