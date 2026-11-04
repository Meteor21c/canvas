package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestMeteorNewVideoModelCapabilitiesAndSafeQuotes(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		mps := r.URL.Query().Get("model") == "tencent-mps-superres"
		if r.URL.Query().Get("catalog") == "true" {
			if mps {
				fmt.Fprint(w, `{"model":"tencent-mps-superres","resolutions":["720p","2K"],"scenarios":[{"resolutions":["720p","2K"],"billing_mode":"token","currency":"CNY","sale_per_million":"2.3","official_per_million":"10","sale_rate_to_official":"0.23","frame_rate":60}]}`)
			} else {
				fmt.Fprint(w, `{"model":"MiniMax-H3","resolutions":["768P","2K"],"scenarios":[{"resolutions":["768P","2K"],"billing_mode":"second","currency":"CNY","sale_per_second":"0.2","official_per_second":"1","sale_rate_to_official":"0.2","surcharges":[{"code":"extra_images","metric_key":"h3_input_extra_images","unit":"image","free_units":5,"sale_unit_price":"0.02","official_unit_price":"0.1","upstream_unit_price":"private"}]}]}`)
			}
			return
		}
		if mps {
			if r.URL.Query().Get("frame_rate") != "60" || r.URL.Query().Get("source_duration_seconds") != "12.5" {
				t.Error("MPS quote parameters not preserved")
			}
			if r.URL.Query().Has("duration") {
				t.Error("MPS must not send an unsupported output duration")
			}
			fmt.Fprint(w, `{"billing_mode":"token","currency":"CNY","sale_per_million":"2.3","official_per_million":"10","sale_rate_to_official":"0.23","precharge_amount":"0.2"}`)
		} else {
			if r.URL.Query().Get("input_image_count") != "8" || r.URL.Query().Get("input_video_seconds") != "3.5" {
				t.Error("H3 quote inputs not preserved")
			}
			if r.URL.Query().Has("frame_rate") || r.URL.Query().Has("source_duration_seconds") {
				t.Error("H3 must not send invalid zero enhancement parameters")
			}
			fmt.Fprint(w, `{"billing_mode":"second","currency":"CNY","sale_per_second":"0.2","official_per_second":"1","precharge_amount":"1.41","estimated_surcharge_amount":"0.41","surcharges":[{"code":"extra_images","metric_key":"h3_input_extra_images","unit":"image","free_units":5,"sale_unit_price":"0.02","official_unit_price":"0.1","upstream_unit_price":"private"}]}`)
		}
	})
	meteorSessions.Lock()
	session := meteorSessions.byUser[user]
	for _, name := range []string{"MiniMax-H3", "tencent-mps-superres"} {
		channel.Models = append(channel.Models, name)
		channel.ModelCapabilities[name] = "video"
	}
	session.Channels = []model.ModelChannel{channel}
	meteorSessions.Unlock()
	cap, err := MeteorMediaCapabilities(context.Background(), user, "video", channel.ID, "tencent-mps-superres")
	if err != nil || !cap.Available || cap.Duration != nil || cap.Operation != "enhance" || cap.RetentionHours != 24 || len(cap.FrameRates) != 1 || cap.FrameRates[0] != 60 {
		t.Fatal("MPS capability invalid", cap, err)
	}
	quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "video", Model: cap.Model, ChannelID: channel.ID, Resolution: "2K", FrameRate: 60, SourceDurationSeconds: 12.5})
	if err != nil || !quote.Available || quote.BillingMode != "token" || quote.EstimatedAmount != nil || *quote.PrechargeAmount != "0.2" {
		t.Fatal("MPS quote must not invent minute/token amount", quote, err)
	}
	if err := ValidateMeteorVideoParameters(context.Background(), user, MeteorQuoteInput{Kind: "video", Model: cap.Model, ChannelID: channel.ID, Resolution: "2K", FrameRate: 30}); err == nil {
		t.Fatal("unsupported FPS scenario accepted")
	}
	cap, err = MeteorMediaCapabilities(context.Background(), user, "video", channel.ID, "MiniMax-H3")
	if err != nil || !cap.Available || cap.Duration.Min != 4 || cap.Duration.Max != 15 || cap.MaxReferences != 10 || cap.SupportsAudio || cap.Resolutions[0] != "768P" {
		t.Fatal("H3 capability invalid", cap, err)
	}
	quote, err = MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "video", Model: cap.Model, ChannelID: channel.ID, Resolution: "768P", Duration: 5, InputImageCount: 8, InputVideoSeconds: 3.5})
	if err != nil || !quote.Available || *quote.EstimatedAmount != "1.41" || len(quote.Surcharges) != 1 || *quote.Surcharges[0].SiteUnitPrice != "0.02" {
		t.Fatal("H3 surcharge quote invalid", quote, err)
	}
	public, _ := json.Marshal([]any{cap, quote})
	for _, forbidden := range []string{"upstream", "markup", "private", "fixture-"} {
		if strings.Contains(string(public), forbidden) {
			t.Fatal("private price leaked", forbidden)
		}
	}
}

