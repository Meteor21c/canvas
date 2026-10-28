package repository

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

var ErrMeteorProjectConflict = errors.New("画布已被其他页面更新或删除，请重新打开后再编辑")
var meteorProjectMu sync.Mutex

const MeteorProjectRetention = 7 * 24 * time.Hour

func MeteorProjectExpired(project model.CanvasProject, at time.Time) bool {
	if !meteorProjectHasRetention(project) {
		return false
	}
	updated, err := time.Parse(time.RFC3339Nano, project.UpdatedAt)
	return err != nil || !at.Before(updated.Add(MeteorProjectRetention))
}

func meteorProjectHasRetention(project model.CanvasProject) bool {
	var data struct {
		Version int `json:"retentionVersion"`
	}
	return json.Unmarshal([]byte(project.ProjectData), &data) == nil && data.Version == 1
}

func initializeMeteorProjectRetention(tx *gorm.DB, project model.CanvasProject, at time.Time) (model.CanvasProject, error) {
	if project.DeletedAt != "" || meteorProjectHasRetention(project) {
		return project, nil
	}
	var data map[string]any
	if json.Unmarshal([]byte(project.ProjectData), &data) != nil {
		return project, errors.New("旧画布数据无效，未执行清理")
	}
	project.UpdatedAt = at.UTC().Format(time.RFC3339Nano)
	data["updatedAt"], data["retentionVersion"] = project.UpdatedAt, 1
	raw, err := json.Marshal(data)
	if err != nil {
		return project, err
	}
	project.ProjectData = string(raw)
	err = tx.Model(&model.CanvasProject{}).Where("user_id = ? AND id = ? AND deleted_at = ''", project.UserID, project.ID).Updates(map[string]any{"project_data": project.ProjectData, "updated_at": project.UpdatedAt}).Error
	return project, err
}

// Existing projects receive a full first seven-day window on adoption. Their
// former client timestamps are not evidence of a server-side retention date.
func PrepareMeteorCanvasProjectRetention(userID string, at time.Time) error {
	meteorProjectMu.Lock()
	defer meteorProjectMu.Unlock()
	db, err := DB()
	if err != nil {
		return err
	}
	var projects []model.CanvasProject
	if err := db.Where("user_id = ? AND deleted_at = ''", userID).Find(&projects).Error; err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		for _, project := range projects {
			if _, err := initializeMeteorProjectRetention(tx, project, at); err != nil {
				return err
			}
		}
		return nil
	})
}

// Expire bodies one row at a time while retaining the small ID tombstone. The
// same mutex as saves prevents expiring a concurrently refreshed project.
func ExpireMeteorCanvasProjects(at time.Time) error {
	meteorProjectMu.Lock()
	defer meteorProjectMu.Unlock()
	db, err := DB()
	if err != nil {
		return err
	}
	var projects []model.CanvasProject
	if err := db.Where("deleted_at = '' AND updated_at < ?", at.Add(-MeteorProjectRetention).UTC().Format(time.RFC3339Nano)).Limit(100).Find(&projects).Error; err != nil {
		return err
	}
	for _, project := range projects {
		if !meteorProjectHasRetention(project) {
			if _, err := initializeMeteorProjectRetention(db, project, at); err != nil {
				return err
			}
			continue
		}
		if !MeteorProjectExpired(project, at) {
			continue
		}
		if err := db.Model(&model.CanvasProject{}).Where("user_id = ? AND id = ? AND updated_at = ? AND deleted_at = ''", project.UserID, project.ID, project.UpdatedAt).Updates(map[string]any{"project_data": "", "deleted_at": at.UTC().Format(time.RFC3339Nano)}).Error; err != nil {
			return err
		}
	}
	return nil
}

func meteorProjectRevision(raw string) int64 {
	var value struct {
		Revision int64 `json:"revision"`
	}
	_ = json.Unmarshal([]byte(raw), &value)
	return value.Revision
}

// SaveMeteorCanvasProjects atomically enforces account quotas and revision checks.
// Import-only sync never replaces existing IDs, including deletion tombstones.
func SaveMeteorCanvasProjects(userID string, projects []model.CanvasProject, insertOnly bool) ([]model.CanvasProject, error) {
	meteorProjectMu.Lock()
	defer meteorProjectMu.Unlock()
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var saved []model.CanvasProject
	err = db.Transaction(func(tx *gorm.DB) error {
		var existing []model.CanvasProject
		if err := tx.Where("user_id = ?", userID).Find(&existing).Error; err != nil {
			return err
		}
		byID := map[string]model.CanvasProject{}
		for i, p := range existing {
			p, err = initializeMeteorProjectRetention(tx, p, time.Now())
			if err != nil {
				return err
			}
			existing[i] = p
			byID[p.ID] = p
		}
		for _, p := range projects {
			p.UserID = userID
			current, exists := byID[p.ID]
			if insertOnly && exists {
				continue
			}
			revision := meteorProjectRevision(p.ProjectData)
			if exists && (current.DeletedAt != "" || MeteorProjectExpired(current, time.Now()) || revision != meteorProjectRevision(current.ProjectData)) {
				return ErrMeteorProjectConflict
			}
			if !exists && !insertOnly && revision != 0 {
				return ErrMeteorProjectConflict
			}
			var data map[string]any
			if json.Unmarshal([]byte(p.ProjectData), &data) != nil {
				return errors.New("画布项目无效")
			}
			if exists {
				data["revision"] = revision + 1
				p.CreatedAt = current.CreatedAt
			} else if revision < 1 {
				data["revision"] = 1
			}
			// Clients cannot extend retention by supplying a future timestamp.
			p.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			if !exists {
				p.CreatedAt = p.UpdatedAt
			}
			data["createdAt"], data["updatedAt"] = p.CreatedAt, p.UpdatedAt
			data["retentionVersion"] = 1
			delete(data, "expiresAt")
			delete(data, "retentionDays")
			delete(data, "expiryWarning")
			raw, err := json.Marshal(data)
			if err != nil {
				return err
			}
			if len(raw) > 1<<20 {
				return errors.New("单个画布项目不能超过1 MiB")
			}
			p.ProjectData = string(raw)
			byID[p.ID] = p
		}
		count, bytes := 0, 0
		for _, p := range byID {
			if p.DeletedAt == "" {
				count++
				bytes += len(p.ProjectData)
			}
		}
		if count > 20 || bytes > 10<<20 {
			return errors.New("最多保存20个画布，项目总数据不能超过10 MiB")
		}
		for _, p := range projects {
			original, exists := func() (model.CanvasProject, bool) {
				for _, old := range existing {
					if old.ID == p.ID {
						return old, true
					}
				}
				return model.CanvasProject{}, false
			}()
			if insertOnly && exists {
				continue
			}
			value := byID[p.ID]
			if exists {
				result := tx.Model(&model.CanvasProject{}).Where("user_id = ? AND id = ? AND project_data = ? AND deleted_at = ''", userID, p.ID, original.ProjectData).Updates(map[string]any{"project_data": value.ProjectData, "updated_at": value.UpdatedAt})
				if result.Error != nil {
					return result.Error
				}
				if result.RowsAffected != 1 {
					return ErrMeteorProjectConflict
				}
			} else if err := tx.Create(&value).Error; err != nil {
				return err
			}
		}
		return tx.Where("user_id = ? AND deleted_at = ''", strings.TrimSpace(userID)).Order("updated_at DESC").Find(&saved).Error
	})
	return saved, err
}
