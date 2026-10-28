package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestMeteorVideoOnlyOnePostAfterConcurrencyAndResultCleanup(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: ":memory:"}
	t.Cleanup(func() { config.Cfg = previous })
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var data any
		switch r.URL.Path {
		case "/api/v1/auth/me":
			data = map[string]any{"id": 984721, "role": "admin", "status": "active", "balance": 100}
		case "/api/v1/canvas/access":
			data = map[string]any{"allowed": true}
		case "/api/v1/groups/available":
			data = []map[string]any{{"id": 2, "allow_video_generation": true}}
		case "/api/v1/keys":
			data = map[string]any{"total": 1, "items": []map[string]any{{"id": 7, "user_id": 984721, "group_id": 2, "status": "active", "key": "ci-video-test-only"}}}
		case "/v1/models":
			data = []map[string]any{{"id": "seedance-2.0-mini"}}
		case "/v1/videos/generations":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer ci-video-test-only" {
				t.Error("incorrect method or gateway key")
			}
			posts.Add(1)
			// A disconnected response must preserve uncertainty and never resend.
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = connection.Close()
			return
		default:
			t.Errorf("unexpected mock main path: %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
	}))
	defer server.Close()
	config.Cfg.MeteorAPIBase = server.URL
	user, err := service.MeteorAuthenticate(context.Background(), "ci-video-owner-test-only")
	if err != nil {
		t.Fatal(err)
	}
	const id = "client_video_task_ci_one_unique_post"
	call := func(user model.AuthUser) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/videos", strings.NewReader(`{"model":"seedance-2.0-mini","prompt":"no paid network"}`))
		r.Header.Set("X-Client-Video-Task-ID", id)
		r.Header.Set("X-Model-Channel-ID", "meteor-key-7-video")
		r = r.WithContext(service.WithUser(r.Context(), user))
		w := httptest.NewRecorder()
		meteorCreateVideo(w, r)
		return w
	}
	var wait sync.WaitGroup
	for index := 0; index < 16; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if w := call(user); w.Code != 200 {
				t.Errorf("duplicate status %d", w.Code)
			}
		}()
	}
	wait.Wait()
	if posts.Load() != 1 {
		t.Fatalf("mock upstream saw %d POSTs, require one", posts.Load())
	}
	task, found, err := service.GetUserVideoTask(user.ID, id)
	if err != nil || !found || task.Status != "submission_unknown" {
		t.Fatalf("uncertainty lost: %+v %v", task, err)
	}
	if err := service.DeleteUserVideoTask(user.ID, id); err == nil {
		t.Fatal("unconfirmed paid submission allowed recovery-record removal")
	}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Where("id = ? AND user_id = ?", id, user.ID).Delete(&model.VideoTask{}).Error; err != nil {
		t.Fatal(err)
	}
	if w := call(user); w.Code != 200 || !strings.Contains(w.Body.String(), "result_expired") {
		t.Fatalf("receipt did not survive cleanup: %s", w.Body.String())
	}
	if posts.Load() != 1 {
		t.Fatal("result cleanup caused a second paid POST")
	}
}
