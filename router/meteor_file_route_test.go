package router_test

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestMeteorSignedFileContentThroughRouter(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: ":memory:", JWTSecret: "fixture-file-route-only"}
	t.Cleanup(func() { config.Cfg = previous })
	if _, err := repository.DB(); err != nil {
		t.Fatal(err)
	}
	// Keep the package's shared SQLite handle in memory while uploaded media
	// gets its own temporary filesystem root.
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "fixture.db")
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	ctx := service.WithUser(context.Background(), model.AuthUser{ID: "meteor_user_file_fixture", Role: model.UserRoleUser})
	object, err := service.UploadStorageObjectWithProvider(ctx, "fixture.png", "image/png", data, nil)
	if err != nil {
		t.Fatal(err)
	}
	engine := router.New()
	signed := strings.TrimPrefix(object.URL, "/studio")
	valid := httptest.NewRecorder()
	engine.ServeHTTP(valid, httptest.NewRequest(http.MethodGet, signed, nil))
	if valid.Code != http.StatusOK || valid.Body.String() != string(data) {
		t.Fatalf("signed file HTTP %d: %s", valid.Code, valid.Body.String())
	}
	partial := httptest.NewRecorder()
	rangeRequest := httptest.NewRequest(http.MethodGet, signed, nil)
	rangeRequest.Header.Set("Range", "bytes=0-7")
	engine.ServeHTTP(partial, rangeRequest)
	if partial.Code != http.StatusPartialContent || partial.Body.String() != string(data[:8]) {
		t.Fatalf("signed range HTTP %d: %s", partial.Code, partial.Body.String())
	}
	badSignature, _ := url.Parse(signed)
	query := badSignature.Query()
	query.Set("signature", strings.Repeat("0", 64))
	badSignature.RawQuery = query.Encode()
	expired, _ := url.Parse(signed)
	query = expired.Query()
	query.Set("expires", "1")
	expired.RawQuery = query.Encode()
	cases := []struct{ name, method, path string }{
		{"bad signature", http.MethodGet, badSignature.String()},
		{"expired", http.MethodGet, expired.String()},
		{"different file", http.MethodGet, strings.Replace(signed, object.ID, "00000000-0000-4000-8000-000000000000", 1)},
		{"metadata is private", http.MethodGet, strings.Replace(signed, "/content?", "?", 1)},
		{"signature is read only", http.MethodPost, signed},
		{"signature cannot delete", http.MethodDelete, strings.Replace(signed, "/api/files/", "/api/v1/files/", 1)},
		{"signature cannot read project", http.MethodGet, "/api/v1/canvas/projects?" + strings.SplitN(signed, "?", 2)[1]},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			engine.ServeHTTP(w, httptest.NewRequest(item.method, item.path, nil))
			if w.Code != http.StatusUnauthorized && w.Code != http.StatusForbidden {
				t.Fatalf("signature privilege expanded: HTTP %d %s", w.Code, w.Body.String())
			}
		})
	}
}
