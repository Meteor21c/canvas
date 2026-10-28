package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm/clause"
	"io"
)

var ErrMeteorTaskExists = errors.New("任务已存在，返回原任务，不会重新请求")

var meteorCreationMu sync.Mutex
var meteorGenerationSlots = make(chan struct{}, 2)

func LockMeteorCreation() func() {
	if !MeteorEnabled() {
		return func() {}
	}
	meteorCreationMu.Lock()
	return meteorCreationMu.Unlock
}
func AcquireMeteorGeneration(ctx context.Context) (func(), error) {
	if !MeteorEnabled() {
		return func() {}, nil
	}
	select {
	case meteorGenerationSlots <- struct{}{}:
		return func() { <-meteorGenerationSlots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func meteorSignedURL(kind, id, path string) string {
	exp := strconv.FormatInt(time.Now().Add(30*time.Minute).Unix(), 10)
	mac := hmac.New(sha256.New, []byte(config.Cfg.JWTSecret))
	_, _ = mac.Write([]byte(kind + ":" + id + "\n" + exp))
	return path + "?expires=" + exp + "&signature=" + hex.EncodeToString(mac.Sum(nil))
}
func MeteorVideoURL(id string) string {
	return meteorSignedURL("video", id, "/studio/api/v1/videos/"+url.PathEscape(id)+"/content")
}
func MeteorAuthorizeVideo(r *http.Request, id string) bool {
	if !MeteorEnabled() || r.Method != http.MethodGet || len(id) > 200 || strings.ContainsAny(id, "/\\") {
		return false
	}
	exp, err := strconv.ParseInt(r.URL.Query().Get("expires"), 10, 64)
	if err != nil || exp < time.Now().Unix() || exp > time.Now().Add(31*time.Minute).Unix() {
		return false
	}
	mac := hmac.New(sha256.New, []byte(config.Cfg.JWTSecret))
	_, _ = mac.Write([]byte("video:" + id + "\n" + strconv.FormatInt(exp, 10)))
	signature, err := hex.DecodeString(r.URL.Query().Get("signature"))
	return err == nil && hmac.Equal(signature, mac.Sum(nil))
}
func MeteorVideoForContent(r *http.Request, id string) (model.VideoTask, error) {
	if user, ok := UserFromContext(r.Context()); ok {
		task, found, err := repository.GetUserVideoTask(user.ID, id)
		if err == nil && found && !meteorVideoExpired(task) {
			return task, nil
		}
	}
	if MeteorAuthorizeVideo(r, id) {
		task, found, err := repository.GetVideoTask(id)
		if err == nil && found && !meteorVideoExpired(task) {
			return task, nil
		}
	}
	return model.VideoTask{}, errors.New("视频不存在或访问链接已过期")
}

func meteorVideoExpired(task model.VideoTask) bool {
	if task.CompletedAt == "" {
		return false
	}
	expiry, err := time.Parse(time.RFC3339Nano, MeteorExpiry(task.CompletedAt))
	return err != nil || !time.Now().Before(expiry)
}

func MeteorStoreGeneratedImage(ctx context.Context, value string) (UploadedStorageObject, error) {
	if !strings.HasPrefix(value, "data:image/") {
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
			return UploadedStorageObject{}, errors.New("图片结果地址无效")
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, value, nil)
		if err != nil {
			return UploadedStorageObject{}, err
		}
		response, err := SafeProxyHTTPClient().Do(request)
		if err != nil {
			return UploadedStorageObject{}, errors.New("图片已生成，但下载原结果失败")
		}
		defer response.Body.Close()
		if response.StatusCode != 200 || response.ContentLength > 32<<20 {
			return UploadedStorageObject{}, errors.New("图片下载失败或超过32 MiB")
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, (32<<20)+1))
		if err != nil || len(data) > 32<<20 {
			return UploadedStorageObject{}, errors.New("图片超过32 MiB")
		}
		contentType := strings.ToLower(strings.Split(response.Header.Get("Content-Type"), ";")[0])
		if !strings.HasPrefix(contentType, "image/") {
			return UploadedStorageObject{}, errors.New("图片结果格式无效")
		}
		return meteorUpload(ctx, "generated-image", contentType, data)
	}
	header, encoded, found := strings.Cut(value, ",")
	if !found || !strings.HasSuffix(header, ";base64") || len(encoded) > 44<<20 {
		return UploadedStorageObject{}, errors.New("图片结果超过32 MiB或格式不支持")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return UploadedStorageObject{}, errors.New("图片数据无效")
	}
	return meteorUpload(ctx, "generated-image", strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64"), data)
}

// Requests with no durable upstream ID cannot safely be retried after restart.
func MeteorRecoverInterruptedTasks() {
	if !MeteorEnabled() {
		return
	}
	db, err := repository.DB()
	if err != nil {
		return
	}
	for _, table := range []string{"canvas_image_tasks", "canvas_audio_tasks"} {
		_ = db.Table(table).Where("status IN ?", []string{"queued", "processing", "running", "in_progress"}).Updates(map[string]any{"status": "submission_unknown", "error_detail": "服务重启，无法确认原请求结果；不会自动重发或声明退款，请在主站用量记录核实。", "updated_at": now()}).Error
	}
}

func TryMeteorGeneration() (func(), bool) {
	if !MeteorEnabled() {
		return func() {}, true
	}
	select {
	case meteorGenerationSlots <- struct{}{}:
		return func() { <-meteorGenerationSlots }, true
	default:
		return nil, false
	}
}

// Caller holds LockMeteorCreation until its initial task row is saved.
func ClaimMeteorTask(kind, id, userID string) (bool, error) {
	db, err := repository.DB()
	if err != nil {
		return false, err
	}
	receipt := model.MeteorTaskReceipt{ID: id, Kind: kind, UserID: userID, CreatedAt: now()}
	result := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&receipt)
	if result.Error != nil {
		return false, result.Error
	}
	if result.RowsAffected == 1 {
		return true, nil
	}
	var previous model.MeteorTaskReceipt
	if err := db.First(&previous, "id = ? AND kind = ?", id, kind).Error; err != nil {
		return false, err
	}
	if previous.UserID != userID {
		return false, errors.New("任务编号已被使用")
	}
	return false, nil
}
