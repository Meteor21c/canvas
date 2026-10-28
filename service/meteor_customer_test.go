package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
)

func TestMeteorCustomersKeepOwnKeysBalancesAndBilling(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: ":memory:"}
	meteorSessions.Lock()
	oldTokens, oldUsers := meteorSessions.byToken, meteorSessions.byUser
	meteorSessions.byToken, meteorSessions.byUser = map[string]*meteorSession{}, map[string]*meteorSession{}
	meteorSessions.Unlock()
	t.Cleanup(func() {
		config.Cfg = previous
		meteorSessions.Lock()
		meteorSessions.byToken, meteorSessions.byUser = oldTokens, oldUsers
		meteorSessions.Unlock()
	})
	var mu sync.Mutex
	charges := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		id := int64(5101)
		if token == "customer-b" || token == "key-b" {
			id = 5102
		}
		key := "key-a"
		if id == 5102 {
			key = "key-b"
		}
		var data any
		switch r.URL.Path {
		case "/api/v1/auth/me":
			data = map[string]any{"id": id, "role": "user", "status": "active", "balance": float64(id) / 100}
		case "/api/v1/canvas/access":
			data = map[string]any{"allowed": true}
		case "/api/v1/groups/available":
			data = []map[string]any{{"id": id, "name": "customer-group", "platform": "openai", "allow_image_generation": true}}
		case "/api/v1/keys":
			data = map[string]any{"total": 2, "items": []map[string]any{
				{"id": id, "user_id": id, "group_id": id, "status": "active", "key": key},
				{"id": 9999, "user_id": 9999, "group_id": id, "status": "active", "key": "foreign-key"},
			}}
		case "/v1/models":
			if token != "key-a" && token != "key-b" {
				t.Error("foreign key requested model catalogue")
			}
			data = []map[string]any{{"id": "gpt-image-2"}}
		case "/v1/images/generations":
			if token != "key-a" && token != "key-b" {
				t.Error("invalid billing key")
				w.WriteHeader(401)
				return
			}
			mu.Lock()
			charges[token]++
			mu.Unlock()
			data = map[string]any{"created": 1}
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
	}))
	defer server.Close()
	config.Cfg.MeteorAPIBase = server.URL
	for i, token := range []string{"customer-a", "customer-b"} {
		user, err := MeteorAuthenticate(context.Background(), token)
		id := int64(5101 + i)
		if err != nil || user.ID != "meteor_user_"+strconv.FormatInt(id, 10) || user.Credits != float64(id)/100 {
			t.Fatalf("account identity/balance mismatch: %+v %v", user, err)
		}
		channel, err := MeteorSelectChannel(user.ID, "gpt-image-2", "meteor-key-"+strconv.FormatInt(id, 10))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := MeteorSelectChannel(user.ID, "gpt-image-2", "meteor-key-"+strconv.FormatInt(5101+int64(1-i), 10)); err == nil {
			t.Fatal("foreign account channel accepted")
		}
		if _, err := MeteorSelectAnyChannel("gpt-image-2", channel.ID); err == nil {
			t.Fatal("account-free billing fallback accepted")
		}
		public, err := MeteorPublicChannels(user.ID)
		if err != nil || len(public) != 1 || public[0].ID != channel.ID {
			t.Fatal("foreign model catalogue exposed")
		}
		raw, _ := json.Marshal(public)
		if strings.Contains(string(raw), "key-a") || strings.Contains(string(raw), "key-b") || strings.Contains(string(raw), "foreign-key") {
			t.Fatal("credential leaked")
		}
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/images/generations", strings.NewReader("{}"))
		SetModelChannelAuthHeader(req, channel)
		response, err := HTTPClientForChannel(channel).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("billing request failed")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if charges["key-a"] != 1 || charges["key-b"] != 1 || len(charges) != 2 {
		t.Fatalf("cross-account billing: %+v", charges)
	}
}
