package service

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// These tests exercise actual SQLite writes and concurrent callers. No HTTP
// request or paid generation runner is installed or started.
func TestMeteorTaskIdempotencyAndRestartBoundary(t *testing.T) {
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, StorageDriver: "sqlite", DatabaseDSN: ":memory:"}
	t.Cleanup(func() { config.Cfg = previous })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection.SetMaxOpenConns(1)
	type result struct {
		id, user, status string
		err              error
	}
	type createFunc func(id, user string) result
	creators := []struct {
		name, table string
		create      createFunc
	}{
		{"image", "canvas_image_tasks", func(id, user string) result {
			task, err := CreateCanvasImageTask(CanvasImageTaskCreateInput{ClientTaskID: id, UserID: user, Model: "gpt-image-2", ChannelID: "meteor-key-7", Prompt: "no network", Endpoint: "/images/generations"})
			return result{task.ID, task.UserID, task.Status, err}
		}},
		{"audio", "canvas_audio_tasks", func(id, user string) result {
			task, err := CreateCanvasAudioTask(CanvasAudioTaskCreateInput{ClientTaskID: id, UserID: user, Model: "tts-model", ChannelID: "meteor-key-7", Prompt: "no network", Endpoint: "/audio/speech"})
			return result{task.ID, task.UserID, task.Status, err}
		}},
	}
	for _, creator := range creators {
		t.Run(creator.name, func(t *testing.T) {
			id := "ci-idempotency-" + creator.name
			const callers = 32
			results := make(chan result, callers)
			var group sync.WaitGroup
			for index := 0; index < callers; index++ {
				group.Add(1)
				go func() { defer group.Done(); results <- creator.create(id, "meteor_user_1") }()
			}
			group.Wait()
			close(results)
			created, reused := 0, 0
			for item := range results {
				if item.err == nil {
					created++
				} else if errors.Is(item.err, ErrMeteorTaskExists) {
					reused++
				} else {
					t.Fatalf("unexpected creation error: %v", item.err)
				}
				if item.id != id || item.user != "meteor_user_1" || item.status != "queued" {
					t.Fatalf("unexpected persisted task: %+v", item)
				}
			}
			if created != 1 || reused != callers-1 {
				t.Fatalf("created=%d reused=%d, require one unique creation", created, reused)
			}
			var count int64
			if err := db.Table(creator.table).Where("id = ?", id).Count(&count).Error; err != nil || count != 1 {
				t.Fatalf("durable records=%d err=%v", count, err)
			}
			outsider := creator.create(id, "meteor_user_2")
			if outsider.err == nil || errors.Is(outsider.err, ErrMeteorTaskExists) {
				t.Fatal("another user must not reuse or overwrite a task id")
			}
			for _, status := range []string{"completed", "failed", "cancelled", "submission_unknown"} {
				if err := db.Table(creator.table).Where("id = ?", id).Update("status", status).Error; err != nil {
					t.Fatal(err)
				}
				replay := creator.create(id, "meteor_user_1")
				if !errors.Is(replay.err, ErrMeteorTaskExists) || replay.status != status {
					t.Fatalf("terminal/unknown replay reset original %s task: %+v", status, replay)
				}
			}
			if creator.name == "image" {
				if err := db.Table(creator.table).Where("id = ?", id).Update("status", "completed").Error; err != nil {
					t.Fatal(err)
				}
				if err := DeleteUserCanvasImageTask("meteor_user_1", id); err != nil {
					t.Fatal(err)
				}
				hidden := creator.create(id, "meteor_user_1")
				if !errors.Is(hidden.err, ErrMeteorTaskExists) || hidden.status != "completed" {
					t.Fatal("hiding a task allowed another submission")
				}
			}
			// Simulate the bounded result-cache cleanup of this single test row.
			// The durable minimal receipt must still forbid another paid request.
			if err := db.Table(creator.table).Where("id = ?", id).Delete(map[string]any{}).Error; err != nil {
				t.Fatal(err)
			}
			expired := creator.create(id, "meteor_user_1")
			if !errors.Is(expired.err, ErrMeteorTaskExists) || expired.status != "result_expired" {
				t.Fatalf("result cleanup allowed resubmission: %+v", expired)
			}
			if item := creator.create(id, "meteor_user_2"); item.err == nil || errors.Is(item.err, ErrMeteorTaskExists) {
				t.Fatal("cleaned task receipt allowed another user to claim id")
			}
		})
	}
	t.Run("restart never resubmits without a live main session", func(t *testing.T) {
		for index, creator := range creators {
			id := fmt.Sprintf("ci-restart-%s-%d", creator.name, index)
			if item := creator.create(id, "meteor_user_1"); item.err != nil {
				t.Fatal(item.err)
			}
		}
		MeteorRecoverInterruptedTasks()
		for index, creator := range creators {
			id := fmt.Sprintf("ci-restart-%s-%d", creator.name, index)
			var row struct {
				Status      string
				ErrorDetail string
			}
			if err := db.Table(creator.table).Where("id = ?", id).Take(&row).Error; err != nil {
				t.Fatal(err)
			}
			if row.Status != "submission_unknown" || row.ErrorDetail == "" {
				t.Fatalf("restart did not preserve uncertainty: %+v", row)
			}
			replay := creator.create(id, "meteor_user_1")
			if !errors.Is(replay.err, ErrMeteorTaskExists) || replay.status != "submission_unknown" {
				t.Fatal("restart allowed another generation attempt")
			}
		}
		if _, err := MeteorSelectChannel("no-session-user", "gpt-image-2", "meteor-key-7"); !errors.Is(err, ErrMeteorSession) {
			t.Fatalf("no-session channel select = %v", err)
		}
	})
	// Keep the task structs referenced here so schema drift in either type
	// remains visible when these DB assertions are maintained.
	_ = model.CanvasImageTask{}
	_ = model.CanvasAudioTask{}
}
