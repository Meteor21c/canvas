package handler

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestMeteorMultipartUploadUsesVerifiedMetadataAndRejectsProvider(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "uploads.db"), JWTSecret: "fixture"}
	t.Cleanup(func() { config.Cfg = previous })
	user := model.AuthUser{ID: "multipart-fixture-" + uuid.NewString()}
	ctx := service.WithUser(context.Background(), user)
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1YAAAAASUVORK5CYII=")
	upload := func(files int, provider string) response {
		var body bytes.Buffer
		parts := multipart.NewWriter(&body)
		for n := 0; n < files; n++ {
			file, _ := parts.CreateFormFile("file", "fixture.png")
			_, _ = file.Write(png)
		}
		if provider != "" {
			_ = parts.WriteField("provider", provider)
		}
		_ = parts.Close()
		req := httptest.NewRequest("POST", "/api/files", &body).WithContext(ctx)
		req.Header.Set("Content-Type", parts.FormDataContentType())
		recorder := httptest.NewRecorder()
		UploadFile(recorder, req)
		var result response
		if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	result := upload(1, "")
	if result.Code != 0 {
		t.Fatal("valid upload rejected", result)
	}
	object, ok := result.Data.(map[string]any)
	if !ok || object["width"] != float64(1) || object["height"] != float64(1) {
		t.Fatal("verified dimensions absent", result)
	}
	if result = upload(1, "{\"type\":\"s3\"}"); result.Code == 0 {
		t.Fatal("custom provider accepted")
	}
	if result = upload(2, ""); result.Code == 0 {
		t.Fatal("multiple files accepted")
	}
	db, _ := repository.DB()
	var count int64
	_ = db.Model(&model.StorageObject{}).Where("created_by = ?", user.ID).Count(&count).Error
	if count != 1 {
		t.Fatal("invalid multipart left persisted objects", count)
	}
}
