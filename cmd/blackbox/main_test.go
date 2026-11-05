package main

import (
	"strings"
	"testing"
)

func TestRejectLocalProxyLoopsBeforeStarting(t *testing.T) {
	for _, target := range []string{"http://127.0.0.1:9091", "http://localhost:9091", "http://LOCALHOST:9090", "http://[::1]:9090"} {
		t.Run(target, func(t *testing.T) {
			err := serve([]string{"-target", target})
			if err == nil || !strings.Contains(err.Error(), "cannot point") {
				t.Fatalf("loop target was not rejected: %v", err)
			}
		})
	}
}

func TestRejectEphemeralAndPublicListeners(t *testing.T) {
	for _, address := range []string{"0.0.0.0:9090", "127.0.0.1:0", "127.0.0.1:99999"} {
		if err := serve([]string{"-ui", address}); err == nil {
			t.Fatalf("accepted unsupported listener %s", address)
		}
	}
}
