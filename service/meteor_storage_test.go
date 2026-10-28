package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
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

func TestMeteorStorageQuotaSignaturesRangesAndTTL(t *testing.T) {
	old := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "fixture.db"), JWTSecret: "local-test-only"}
	t.Cleanup(func() { config.Cfg = old })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	user := model.AuthUser{ID: "storage-owner-" + uuid.NewString()}
	ctx := WithUser(context.Background(), user)
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1YAAAAASUVORK5CYII=")
	if _, err := meteorUpload(ctx, "bad.png", "image/png", []byte("<html><script>bad</script>")); err == nil {
		t.Fatal("accepted HTML with media type")
	}
	object, err := meteorUpload(ctx, "one.png", "image/png", png)
	if err != nil {
		t.Fatal(err)
	}
	if !MeteorOwnsObject(ctx, object.ID) || MeteorOwnsObject(WithUser(context.Background(), model.AuthUser{ID: "outsider"}), object.ID) {
		t.Fatal("owner isolation failed")
	}
	request := httptest.NewRequest("GET", strings.Replace(object.URL, "/studio/api/", "/api/", 1), nil)
	if !MeteorAuthorizeMedia(request) {
		t.Fatal("signed URL rejected")
	}
	request.URL.RawQuery += "tamper=1" // unsigned unrelated param does not confer another ID
	request.URL.Path = "/api/files/" + uuid.NewString() + "/content"
	if MeteorAuthorizeMedia(request) {
		t.Fatal("signature accepted for different object")
	}
	partial, err := meteorDownload(object.ID, "bytes=1-3")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(partial.Stream)
	_ = partial.Stream.Close()
	if partial.StatusCode != 206 || string(data) != string(png[1:4]) {
		t.Fatal("range mismatch")
	}
	if _, err := meteorDownload(object.ID, "bytes=oops-3"); err == nil {
		t.Fatal("accepted malformed range")
	}
	expired := time.Now().Add(-25 * time.Hour).UTC().Format(time.RFC3339Nano)
	if err := db.Model(&model.StorageObject{}).Where("id = ?", object.ID).Update("created_at", expired).Error; err != nil {
		t.Fatal(err)
	}
	recent, err := meteorDownload(object.ID, "")
	if err != nil {
		t.Fatal("media within seven days removed", err)
	}
	_ = recent.Stream.Close()
	task := model.VideoTask{ID: "ci-active-" + uuid.NewString(), UserID: user.ID, Status: "processing", RequestBody: object.ID, CreatedAt: expired}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	active, err := meteorDownload(object.ID, "")
	if err != nil {
		t.Fatal("active reference removed too early", err)
	}
	_ = active.Stream.Close()
	if err := meteorDeleteObject(ctx, object.ID); err == nil {
		t.Fatal("deleted active reference")
	}
	hardExpired := time.Now().Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
	_ = db.Model(&model.StorageObject{}).Where("id = ?", object.ID).Update("created_at", hardExpired).Error
	meteorMaintain()
	if _, err := os.Stat(filepath.Join(meteorMediaRoot(), object.ID)); !os.IsNotExist(err) {
		t.Fatal("hard expired file was not removed", err)
	}
	var kept model.VideoTask
	if err := db.First(&kept, "id = ?", task.ID).Error; err != nil || kept.Status != "processing" || !strings.Contains(kept.ErrorDetail, "7天") {
		t.Fatal("cleanup destroyed/changed task outcome", kept.Status, err)
	}
	// Quantity quota independently applies even to tiny files.
	for i := 0; i < meteorMediaOwnerMaxFiles; i++ {
		id := uuid.NewString()
		if err := db.Create(&model.StorageObject{ID: id, ObjectKey: id, ProviderID: "meteor-local", CreatedBy: user.ID, CreatedAt: now(), Bytes: 1}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if _, err := meteorUpload(ctx, "limit.png", "image/png", png); err == nil {
		t.Fatal("owner file count not bounded")
	}
	if MeteorMaxFileBytes != 64<<20 {
		t.Fatal("single file budget drifted")
	}
}

func TestMeteorCanvasProjectRevisionsAndImports(t *testing.T) {
	old := config.Cfg
	config.Cfg.MeteorMode = true
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = ":memory:"
	t.Cleanup(func() { config.Cfg = old })
	user := model.AuthUser{ID: "project-owner-" + uuid.NewString()}
	ctx := WithUser(context.Background(), user)
	raw := []byte(`{"id":"fixture","name":"full original canvas","createdAt":"2026-10-28T00:00:00Z","updatedAt":"2026-10-28T00:00:00Z","revision":0,"nodes":[{"type":"threeDScene"}],"chatSession":{"messages":[]}}`)
	first, err := SaveCurrentUserCanvasProject(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(first), `"revision":1`) {
		t.Fatal("missing revision")
	}
	if _, err := SaveCurrentUserCanvasProject(ctx, raw); !errors.Is(err, ErrMeteorProjectConflict) {
		t.Fatal("stale write accepted", err)
	}
	second, err := SaveCurrentUserCanvasProject(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(second), `"revision":2`) || !strings.Contains(string(second), "threeDScene") {
		t.Fatal("revision or full node payload lost")
	}
	if _, err := SyncCurrentUserCanvasProjects(ctx, []json.RawMessage{raw}); err != nil {
		t.Fatal(err)
	}
	saved, err := CurrentUserCanvasProjects(ctx)
	if err != nil || len(saved) != 1 || !strings.Contains(string(saved[0]), `"revision":2`) {
		t.Fatal("sync replaced cloud project")
	}
	if err := DeleteCurrentUserCanvasProjects(ctx, []string{"fixture"}); err != nil {
		t.Fatal(err)
	}
	if _, err := SaveCurrentUserCanvasProject(ctx, second); !errors.Is(err, ErrMeteorProjectConflict) {
		t.Fatal("deleted ID resurrected", err)
	}
	saved, err = SyncCurrentUserCanvasProjects(ctx, []json.RawMessage{raw})
	if err != nil || len(saved) != 0 {
		t.Fatal("import resurrected tombstone", err)
	}
	for _, bad := range []string{`{"apiKey":"secret"}`, `{"nested":{"authorization":"Bearer secret"}}`, `{"url":"data:image/png;base64,abc"}`} {
		if MeteorValidateMetadata([]byte(bad)) == nil {
			t.Fatal("accepted credential/inline metadata")
		}
	}
}

func TestMeteorSevenDayRetentionUsesServerTimeAndProtectsLegacyProjects(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "retention.db")}
	t.Cleanup(func() { config.Cfg = previous })
	user := model.AuthUser{ID: "retention-owner-" + uuid.NewString()}
	ctx := WithUser(context.Background(), user)
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	legacy := model.CanvasProject{UserID: user.ID, ID: "legacy", CreatedAt: "2000-01-01T00:00:00Z", UpdatedAt: "2000-01-01T00:00:00Z", ProjectData: `{"id":"legacy","name":"old work","revision":3,"createdAt":"2000-01-01T00:00:00Z","updatedAt":"2000-01-01T00:00:00Z","nodes":[{"id":"keep"}]}`}
	if err := db.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	// A scheduled pass adopts old projects, preserving body and starting a
	// fresh server-side seven-day window rather than treating old dates as TTL.
	if err := repository.ExpireMeteorCanvasProjects(time.Now()); err != nil {
		t.Fatal(err)
	}
	projects, err := CurrentUserCanvasProjects(ctx)
	if err != nil || len(projects) != 1 || !strings.Contains(string(projects[0]), `"id":"keep"`) {
		t.Fatal("legacy body lost", projects, err)
	}
	var saved map[string]any
	_ = json.Unmarshal(projects[0], &saved)
	updated, _ := time.Parse(time.RFC3339Nano, saved["updatedAt"].(string))
	expires, _ := time.Parse(time.RFC3339Nano, saved["expiresAt"].(string))
	if time.Since(updated) > time.Minute || expires.Sub(updated) != 7*24*time.Hour || saved["expiryWarning"] != false {
		t.Fatal("legacy retention not initialized from server time", saved)
	}
	// A future client timestamp cannot extend the retention clock.
	saved["updatedAt"] = "2099-01-01T00:00:00Z"
	raw, _ := json.Marshal(saved)
	result, err := SaveCurrentUserCanvasProject(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(result, &saved)
	updated, _ = time.Parse(time.RFC3339Nano, saved["updatedAt"].(string))
	if time.Since(updated) > time.Minute || updated.After(time.Now().Add(time.Minute)) {
		t.Fatal("client controls retention", saved)
	}
	// Expire only this fixture, retaining the durable tombstone so stale sync
	// cannot recreate a paid workflow or restore an expired body.
	aged := time.Now().Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)
	if err := db.Model(&model.CanvasProject{}).Where("user_id = ? AND id = ?", user.ID, "legacy").Update("updated_at", aged).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := SaveCurrentUserCanvasProject(ctx, result); !errors.Is(err, ErrMeteorProjectConflict) {
		t.Fatal("expired project refreshed by stale client", err)
	}
	if err := repository.ExpireMeteorCanvasProjects(time.Now()); err != nil {
		t.Fatal(err)
	}
	var tombstone model.CanvasProject
	if err := db.First(&tombstone, "user_id = ? AND id = ?", user.ID, "legacy").Error; err != nil || tombstone.DeletedAt == "" || tombstone.ProjectData != "" {
		t.Fatal("expiry lost tombstone or retained full body", tombstone, err)
	}
	projects, err = SyncCurrentUserCanvasProjects(ctx, []json.RawMessage{result})
	if err != nil || len(projects) != 0 {
		t.Fatal("sync resurrected expired project", err)
	}
}
