package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

// The mock exposes only read endpoints. No generation route exists.
func TestMeteorCustomerIdentityAndKeyBoundary(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: ":memory:"}
	meteorSessions.Lock()
	previousTokens, previousUsers := meteorSessions.byToken, meteorSessions.byUser
	meteorSessions.byToken, meteorSessions.byUser = map[string]*meteorSession{}, map[string]*meteorSession{}
	meteorSessions.Unlock()
	t.Cleanup(func() {
		config.Cfg = previous
		meteorSessions.Lock()
		meteorSessions.byToken, meteorSessions.byUser = previousTokens, previousUsers
		meteorSessions.Unlock()
	})
	const key = "ci-owner-key-do-not-serialize"
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodGet {
			t.Error("authentication/catalog attempted a mutation")
			w.WriteHeader(405)
			return
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		var data any
		switch r.URL.Path {
		case "/api/v1/auth/me":
			role, status := "admin", "active"
			if token == "ci-customer" {
				role = "user"
			}
			if token == "ci-disabled" {
				status = "disabled"
			}
			data = map[string]any{"id": 4242, "role": role, "status": status, "balance": 12.5}
		case "/api/v1/canvas/access":
			data = map[string]any{"allowed": token != "ci-not-owner"}
		case "/api/v1/groups/available":
			data = []map[string]any{{"id": 2, "name": "CI", "allow_image_generation": true}}
		case "/api/v1/keys":
			data = map[string]any{"total": 2, "items": []map[string]any{
				{"id": 7, "user_id": 4242, "group_id": 2, "status": "active", "key": key, "name": "CI owner"},
				{"id": 8, "user_id": 9999, "group_id": 2, "status": "active", "key": "ci-other-user-key"},
			}}
		case "/v1/models":
			if token != key {
				t.Error("foreign or unowned key used for model catalog")
			}
			data = []map[string]any{{"id": "gpt-image-2"}}
		default:
			t.Errorf("unexpected main API endpoint %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
	}))
	defer server.Close()
	config.Cfg.MeteorAPIBase = server.URL
	for _, token := range []string{"ci-disabled", "ci-not-owner"} {
		if _, err := MeteorAuthenticate(context.Background(), token); !errors.Is(err, ErrMeteorSession) {
			t.Fatalf("unqualified identity accepted: %s, %v", token, err)
		}
	}
	user, err := MeteorAuthenticate(context.Background(), "ci-customer")
	if err != nil || user.ID != "meteor_user_4242" || user.Role != model.UserRoleUser {
		t.Fatalf("customer identity not safely mapped: %+v, %v", user, err)
	}
	public, err := MeteorPublicChannels(user.ID)
	if err != nil || len(public) != 1 || public[0].ID != "meteor-key-7" {
		t.Fatalf("catalog allowed foreign channels: %+v, %v", public, err)
	}
	encoded, _ := json.Marshal(public)
	if strings.Contains(string(encoded), key) || strings.Contains(string(encoded), "127.0.0.1") || public[0].BaseURL != "" {
		t.Fatal("public model catalog exposed key or private gateway")
	}
	for _, raw := range []string{`{"nodes":[{"api_key":"secret"}]}`, `{"nodes":[{"url":"data:image/png;base64,aaaa"}]}`, `{"text":"ci-customer"}`, `{"text":"ci-owner-key-do-not-serialize"}`} {
		if MeteorValidateMetadata([]byte(raw)) == nil {
			t.Fatal("project accepted credential or inline media")
		}
	}
	if err := MeteorValidateMetadata([]byte(`{"nodes":[{"type":"image","prompt":"a quiet lake"}]}`)); err != nil {
		t.Fatal(err)
	}
	meteorSessions.Lock()
	meteorSessions.byUser[user.ID].ExpiresAt = time.Now().Add(-time.Second)
	meteorSessions.Unlock()
	before := calls.Load()
	if _, err := MeteorSelectChannel(user.ID, "gpt-image-2", "meteor-key-7"); !errors.Is(err, ErrMeteorSession) || calls.Load() != before {
		t.Fatal("expired session attempted to refresh or dispatch without authentication")
	}
}

func TestMeteorGatewayAndMediaSSRFBoundary(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	for _, base := range []string{"http://sub2api:8080", "http://127.0.0.1:3000", "http://host.docker.internal:3000"} {
		config.Cfg.MeteorAPIBase = base
		if _, err := MeteorBaseURL(); err != nil {
			t.Fatalf("valid private gateway rejected: %s", base)
		}
	}
	for _, base := range []string{"https://api.example", "http://sub2api:9000", "http://evil:8080", "http://sub2api:8080/api", "http://secret@sub2api:8080", "http://sub2api:8080?key=x"} {
		config.Cfg.MeteorAPIBase = base
		if _, err := MeteorBaseURL(); err == nil {
			t.Fatalf("untrusted main gateway accepted: %s", base)
		}
	}
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1); w.WriteHeader(204) }))
	defer server.Close()
	config.Cfg.MeteorAPIBase = server.URL
	client := meteorGatewayClient(model.ModelChannel{})
	for _, target := range []string{"http://elsewhere.invalid/v1/models", server.URL + "/api/v1/admin", strings.Replace(server.URL, "http://", "http://secret@", 1) + "/v1/models"} {
		req, _ := http.NewRequest(http.MethodGet, target, nil)
		if response, err := client.Do(req); err == nil {
			response.Body.Close()
			t.Fatalf("gateway accepted untrusted request: %s", target)
		}
	}
	if hits.Load() != 0 {
		t.Fatal("untrusted request reached main gateway")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+"/image.png", nil)
	if response, err := newSafeProxyHTTPClient().Do(req); err == nil {
		response.Body.Close()
		t.Fatal("media proxy reached loopback")
	}
	if hits.Load() != 0 {
		t.Fatal("SSRF guard connected to loopback server")
	}
}
