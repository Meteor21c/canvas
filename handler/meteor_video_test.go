package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestMeteorVideoUsesMainProtocolAndNeverReplays(t *testing.T) {
	var submits atomic.Int32
	var accepted map[string]any
	var acceptedMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/auth/me":
			io.WriteString(w, `{"code":0,"data":{"id":88333,"role":"admin","status":"active","balance":17}}`)
		case "/api/v1/canvas/access":
			io.WriteString(w, `{"code":0,"data":{"allowed":true}}`)
		case "/api/v1/groups/available":
			io.WriteString(w, `{"code":0,"data":[{"id":8,"name":"Main","platform":"grok","allow_video_generation":true,"allow_image_generation":true}]}`)
		case "/api/v1/keys":
			io.WriteString(w, `{"code":0,"data":{"total":1,"items":[{"id":7,"user_id":88333,"group_id":8,"name":"Own key","status":"active","key":"fake-key-never-public"}]}}`)
		case "/v1/models":
			io.WriteString(w, `{"data":[{"id":"doubao-seedance-2.5"},{"id":"gpt-image-2"}]}`)
		case "/v1/videos/pricing":
			io.WriteString(w, `{"model":"doubao-seedance-2.5","resolutions":["1080p"],"scenarios":[{"resolutions":["1080p"],"audio":true,"input_video":true,"billing_mode":"token","currency":"CNY","sale_per_million":2}]}`)
		case "/v1/videos/generations":
			if r.Method != "POST" {
				t.Error("wrong method")
			}
			if r.Header.Get("Authorization") != "Bearer fake-key-never-public" {
				t.Error("main API key absent")
			}
			if r.Header.Get("X-Meteor-Fzy-Owner") != "" {
				t.Error("must derive owner in main gateway")
			}
			submits.Add(1)
			acceptedMu.Lock()
			_ = json.NewDecoder(r.Body).Decode(&accepted)
			acceptedMu.Unlock()
			io.WriteString(w, `{"id":"main-durable-task","status":"pending","stage":"asset_reviewing"}`)
		case "/v1/videos/generations/main-durable-task":
			io.WriteString(w, `{"id":"main-durable-task","status":"done","video":{"url":"https://private-upstream.example/result","duration":30}}`)
		case "/v1/videos/main-durable-task/content":
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Accept-Ranges", "bytes")
			io.WriteString(w, "video-payload")
		default:
			t.Errorf("unexpected main route: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, MeteorAPIBase: server.URL, StorageDriver: "sqlite", DatabaseDSN: ":memory:", JWTSecret: "fixture-only"}
	t.Cleanup(func() { config.Cfg = previous })
	user, err := service.MeteorAuthenticate(context.Background(), "fake-owner-token")
	if err != nil {
		t.Fatal(err)
	}
	channels, err := service.MeteorPublicChannels(user.ID)
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(channels)
	if strings.Contains(string(public), "fake-key") || strings.Contains(string(public), server.URL) {
		t.Fatal("public catalogue exposed gateway secrets")
	}
	id := "client_video_task_ci_" + uuid.NewString()
	body := []byte(`{"model":"doubao-seedance-2.5","prompt":"no actual generation","seconds":"30","resolution_name":"1080p","size":"16:9","reference_videos":["https://owned.example/reference.mp4"],"reference_audios":["https://owned.example/reference.mp3"],"first_frame_url":"https://owned.example/start.png","last_frame_url":"https://owned.example/end.png","audio":true}`)
	call := func() string {
		r := httptest.NewRequest("POST", "/api/v1/videos", bytes.NewReader(body))
		r = r.WithContext(service.WithUser(r.Context(), user))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Model-Channel-ID", "meteor-key-7-video")
		r.Header.Set("X-Client-Video-Task-ID", id)
		w := httptest.NewRecorder()
		meteorCreateVideo(w, r)
		if w.Code != 200 {
			t.Errorf("video submit HTTP %d", w.Code)
		}
		return w.Body.String()
	}
	const callers = 8
	var wg sync.WaitGroup
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if response := call(); !strings.Contains(response, id) {
				t.Error("missing durable local id")
			}
		}()
	}
	wg.Wait()
	if submits.Load() != 1 {
		t.Fatalf("repeated generation POSTs=%d", submits.Load())
	}
	acceptedMu.Lock()
	duration := accepted["duration"]
	resolution := accepted["resolution"]
	refs := accepted["reference_images"]
	first := accepted["start_image_url"]
	last := accepted["end_image_url"]
	acceptedMu.Unlock()
	if duration != float64(30) || resolution != "1080p" || first != "https://owned.example/start.png" || last != "https://owned.example/end.png" || (!strings.Contains(fmt.Sprint(refs), "video:https://owned.example/reference.mp4") || !strings.Contains(fmt.Sprint(refs), "audio:https://owned.example/reference.mp3")) {
		t.Fatalf("protocol silently changed capabilities: %+v", accepted)
	}
	task, found, err := service.GetUserVideoTask(user.ID, id)
	if err != nil || !found {
		t.Fatal("task not durable", err)
	}
	update, err := meteorPollVideo(context.Background(), task)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.UpdateVideoTaskFromPoll(task, update); err != nil {
		t.Fatal(err)
	}
	task, _, _ = service.GetUserVideoTask(user.ID, id)
	response, _ := json.Marshal(service.VideoTaskResponse(task))
	if task.Status != "completed" || strings.Contains(string(response), "private-upstream") || strings.Contains(string(response), "fake-key") {
		t.Fatal("completion/content isolation failed", string(response))
	}
	r := httptest.NewRequest("GET", strings.Replace(service.MeteorVideoURL(id), "/studio/api/", "/api/", 1), nil)
	w := httptest.NewRecorder()
	meteorVideoContent(w, r, id)
	if w.Code != 200 || w.Body.String() != "video-payload" {
		t.Fatal("signed video content failed", w.Code, w.Body.String())
	}
	// Expiring result metadata must not release the durable submit receipt.
	db, _ := repository.DB()
	if err := db.Where("id = ?", id).Delete(&model.VideoTask{}).Error; err != nil {
		t.Fatal(err)
	}
	if output := call(); !strings.Contains(output, "result_expired") {
		t.Fatal("expired result did not preserve uncertainty", output)
	}
	if submits.Load() != 1 {
		t.Fatal("result cleanup allowed a second paid request")
	}
}
