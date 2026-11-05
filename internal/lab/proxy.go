package lab

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

type traceKey struct{}
type trace struct {
	event Event
	drop  bool
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(p)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *statusWriter) Flush() {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func NewProxy(target *url.URL, engine *Engine, store *Store) http.Handler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.ResponseHeaderTimeout = 15 * time.Second
	transport.DisableKeepAlives = true // no implicit transport retries in fault experiments
	transport.ForceAttemptHTTP2 = false
	proxy := &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(p *httputil.ProxyRequest) {
			p.SetURL(target)
			p.Out.Host = target.Host
			p.Out.Header.Del("X-Blackbox-Run")
		},
		ModifyResponse: func(r *http.Response) error {
			tr := r.Request.Context().Value(traceKey{}).(*trace)
			tr.event.UpstreamStatus = r.StatusCode
			if tr.drop {
				// Read the response before losing it: the upstream has really responded.
				_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 1<<20))
				r.Body.Close()
				tr.event.Outcome = "response_dropped"
				// ReverseProxy and net/http recognize this sentinel and close the connection
				// without emitting an HTTP status. The event is still stored by our defer.
				panic(http.ErrAbortHandler)
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			tr := r.Context().Value(traceKey{}).(*trace)
			tr.event.Outcome = "upstream_error"
			http.Error(w, "Blackbox: upstream unavailable", 502)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		tr := &trace{event: Event{StartedAt: start.UTC().Format(time.RFC3339Nano), Method: r.Method, Path: r.URL.EscapedPath(), Outcome: "forwarded", RunID: cleanRunID(r.Header.Get("X-Blackbox-Run"))}}
		out := &statusWriter{ResponseWriter: w}
		defer func() {
			tr.event.DurationMS = float64(time.Since(start).Microseconds()) / 1000
			tr.event.Status = out.status
			if r.Context().Err() != nil && tr.event.Outcome == "forwarded" {
				tr.event.Outcome = "client_cancelled"
			}
			if err := store.AddEvent(tr.event); err != nil {
				log.Printf("persist event: %v", err)
			}
		}()
		if r.Method == http.MethodConnect || r.Header.Get("Upgrade") != "" {
			tr.event.Outcome = "unsupported"
			http.Error(out, "Blackbox MVP supports HTTP request/response only", 501)
			return
		}
		// API payloads are bounded. Bodies and query strings are never recorded.
		r.Body = http.MaxBytesReader(out, r.Body, 4<<20)
		// Buffer bounded API requests before delaying. Reading to EOF lets net/http
		// detect a disconnected client while the artificial latency timer is active.
		body, err := io.ReadAll(r.Body)
		if err != nil {
			tr.event.Outcome = "request_rejected"
			http.Error(out, "Blackbox: unreadable request or payload larger than 4 MiB", http.StatusRequestEntityTooLarge)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		r.TransferEncoding = nil
		if rule := engine.Match(r.Method, r.URL.Path); rule != nil {
			tr.event.Fault = rule.Kind
			tr.event.Rule = rule.Name
			switch rule.Kind {
			case "latency":
				timer := time.NewTimer(time.Duration(rule.DelayMS) * time.Millisecond)
				defer timer.Stop()
				select {
				case <-timer.C:
				case <-r.Context().Done():
					tr.event.Outcome = "client_cancelled"
					return
				}
			case "http_error":
				tr.event.Outcome = "error_injected"
				http.Error(out, "Blackbox: injected HTTP failure", rule.Status)
				return
			case "drop_response":
				tr.drop = true
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		proxy.ServeHTTP(out, r.WithContext(context.WithValue(ctx, traceKey{}, tr)))
	})
}

func cleanRunID(s string) string {
	if len(s) > 64 {
		return ""
	}
	for _, c := range s {
		if !strings.ContainsRune("0123456789abcdef-", c) {
			return ""
		}
	}
	return s
}