func TestMeteorModelReferenceCounts(t *testing.T) {
	refs := func(count int) []string {
		result := make([]string, count)
		for i := range result {
			result[i] = "image"
		}
		return result
	}
	for _, tc := range []struct {
		model string
		count int
		valid bool
	}{{"doubao-seedance-2.0", 9, true}, {"doubao-seedance-2.0", 10, false}, {"doubao-seedance-2.5", 10, true}, {"doubao-seedance-2.5", 11, false}, {"MiniMax-H3", 10, true}, {"MiniMax-H3", 11, false}, {"kling-v3-omni", 5, false}} {
		if err := MeteorValidateVideoInput(MeteorVideoMaterials{Model: tc.model, Prompt: "fixture", References: refs(tc.count)}); (err == nil) != tc.valid {
			t.Fatal(tc, err)
		}
	}
	if MeteorValidateVideoInput(MeteorVideoMaterials{Model: "MiniMax-H3", Prompt: "fixture", FirstFrame: "first", References: refs(1)}) == nil {
		t.Fatal("H3 frames mixed with references")
	}
	if MeteorValidateVideoInput(MeteorVideoMaterials{Model: "MiniMax-H3", Prompt: "fixture", References: []string{"audio:a"}}) == nil {
		t.Fatal("H3 audio-only reference accepted")
	}
}

func TestMeteorEnhancementExpiresWithoutAffectingSevenDayVideos(t *testing.T) {
	previous := config.Cfg
	config.Cfg.MeteorMode = true
	t.Cleanup(func() { config.Cfg = previous })
	task := model.VideoTask{ID: "mps-expiry", Model: "tencent-mps-superres", Status: "completed", VideoURL: "https://private.invalid/result", CompletedAt: time.Now().Add(-25 * time.Hour).UTC().Format(time.RFC3339Nano)}
	if !meteorVideoExpired(task) {
		t.Fatal("MPS result still available after 24 hours")
	}
	response := VideoTaskResponse(task)
	if response["status"] != "expired" || response["url"] != nil || response["video_url"] != nil || response["retentionHours"] != 24 {
		t.Fatal("expired result response leaked playback", response)
	}
	task.Model = "MiniMax-H3"
	if meteorVideoExpired(task) || VideoTaskResponse(task)["url"] == nil {
		t.Fatal("normal videos lost seven-day availability")
	}
	task.Model, task.CompletedAt = "tencent-mps-superres", time.Now().Add(-23*time.Hour).UTC().Format(time.RFC3339Nano)
	if meteorVideoExpired(task) || VideoTaskResponse(task)["url"] == nil {
		t.Fatal("MPS expired prematurely")
	}
}

func TestMeteorEnhancementProbesOwnedSourceAndRejectsUnderstatedFPS(t *testing.T) {
	for _, program := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(program); err != nil {
			t.Skip(program + " unavailable")
		}
	}
	previous := config.Cfg
	root := t.TempDir()
	config.Cfg = config.Config{MeteorMode: true, DatabaseDSN: filepath.Join(root, "source.db"), StorageDriver: "sqlite", JWTSecret: "fixture", MeteorPublicBase: "https://site.example"}
	t.Cleanup(func() { config.Cfg = previous })
	source := filepath.Join(root, "source.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=60", "-frames:v", "60", "-c:v", "mpeg4", "-an", source).CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	file, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	owner := model.AuthUser{ID: "enhancement-owner-" + filepath.Base(root)}
	owned := WithUser(context.Background(), owner)
	object, err := MeteorUploadStream(owned, "source.mp4", "video/mp4", file)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := MeteorPrepareEnhancementSource(owned, object.URL, 30); err == nil {
		t.Fatal("60 FPS source accepted lower-priced 30 FPS declaration")
	}
	url, duration, err := MeteorPrepareEnhancementSource(owned, object.URL, 60)
	if err != nil || !strings.HasPrefix(url, "https://site.example/") || duration < 0.99 || duration > 1.01 {
		t.Fatal("source metadata not preserved", url, duration, err)
	}
	if _, _, err := MeteorPrepareEnhancementSource(WithUser(context.Background(), model.AuthUser{ID: "other-enhancement-owner"}), object.URL, 60); err == nil {
		t.Fatal("foreign source accepted")
	}
}
