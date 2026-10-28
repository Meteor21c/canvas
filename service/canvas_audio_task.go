package service

import (
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type CanvasAudioTaskCreateInput struct {
	UserID          string
	UserDisplayName string
	SourceID        string
	NodeID          string
	ClientTaskID    string
	Model           string
	ChannelID       string
	UserChannelID   string
	ChannelName     string
	WorkflowRef     string
	Credits         float64
	BillingName     string
	BillingPath     string
	Prompt          string
	Endpoint        string
	ContentType     string
	RequestBody     string
}

func CreateCanvasAudioTask(input CanvasAudioTaskCreateInput) (model.CanvasAudioTask, error) {
	unlock := LockMeteorCreation()
	defer unlock()
	if MeteorEnabled() && input.ClientTaskID != "" {
		db, err := repository.DB()
		if err != nil {
			return model.CanvasAudioTask{}, err
		}
		var existing model.CanvasAudioTask
		if db.First(&existing, "id = ?", input.ClientTaskID).Error == nil {
			if existing.UserID != input.UserID {
				return model.CanvasAudioTask{}, errors.New("任务编号已被使用")
			}
			return existing, ErrMeteorTaskExists
		}
	}
	current := now()
	task := model.CanvasAudioTask{
		ID:              firstVideoTaskValue(input.ClientTaskID, "canvas_audio_task_"+uuid.NewString()),
		UserID:          strings.TrimSpace(input.UserID),
		UserDisplayName: strings.TrimSpace(input.UserDisplayName),
		Source:          "canvas",
		SourceID:        strings.TrimSpace(input.SourceID),
		NodeID:          strings.TrimSpace(input.NodeID),
		Model:           strings.TrimSpace(input.Model),
		ChannelID:       strings.TrimSpace(input.ChannelID),
		UserChannelID:   strings.TrimSpace(input.UserChannelID),
		ChannelName:     strings.TrimSpace(input.ChannelName),
		WorkflowRef:     input.WorkflowRef,
		Credits:         input.Credits,
		Status:          "queued",
		Progress:        0,
		Prompt:          strings.TrimSpace(input.Prompt),
		Endpoint:        strings.TrimSpace(input.Endpoint),
		ContentType:     strings.TrimSpace(input.ContentType),
		RequestBody:     input.RequestBody,
		CreatedAt:       current,
		UpdatedAt:       current,
	}
	if MeteorEnabled() {
		claimed, err := ClaimMeteorTask("audio", task.ID, task.UserID)
		if err != nil {
			return task, err
		}
		if !claimed {
			task.Status = "result_expired"
			task.ErrorDetail = "原任务结果已清理；不会按此编号重复提交，请在主站记录查看。"
			return task, ErrMeteorTaskExists
		}
	}
	saved := task
	var err error
	if input.WorkflowRef != "" {
		err = ConsumeUserCredits(task.UserID, input.BillingName, task.Credits, input.BillingPath, &task)
	} else {
		saved, err = repository.SaveCanvasAudioTask(task)
	}
	if err == nil {
		WakeVideoTaskPoller()
	}
	return saved, err
}

func GetUserCanvasAudioTask(userID string, id string) (model.CanvasAudioTask, bool, error) {
	return repository.GetUserCanvasAudioTask(strings.TrimSpace(userID), strings.TrimSpace(id))
}

func SaveCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	task.UpdatedAt = now()
	return repository.UpdateCanvasAudioTask(task)
}

func CanvasAudioTaskResponse(task model.CanvasAudioTask) map[string]any {
	if MeteorEnabled() && strings.HasPrefix(task.StorageKey, "server:") {
		task.AudioURL = MeteorMediaURL(strings.TrimPrefix(task.StorageKey, "server:"))
	}
	result := map[string]any{
		"id":           task.ID,
		"object":       "canvas.audio.task",
		"source":       task.Source,
		"source_id":    task.SourceID,
		"node_id":      task.NodeID,
		"model":        task.Model,
		"status":       task.Status,
		"progress":     task.Progress,
		"prompt":       task.Prompt,
		"created_at":   task.CreatedAt,
		"updated_at":   task.UpdatedAt,
		"started_at":   task.StartedAt,
		"completed_at": task.CompletedAt,
		"createdAt":    task.CreatedAt,
		"updatedAt":    task.UpdatedAt,
	}
	if task.AudioURL != "" {
		result["url"] = task.AudioURL
		result["audio_url"] = task.AudioURL
		result["storageKey"] = task.StorageKey
		result["mimeType"] = task.MimeType
		result["bytes"] = task.Bytes
	}
	if task.Error != "" || task.ErrorDetail != "" {
		result["error"] = map[string]any{"message": firstVideoTaskValue(task.Error, task.ErrorDetail)}
		result["error_detail"] = task.ErrorDetail
	}
	return result
}
