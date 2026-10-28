package router_test

import (
	"context"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

// Exercise both MeteorBoundary and the nested /v1 UserAuth middleware. Direct
// handler tests cannot detect authentication being rejected by the route group.
func TestMeteorSignedVideoContentThroughRouter(t *testing.T) {
	var downloads atomic.Int32
	main := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/auth/me":
			io.WriteString(w, `{"code":0,"data":{"id":88117,"role":"admin","status":"active","balance":10}}`)
		case "/api/v1/canvas/access":
			io.WriteString(w, `{"code":0,"data":{"allowed":true}}`)
		case "/api/v1/groups/available":
			io.WriteString(w, `{"code":0,"data":[{"id":3,"platform":"grok","allow_video_generation":true}]}`)
		case "/api/v1/keys":
			io.WriteString(w, `{"code":0,"data":{"total":1,"items":[{"id":9,"user_id":88117,"group_id":3,"status":"active","key":"fixture-route-key"}]}}`)
		case "/v1/models":
			io.WriteString(w, `{"data":[{"id":"doubao-seedance-2.0-mini"}]}`)
		case "/v1/videos/router-upstream-task/content":
			if r.Header.Get("Authorization") != "Bearer fixture-route-key" {
				t.Error("content lookup did not use server-side key")
			}
			downloads.Add(1)
			w.Header().Set("Content-Type", "video/mp4")
			io.WriteString(w, "fixture-video-payload")
		default:
			t.Errorf("unexpected main request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer main.Close()
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, MeteorAPIBase: main.URL, StorageDriver: "sqlite", DatabaseDSN: ":memory:", JWTSecret: "fixture-route-signing-secret"}
	t.Cleanup(func() { config.Cfg = previous })
	user, err := service.MeteorAuthenticate(context.Background(), "fixture-route-owner-token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.MeteorPublicChannels(user.ID); err != nil {
		t.Fatal(err)
	}
	id := "client_video_task_route_" + uuid.NewString()
	_, err = service.CreateVideoTask(service.VideoTaskCreateInput{UserID: user.ID, Model: "doubao-seedance-2.0-mini", ChannelID: "meteor-key-9-video", ClientTaskID: id, UpstreamTaskID: "router-upstream-task", Status: "completed"})
	if err != nil {
		t.Fatal(err)
	}
	oldMode := gin.Mode()
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { gin.SetMode(oldMode) })
	engine := router.New()
	signed := strings.TrimPrefix(service.MeteorVideoURL(id), "/studio")
	valid := httptest.NewRecorder()
	engine.ServeHTTP(valid, httptest.NewRequest(http.MethodGet, signed, nil))
	if valid.Code != http.StatusOK || valid.Body.String() != "fixture-video-payload" {
		t.Fatalf("signed content through full router: HTTP %d body=%s", valid.Code, valid.Body.String())
	}
	invalid, _ := url.Parse(signed)
	query := invalid.Query()
	query.Set("signature", strings.Repeat("0", 64))
	invalid.RawQuery = query.Encode()
	expired, _ := url.Parse(signed)
	expiredQuery := expired.Query()
	expiredQuery.Set("expires", strconv.FormatInt(time.Now().Add(-time.Minute).Unix(), 10))
	expired.RawQuery = expiredQuery.Encode()
	cases := []struct{ name, method, path string }{
		{"wrong signature", http.MethodGet, invalid.String()},
		{"valid signature for missing task", http.MethodGet, strings.TrimPrefix(service.MeteorVideoURL("client_video_task_missing_"+uuid.NewString()), "/studio")},
		{"expired signature", http.MethodGet, expired.String()},
		{"signature cannot authorize projects", http.MethodGet, "/api/v1/canvas/projects?" + strings.SplitN(signed, "?", 2)[1]},
		{"missing signature", http.MethodGet, "/api/v1/videos/" + id + "/content"},
		{"different task", http.MethodGet, strings.Replace(signed, id, id+"-other", 1)},
		{"signature cannot authorize status", http.MethodGet, strings.Replace(signed, "/content?", "?", 1)},
		{"signature cannot authorize POST", http.MethodPost, signed},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			engine.ServeHTTP(w, httptest.NewRequest(item.method, item.path, nil))
			if w.Code != http.StatusUnauthorized && w.Code != http.StatusForbidden {
				t.Fatalf("unexpected authorization status %d body=%s", w.Code, w.Body.String())
			}
		})
	}
	if downloads.Load() != 1 {
		t.Fatalf("unauthorized request reached main content route: downloads=%d", downloads.Load())
	}
}
