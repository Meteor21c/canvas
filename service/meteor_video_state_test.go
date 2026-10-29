package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestMeteorVideoResponsePreservesCompletedResultWithoutCancellation(t *testing.T) {
	previous := config.Cfg
	config.Cfg.MeteorMode = true
	t.Cleanup(func() { config.Cfg = previous })
	task := model.VideoTask{ID: "fixture-completed-video", Status: "completed", Progress: 100, UpstreamTaskID: "original-upstream-task"}
	response := VideoTaskResponse(task)
	if response["can_cancel"] != false || response["status"] != "completed" || response["progress"] != 100 || response["url"] == "" {
		t.Fatal("completed main-site task must remain readable and noncancellable")
	}
	if response["task_id"] != task.UpstreamTaskID {
		t.Fatal("status recovery changed original task identity")
	}
	config.Cfg.MeteorMode = false
	if VideoTaskResponse(task)["can_cancel"] != true {
		t.Fatal("non-Meteor task cancellation was disabled")
	}
}
