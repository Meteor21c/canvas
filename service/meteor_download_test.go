package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestMeteorDownloadOnlySignsOwnedAvailableMedia(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: ":memory:", JWTSecret: "fixture-download-only"}
	t.Cleanup(func() { config.Cfg = previous })
	if _, err := repository.DB(); err != nil {
		t.Fatal(err)
	}
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "fixture.db")
	owner := model.AuthUser{ID: "download-owner-" + uuid.NewString(), Role: model.UserRoleUser}
	ctx := WithUser(context.Background(), owner)
	id := uuid.NewString()
	object := model.StorageObject{ID: id, ObjectKey: id, ProviderID: "meteor-local", CreatedBy: owner.ID, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), MimeType: "video/mp4", Bytes: 5}
	if _, err := repository.SaveStorageObject(object); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(meteorMediaRoot(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(meteorMediaRoot(), id), []byte("video"), 0600); err != nil {
		t.Fatal(err)
	}
	task, err := CreateVideoTask(VideoTaskCreateInput{UserID: owner.ID, ClientTaskID: "client_video_task_download_" + uuid.NewString(), UpstreamTaskID: "private-provider-id", Status: "completed"})
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []MeteorDownloadInput{{StorageKey: "server:" + id, Filename: "作品.mp4"}, {VideoTaskID: task.ID, Filename: "video.mp4"}} {
		target, err := MeteorDownloadURL(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(target, "/studio/api/") || strings.Contains(target, "private-provider-id") {
			t.Fatal("download exposed a provider address or ID")
		}
		r := httptest.NewRequest(http.MethodGet, strings.TrimPrefix(target, "/studio"), nil)
		if input.StorageKey != "" && !MeteorAuthorizeMedia(r) {
			t.Fatal("invalid file signature")
		}
		if input.VideoTaskID != "" && !MeteorAuthorizeVideo(r, task.ID) {
			t.Fatal("invalid task signature")
		}
		w := httptest.NewRecorder()
		SetMeteorDownloadHeaders(w, r)
		if !strings.HasPrefix(w.Header().Get("Content-Disposition"), "attachment;") || w.Header().Get("X-Accel-Buffering") != "no" {
			t.Fatal("native download headers missing")
		}
		other := WithUser(context.Background(), model.AuthUser{ID: "different-owner", Role: model.UserRoleUser})
		if _, err := MeteorDownloadURL(other, input); err == nil {
			t.Fatal("another account could sign the download")
		}
	}
	for _, input := range []MeteorDownloadInput{
		{Filename: "video.mp4"},
		{StorageKey: "server:" + id, VideoTaskID: task.ID, Filename: "video.mp4"},
		{StorageKey: "https://upstream.invalid/private.mp4", Filename: "video.mp4"},
		{StorageKey: "server:" + id, Filename: "../video.mp4"},
		{StorageKey: "server:" + id, Filename: "video.mp4\r\nSet-Cookie: secret"},
	} {
		if _, err := MeteorDownloadURL(ctx, input); err == nil {
			t.Fatalf("unsafe input accepted: %#v", input)
		}
	}
	if _, err := MeteorDownloadURL(context.Background(), MeteorDownloadInput{VideoTaskID: task.ID, Filename: "video.mp4"}); err == nil {
		t.Fatal("anonymous signing accepted")
	}
	task.CompletedAt = time.Now().Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
	if err := repository.UpdateVideoTask(task); err != nil {
		t.Fatal(err)
	}
	if _, err := MeteorDownloadURL(ctx, MeteorDownloadInput{VideoTaskID: task.ID, Filename: "video.mp4"}); err == nil {
		t.Fatal("expired task could be downloaded")
	}
	q := url.Values{"download": {"1"}, "filename": {"bad\r\nname.mp4"}}
	w := httptest.NewRecorder()
	SetMeteorDownloadHeaders(w, httptest.NewRequest(http.MethodGet, "/?"+q.Encode(), nil))
	if strings.ContainsAny(w.Header().Get("Content-Disposition"), "\r\n") {
		t.Fatal("download header injection")
	}
}
