package handler

import (
	"bytes"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/service"
)

type meteorProxyTransport func(*http.Request) (*http.Response, error)

func (transport meteorProxyTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestMeteorProxyRefusesExecutableAndOversizedMedia(t *testing.T) {
	previous := config.Cfg
	config.Cfg.MeteorMode = true
	client := service.SafeProxyHTTPClient()
	original := client.Transport
	t.Cleanup(func() { config.Cfg = previous; client.Transport = original })
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, mime string
		content    []byte
		length     int64
		status     int
	}{
		{"safe PNG", "image/png", png, int64(len(png)), 200},
		{"SVG", "image/svg+xml", []byte("<svg onload='alert(1)'/>"), -1, 502},
		{"HTML mislabeled as PNG", "image/png", []byte("<!doctype html><script>alert(1)</script>"), -1, 502},
		{"XML mislabeled as JPEG", "image/jpeg", []byte("<?xml version='1.0'?><svg/>"), -1, 502},
		{"declared oversized", "image/png", png, (32 << 20) + 1, 502},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			client.Transport = meteorProxyTransport(func(request *http.Request) (*http.Response, error) {
				if request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
					t.Error("owner credentials forwarded to remote media")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {item.mime}}, Body: io.NopCloser(bytes.NewReader(item.content)), ContentLength: item.length, Request: request}, nil
			})
			request := httptest.NewRequest("GET", "/api/proxy-image?url=https://image.example/a", nil)
			request.Header.Set("Authorization", "Bearer must-stay-local")
			request.Header.Set("Cookie", "private=1")
			recorder := httptest.NewRecorder()
			ProxyImage(recorder, request)
			if recorder.Code != item.status {
				t.Fatalf("status=%d want=%d body=%s", recorder.Code, item.status, recorder.Body.String())
			}
			if item.status == 200 {
				if !strings.Contains(recorder.Header().Get("Content-Security-Policy"), "sandbox") {
					t.Fatal("safe media response missing sandbox policy")
				}
				if recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
					t.Fatal("media response missing nosniff")
				}
			}
		})
	}
}
