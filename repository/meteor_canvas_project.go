package repository

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

var ErrMeteorProjectConflict = errors.New("画布已被其他页面更新或删除，请重新打开后再编辑")
var meteorProjectMu sync.Mutex

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
		for _, p := range existing {
			byID[p.ID] = p
		}
		for _, p := range projects {
			p.UserID = userID
			current, exists := byID[p.ID]
			if insertOnly && exists {
				continue
			}
			revision := meteorProjectRevision(p.ProjectData)
			if exists && (current.DeletedAt != "" || revision != meteorProjectRevision(current.ProjectData)) {
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
