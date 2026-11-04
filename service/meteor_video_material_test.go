package service

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestMeteorTaskVideoReferencesAreOwnedUnexpiredAndBounded(t *testing.T) {
	for _, program := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(program); err != nil {
			t.Skip(program + " unavailable")
		}
	}
	root := t.TempDir()
	filename := filepath.Join(root, "source.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30", "-frames:v", "30", "-c:v", "mpeg4", "-an", filename).CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	video, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var requests, mode atomic.Int32
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodGet || r.URL.Path != "/v1/videos/provider-owned-video/content" || r.Header.Get("Authorization") != "Bearer fixture-private-key" {
			t.Error("download did not use the owned task's fixed channel path")
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if mode.Load() == 3 {
			w.Header().Set("Location", "http://127.0.0.1/private-video")
			w.WriteHeader(http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		if mode.Load() == 1 {
			w.Header().Set("Content-Length", strconv.FormatInt(MeteorVideoMaxBytes+1, 10))
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = w.Write(video)
		if mode.Load() == 2 {
			w.(http.Flusher).Flush()
			_, _ = io.CopyN(w, &meteorRepeatingReader{}, MeteorVideoMaxBytes)
		}
	})
	config.Cfg.DatabaseDSN, config.Cfg.StorageDriver, config.Cfg.JWTSecret = filepath.Join(root, "task-material.db"), "sqlite", "fixture"
	channel.Models = append(channel.Models, "MiniMax-H3", "tencent-mps-superres")
	meteorSessions.Lock()
	meteorSessions.byUser[user].Channels = []model.ModelChannel{channel}
	meteorSessions.Unlock()
	owned := WithUser(context.Background(), model.AuthUser{ID: user})
	task := model.VideoTask{ID: "task-material-" + uuid.NewString(), UserID: user, Model: "MiniMax-H3", ChannelID: channel.ID, UpstreamTaskID: "provider-owned-video", Status: "completed", CompletedAt: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)}
	if _, err := repository.SaveVideoTask(task); err != nil {
		t.Fatal(err)
	}
	path := "/studio/api/v1/videos/" + task.ID + "/content?expires=0&signature=stale"
	for _, value := range []string{path, "https://site.example" + path} {
		object, err := MeteorResolveMaterial(owned, value, "video")
		if err != nil || object.Bytes != int64(len(video)) || object.DurationSeconds < 0.99 || object.DurationSeconds > 1.01 {
			t.Fatal("owned playback URL was not imported", object, err)
		}
	}
	before := requests.Load()
	if _, err := MeteorResolveMaterial(WithUser(context.Background(), model.AuthUser{ID: "other-task-owner"}), path, "video"); err == nil {
		t.Fatal("another owner's playback task was accepted")
	}
	if _, err := MeteorResolveMaterial(owned, path, "image"); err == nil {
		t.Fatal("video task accepted as image")
	}
	for _, change := range []struct{ model, status, completed string }{
		{"tencent-mps-superres", "completed", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)},
		{"tencent-mps-superres", "completed", time.Now().Add(-25 * time.Hour).UTC().Format(time.RFC3339Nano)},
		{"MiniMax-H3", "completed", time.Now().Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)},
		{"MiniMax-H3", "completed", ""},
		{"MiniMax-H3", "processing", time.Now().UTC().Format(time.RFC3339Nano)},
	} {
		task.Model, task.Status, task.CompletedAt = change.model, change.status, change.completed
		if _, err := repository.SaveVideoTask(task); err != nil {
			t.Fatal(err)
		}
		if _, err := MeteorResolveMaterial(owned, path, "video"); err == nil {
			t.Fatal("unavailable task was accepted", change)
		}
	}
	if requests.Load() != before {
		t.Fatal("rejected task reached the download gateway")
	}
	task.Model, task.Status, task.CompletedAt = "MiniMax-H3", "completed", time.Now().Add(-6*24*time.Hour).UTC().Format(time.RFC3339Nano)
	if _, err := repository.SaveVideoTask(task); err != nil {
		t.Fatal(err)
	}
	if _, err := MeteorResolveMaterial(owned, path, "video"); err != nil {
		t.Fatal("ordinary video's seven-day window was shortened", err)
	}
	for _, value := range []int32{1, 2, 3} {
		mode.Store(value)
		if _, err := MeteorResolveMaterial(owned, path, "video"); err == nil {
			t.Fatal("oversized or redirected task download was accepted", value)
		}
	}
}
