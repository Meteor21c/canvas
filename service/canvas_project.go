package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

var ErrMeteorProjectConflict = repository.ErrMeteorProjectConflict

type canvasProjectMetadata struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func canvasProjectFromRaw(
	userID string,
	raw json.RawMessage,
) (model.CanvasProject, error) {
	if MeteorEnabled() {
		if len(raw) > 1<<20 {
			return model.CanvasProject{}, errors.New("单个画布项目不能超过1 MiB")
		}
		if err := MeteorValidateMetadata(raw); err != nil {
			return model.CanvasProject{}, err
		}
	}
	var metadata canvasProjectMetadata
	if len(raw) == 0 || json.Unmarshal(raw, &metadata) != nil {
		return model.CanvasProject{}, errors.New("画布项目数据无效")
	}

	metadata.ID = strings.TrimSpace(metadata.ID)
	metadata.CreatedAt = strings.TrimSpace(metadata.CreatedAt)
	metadata.UpdatedAt = strings.TrimSpace(metadata.UpdatedAt)
	if metadata.ID == "" || metadata.CreatedAt == "" ||
		metadata.UpdatedAt == "" {
		return model.CanvasProject{}, errors.New("画布项目数据无效")
	}

	return model.CanvasProject{
		UserID:      strings.TrimSpace(userID),
		ID:          metadata.ID,
		ProjectData: string(raw),
		CreatedAt:   metadata.CreatedAt,
		UpdatedAt:   metadata.UpdatedAt,
	}, nil
}

func canvasProjectData(
	projects []model.CanvasProject,
) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(projects))
	for _, project := range projects {
		if MeteorEnabled() && repository.MeteorProjectExpired(project, time.Now()) {
			continue
		}
		if strings.TrimSpace(project.ProjectData) != "" {
			if MeteorEnabled() {
				result = append(result, meteorProjectPayload(project))
				continue
			}
			result = append(
				result,
				json.RawMessage(project.ProjectData),
			)
		}
	}
	return result
}

func meteorProjectPayload(project model.CanvasProject) json.RawMessage {
	var data map[string]any
	if json.Unmarshal([]byte(project.ProjectData), &data) != nil {
		return json.RawMessage(`{}`)
	}
	expires := MeteorExpiry(project.UpdatedAt)
	data["updatedAt"], data["createdAt"] = project.UpdatedAt, project.CreatedAt
	data["expiresAt"], data["retentionDays"] = expires, 7
	expiry, _ := time.Parse(time.RFC3339Nano, expires)
	data["expiryWarning"] = time.Until(expiry) <= 24*time.Hour
	raw, _ := json.Marshal(data)
	return raw
}

func CurrentUserCanvasProjects(
	ctx context.Context,
) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	if MeteorEnabled() {
		if err := repository.PrepareMeteorCanvasProjectRetention(user.ID, time.Now()); err != nil {
			return nil, err
		}
	}

	projects, err := repository.ListUserCanvasProjects(user.ID)
	if err != nil {
		return nil, err
	}
	return canvasProjectData(projects), nil
}

func SaveCurrentUserCanvasProject(
	ctx context.Context,
	raw json.RawMessage,
) (json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	project, err := canvasProjectFromRaw(user.ID, raw)
	if err != nil {
		return nil, err
	}
	if MeteorEnabled() {
		saved, err := repository.SaveMeteorCanvasProjects(user.ID, []model.CanvasProject{project}, false)
		if err != nil {
			return nil, err
		}
		for _, value := range saved {
			if value.ID == project.ID {
				return meteorProjectPayload(value), nil
			}
		}
		return nil, ErrMeteorProjectConflict
	}
	saved, err := repository.SaveUserCanvasProject(project)
	if err != nil {
		return nil, err
	}
	if saved.DeletedAt != "" {
		return nil, errors.New("画布项目已删除")
	}
	return json.RawMessage(saved.ProjectData), nil
}

func SyncCurrentUserCanvasProjects(
	ctx context.Context,
	rawProjects []json.RawMessage,
) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	if MeteorEnabled() && len(rawProjects) > 20 {
		return nil, errors.New("最多同步20个画布")
	}
	seen := map[string]bool{}
	projects := make([]model.CanvasProject, 0, len(rawProjects))
	for _, raw := range rawProjects {
		project, err := canvasProjectFromRaw(user.ID, raw)
		if err != nil {
			return nil, err
		}
		if MeteorEnabled() && seen[project.ID] {
			return nil, errors.New("画布编号重复")
		}
		seen[project.ID] = true
		projects = append(projects, project)
	}

	if MeteorEnabled() {
		saved, err := repository.SaveMeteorCanvasProjects(user.ID, projects, true)
		return canvasProjectData(saved), err
	}
	saved, err := repository.SaveUserCanvasProjects(user.ID, projects)
	if err != nil {
		return nil, err
	}
	return canvasProjectData(saved), nil
}

func DeleteCurrentUserCanvasProjects(
	ctx context.Context,
	projectIDs []string,
) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}

	for _, projectID := range projectIDs {
		if strings.TrimSpace(projectID) != "" {
			return repository.SoftDeleteUserCanvasProjects(
				user.ID,
				projectIDs,
				time.Now().UTC().Format(time.RFC3339Nano),
			)
		}
	}
	return errors.New("画布项目参数无效")
}
