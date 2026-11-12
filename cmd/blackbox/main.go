package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/nerifilipe/blackbox/internal/lab"
	"github.com/nerifilipe/blackbox/web"
)

func main() {
	if err := execute(os.Args[1:]); err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "blackbox:", err)
		os.Exit(1)
	}
}
func execute(args []string) error {
	command := "serve"
	if len(args) > 0 && len(args[0]) > 0 && args[0][0] != '-' {
		command = args[0]
		args = args[1:]
	}
	switch command {
	case "serve":
		return serve(args)
	case "run", "export":
		return clientCommand(command, args)
	case "version":
		fmt.Println("Blackbox 0.4.0")
		return nil
	default:
		return fmt.Errorf("unknown command %q; use serve, run, export or version", command)
	}
}
func serve(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	uiAddr := flags.String("ui", "127.0.0.1:9090", "control UI address (loopback only)")
	proxyAddr := flags.String("proxy", "127.0.0.1:9091", "proxy address (loopback only)")
	demoAddr := flags.String("demo", "127.0.0.1:9092", "bundled demo address (loopback only)")
	target := flags.String("target", "", "upstream HTTP(S) origin; empty uses the bundled demo")
	dbPath := flags.String("db", filepath.Join(".blackbox", "history.db"), "SQLite history path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	addresses := []string{*uiAddr, *proxyAddr}
	if *target == "" {
		addresses = append(addresses, *demoAddr)
	}
	seen := map[string]bool{}
	for _, addr := range addresses {
		if err := lab.ValidateAddress(addr); err != nil {
			return err
		}
		if seen[addr] {
			return errors.New("each service needs a different listen address")
		}
		seen[addr] = true
	}
	demoAvailable := *target == ""
	if demoAvailable {
		*target = "http://" + *demoAddr
	}
	upstream, err := lab.ValidateTarget(*target)
	if err != nil {
		return err
	}
	upstreamIP := net.ParseIP(upstream.Hostname())
	if strings.EqualFold(upstream.Hostname(), "localhost") || (upstreamIP != nil && upstreamIP.IsLoopback()) {
		port := upstream.Port()
		if port == "" {
			if upstream.Scheme == "https" {
				port = "443"
			} else {
				port = "80"
			}
		}
		for _, address := range []string{*uiAddr, *proxyAddr} {
			_, listenPort, _ := net.SplitHostPort(address)
			if port == listenPort {
				return errors.New("target cannot point to the control UI or proxy port on loopback")
			}
		}
	}
	store, err := lab.OpenStore(*dbPath)
	if err != nil {
		return err
	}
	defer store.Close()
	scenario, err := store.LoadScenario()
	if err != nil {
		return err
	}
	engine := lab.NewEngine(scenario)
	control := &lab.Control{Store: store, Engine: engine, Target: upstream.String(), ProxyURL: "http://" + *proxyAddr, DemoAvailable: demoAvailable, Assets: web.Files()}
	servers := []*http.Server{{Addr: *uiAddr, Handler: control.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 30 * time.Second}, {Addr: *proxyAddr, Handler: lab.NewProxy(upstream, engine, store), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second}}
	if demoAvailable {
		servers = append(servers, &http.Server{Addr: *demoAddr, Handler: lab.DemoHandler(store), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second})
	}
	listeners := []net.Listener{}
	for _, server := range servers {
		listener, err := net.Listen("tcp", server.Addr)
		if err != nil {
			for _, l := range listeners {
				l.Close()
			}
			return err
		}
		listeners = append(listeners, listener)
	}
	errorsCh := make(chan error, len(servers))
	for i, server := range servers {
		go func(s *http.Server, l net.Listener) { errorsCh <- s.Serve(l) }(server, listeners[i])
	}
	fmt.Printf("\n  BLACKBOX / failure lab\n\n  Console  http://%s\n  Proxy    http://%s\n  Target   %s\n  History  %s\n\n  Ctrl+C to stop.\n\n", *uiAddr, *proxyAddr, *target, *dbPath)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-errorsCh:
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, server := range servers {
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("shutdown: %v", err)
			server.Close()
		}
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		return nil
	}
	return serveErr
}

func clientCommand(command string, args []string) error {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	base := flags.String("url", "http://127.0.0.1:9090", "local Blackbox control URL")
	mode := flags.String("mode", "resilient", "demo client: resilient or fragile")
	scenarioFile := flags.String("scenario", "", "scenario JSON to apply before running")
	out := flags.String("out", "", "export destination (default stdout)")
	if err := flags.Parse(args); err != nil {
		return err
	}
	u, err := lab.ValidateTarget(*base)
	if err != nil {
		return err
	}
	ip := net.ParseIP(u.Hostname())
	if u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return errors.New("CLI connects to a local control server only")
	}
	client := &http.Client{Timeout: 50 * time.Second}
	request := func(method, path string, payload []byte) ([]byte, error) {
		req, err := http.NewRequest(method, *base+path, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		if err != nil {
			return nil, err
		}
		if resp.StatusCode >= 300 {
			return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
		}
		return b, nil
	}
	if command == "export" {
		b, err := request("GET", "/api/scenario", nil)
		if err != nil {
			return err
		}
		if *out != "" {
			return os.WriteFile(*out, b, 0600)
		}
		fmt.Print(string(b))
		return nil
	}
	if *mode != "resilient" && *mode != "fragile" {
		return errors.New("mode must be resilient or fragile")
	}
	if *scenarioFile != "" {
		b, err := os.ReadFile(*scenarioFile)
		if err != nil {
			return err
		}
		if _, err = request("PUT", "/api/scenario", b); err != nil {
			return err
		}
	}
	payload, _ := json.Marshal(map[string]string{"mode": *mode})
	b, err := request("POST", "/api/demo/run", payload)
	if err != nil {
		return err
	}
	var pretty bytes.Buffer
	_ = json.Indent(&pretty, b, "", "  ")
	fmt.Println(pretty.String())
	var run lab.Run
	if err = json.Unmarshal(b, &run); err != nil {
		return err
	}
	if !run.Passed {
		return errors.New("assertion failed: expected one stored workout and a successful response")
	}
	return nil
}
