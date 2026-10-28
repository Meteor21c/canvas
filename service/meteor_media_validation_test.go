package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestMeteorVideoDocumentedInputMatrix(t *testing.T) {
	for _, tc := range []struct {
		name  string
		input MeteorVideoMaterials
		valid bool
	}{
		{"text", MeteorVideoMaterials{Model: "doubao-seedance-2.0", Prompt: "fixture"}, true},
		{"empty", MeteorVideoMaterials{Model: "doubao-seedance-2.0"}, false},
		{"2.0 tail only", MeteorVideoMaterials{Model: "doubao-seedance-2.0", LastFrame: "last"}, false},
		{"kling tail only", MeteorVideoMaterials{Model: "kling-v3", LastFrame: "last"}, true},
		{"mixed site policy", MeteorVideoMaterials{Model: "doubao-seedance-2.5", FirstFrame: "first", References: []string{"image"}}, false},
		{"2.0 audio only", MeteorVideoMaterials{Model: "doubao-seedance-2.0", References: []string{"audio:a"}}, false},
		{"2.5 audio only", MeteorVideoMaterials{Model: "doubao-seedance-2.5", References: []string{"audio:a"}}, true},
		{"1.5 no references", MeteorVideoMaterials{Model: "doubao-seedance-1.5-pro", References: []string{"image"}}, false},
		{"kling no references", MeteorVideoMaterials{Model: "kling-v3", References: []string{"image"}}, false},
		{"omni no audio reference", MeteorVideoMaterials{Model: "kling-v3-omni", References: []string{"audio:a"}}, false},
		{"omni video audio forbidden", MeteorVideoMaterials{Model: "kling-v3-omni", Audio: true, References: []string{"video:v"}}, false},
		{"omni reference video", MeteorVideoMaterials{Model: "kling-v3-omni", References: []string{"video:v"}}, true},
		{"2.0 max three videos", MeteorVideoMaterials{Model: "doubao-seedance-2.0", References: []string{"video:a", "video:b", "video:c", "video:d"}}, false},
		{"2.5 four videos", MeteorVideoMaterials{Model: "doubao-seedance-2.5", References: []string{"video:a", "video:b", "video:c", "video:d"}}, true},
		{"2.5 first adaptive", MeteorVideoMaterials{Model: "doubao-seedance-2.5", FirstFrame: "first", AspectRatio: "adaptive"}, true},
		{"2.5 first fixed ratio", MeteorVideoMaterials{Model: "doubao-seedance-2.5", FirstFrame: "first", AspectRatio: "16:9"}, false},
		{"unknown ratio", MeteorVideoMaterials{Model: "doubao-seedance-2.0", Prompt: "fixture", AspectRatio: "4:5"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := MeteorValidateVideoInput(tc.input); (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
	raw, _ := json.Marshal(meteorVideoInputPolicy("doubao-seedance-2.0"))
	text := string(raw)
	if !strings.Contains(text, "\"videos\":3") || strings.Contains(strings.ToLower(text), "cost") {
		t.Fatal("capability contract missing limit or leaks cost", text)
	}
	if meteorVideoResolutionAllowed("doubao-seedance-2.5", "4k") || meteorVideoResolutionAllowed("doubao-seedance-2.0-mini", "1080p") || !meteorVideoResolutionAllowed("doubao-seedance-2.0", "4K") {
		t.Fatal("documented resolutions drifted")
	}
}

type meteorRepeatingReader struct{ count int64 }

func (r *meteorRepeatingReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	r.count += int64(len(p))
	return len(p), nil
}

func TestMeteorUploadsStreamBoundedAndOwnedReferences(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, DatabaseDSN: filepath.Join(t.TempDir(), "media.db"), StorageDriver: "sqlite", JWTSecret: "fixture", MeteorPublicBase: "https://site.example"}
	t.Cleanup(func() { config.Cfg = previous })
	ctx := WithUser(context.Background(), model.AuthUser{ID: "media-validation-" + uuid.NewString()})
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1YAAAAASUVORK5CYII=")
	object, err := MeteorUploadStream(ctx, "fixture.png", "image/png", bytes.NewReader(png))
	if err != nil {
		t.Fatal(err)
	}
	if object.Width != 1 || object.Height != 1 || object.Bytes != int64(len(png)) {
		t.Fatal("metadata not derived", object)
	}
	owned, err := MeteorResolveMaterial(ctx, object.URL, "image")
	if err != nil || owned.ID != object.ID {
		t.Fatal("owned object not reused", err)
	}
	if _, err = MeteorResolveMaterial(WithUser(context.Background(), model.AuthUser{ID: "other"}), object.URL, "image"); err == nil {
		t.Fatal("cross-user object accepted")
	}
	if _, err = MeteorResolveMaterial(ctx, object.URL, "video"); err == nil {
		t.Fatal("declared video accepted an image")
	}
	if _, err = MeteorResolveMaterial(ctx, "http://127.0.0.1/private.png", "image"); err == nil {
		t.Fatal("SSRF accepted")
	}
	if _, err = MeteorResolveMaterial(ctx, "asset://asset-provider-id", "image"); err == nil {
		t.Fatal("unverified external asset accepted")
	}
	inline := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	imported, err := MeteorResolveMaterial(ctx, inline, "image")
	if err != nil || imported.ID == object.ID {
		t.Fatal("inline material not imported", err)
	}
	repeating := &meteorRepeatingReader{}
	oversized := io.MultiReader(bytes.NewReader(png), repeating)
	if _, err = MeteorUploadStream(ctx, "oversized.png", "image/png", oversized); err == nil || !strings.Contains(err.Error(), "20 MiB") {
		t.Fatal("oversized image accepted", err)
	}
	if repeating.count > MeteorImageMaxBytes+512 {
		t.Fatal("reader consumed whole unbounded input", repeating.count)
	}
	entries, _ := os.ReadDir(meteorMediaRoot())
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "upload-") {
			t.Fatal("failed upload left a temp file")
		}
	}
	db, _ := repository.DB()
	_ = db.Model(&model.StorageObject{}).Where("id = ?", object.ID).Update("created_at", time.Now().Add(-8*24*time.Hour).UTC().Format(time.RFC3339Nano)).Error
	if _, err = MeteorResolveMaterial(ctx, object.URL, "image"); err == nil {
		t.Fatal("expired object reused")
	}
}

func TestMeteorProbeAudioDurationAndRejectFakeContainers(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe unavailable in this test environment; runtime Docker image installs it")
	}
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, DatabaseDSN: filepath.Join(t.TempDir(), "audio.db"), StorageDriver: "sqlite", JWTSecret: "fixture"}
	t.Cleanup(func() { config.Cfg = previous })
	ctx := WithUser(context.Background(), model.AuthUser{ID: "audio-validation-" + uuid.NewString()})
	const samples = 16000 * 3
	wav := make([]byte, 44+samples*2)
	copy(wav, "RIFF")
	binary.LittleEndian.PutUint32(wav[4:8], uint32(len(wav)-8))
	copy(wav[8:12], "WAVE")
	copy(wav[12:16], "fmt ")
	binary.LittleEndian.PutUint32(wav[16:20], 16)
	binary.LittleEndian.PutUint16(wav[20:22], 1)
	binary.LittleEndian.PutUint16(wav[22:24], 1)
	binary.LittleEndian.PutUint32(wav[24:28], 16000)
	binary.LittleEndian.PutUint32(wav[28:32], 32000)
	binary.LittleEndian.PutUint16(wav[32:34], 2)
	binary.LittleEndian.PutUint16(wav[34:36], 16)
	copy(wav[36:40], "data")
	binary.LittleEndian.PutUint32(wav[40:44], samples*2)
	object, err := MeteorUploadStream(ctx, "sound.wav", "audio/wav", bytes.NewReader(wav))
	if err != nil {
		t.Fatal(err)
	}
	if object.DurationSeconds < 2.99 || object.DurationSeconds > 3.01 {
		t.Fatal("duration not probed", object.DurationSeconds)
	}
	input := MeteorVideoMaterials{Model: "doubao-seedance-2.5", References: []string{"audio:" + object.URL}}
	prepared, err := MeteorPrepareVideoMaterials(ctx, input)
	if err != nil || !strings.HasPrefix(prepared.References[0], "audio:https://") {
		t.Fatal("valid audio reference rejected", err)
	}

	db, _ := repository.DB()
	for _, duration := range []float64{1.9, 30.1} {
		_ = db.Model(&model.StorageObject{}).Where("id = ?", object.ID).Update("duration_seconds", duration).Error
		if _, err := MeteorPrepareVideoMaterials(ctx, input); err == nil {
			t.Fatalf("invalid actual reference duration %v accepted", duration)
		}
	}
	fake := []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0, 'i', 's', 'o', 'm'}
	if _, err = MeteorUploadStream(ctx, "fake.mp4", "video/mp4", bytes.NewReader(fake)); err == nil {
		t.Fatal("fake container accepted")
	}
}
