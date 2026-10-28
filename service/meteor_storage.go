package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const MeteorMaxFileBytes = 64 << 20
const meteorMediaGlobalBytes = 2 << 30
const meteorMediaOwnerBytes = 512 << 20
const meteorMediaTTL = 24 * time.Hour
const meteorMediaActiveMaxTTL = 7 * 24 * time.Hour
const meteorMediaOwnerMaxFiles = 256

var meteorMediaMu sync.Mutex

func meteorMediaRoot() string {
	return filepath.Join(filepath.Dir(config.Cfg.DatabaseDSN), "meteor-media")
}

func MeteorMediaURL(id string) string {
	exp := strconv.FormatInt(time.Now().Add(30*time.Minute).Unix(), 10)
	mac := hmac.New(sha256.New, []byte(config.Cfg.JWTSecret))
	_, _ = mac.Write([]byte(id + "\n" + exp))
	return "/studio/api/files/" + id + "/content?expires=" + exp + "&signature=" + hex.EncodeToString(mac.Sum(nil))
}

func MeteorAuthorizeMedia(r *http.Request) bool {
	if !MeteorEnabled() || r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/api/files/") || !strings.HasSuffix(r.URL.Path, "/content") {
		return false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/files/"), "/content")
	if _, err := uuid.Parse(id); err != nil {
		return false
	}
	exp, err := strconv.ParseInt(r.URL.Query().Get("expires"), 10, 64)
	if err != nil || exp < time.Now().Unix() || exp > time.Now().Add(31*time.Minute).Unix() {
		return false
	}
	mac := hmac.New(sha256.New, []byte(config.Cfg.JWTSecret))
	_, _ = mac.Write([]byte(id + "\n" + strconv.FormatInt(exp, 10)))
	want, err := hex.DecodeString(r.URL.Query().Get("signature"))
	return err == nil && hmac.Equal(want, mac.Sum(nil))
}

func MeteorOwnsObject(ctx context.Context, id string) bool {
	user, ok := UserFromContext(ctx)
	if !ok {
		return false
	}
	object, err := repository.GetStorageObject(id)
	return err == nil && object.CreatedBy == user.ID && object.ProviderID == "meteor-local"
}

func meteorUpload(ctx context.Context, filename, contentType string, data []byte) (UploadedStorageObject, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UploadedStorageObject{}, ErrMeteorSession
	}
	if len(data) == 0 || len(data) > MeteorMaxFileBytes {
		return UploadedStorageObject{}, errors.New("素材不能超过64 MiB")
	}
	detected := http.DetectContentType(data)
	mediaType, _, _ := mime.ParseMediaType(contentType)
	if mediaType == "" {
		mediaType = detected
	}
	if !meteorSafeMediaType(mediaType, detected, data) {
		return UploadedStorageObject{}, errors.New("文件格式无效；只支持常见图片、视频和音频，不支持HTML或SVG")
	}
	meteorMediaMu.Lock()
	defer meteorMediaMu.Unlock()
	db, err := repository.DB()
	if err != nil {
		return UploadedStorageObject{}, err
	}
	var total, owner, ownerCount int64
	if err = db.Model(&model.StorageObject{}).Where("provider_id = ?", "meteor-local").Select("COALESCE(SUM(bytes),0)").Scan(&total).Error; err != nil {
		return UploadedStorageObject{}, err
	}
	if err = db.Model(&model.StorageObject{}).Where("provider_id = ? AND created_by = ?", "meteor-local", user.ID).Select("COALESCE(SUM(bytes),0)").Scan(&owner).Error; err != nil {
		return UploadedStorageObject{}, err
	}
	if err = db.Model(&model.StorageObject{}).Where("provider_id = ? AND created_by = ?", "meteor-local", user.ID).Count(&ownerCount).Error; err != nil {
		return UploadedStorageObject{}, err
	}
	if ownerCount >= meteorMediaOwnerMaxFiles {
		return UploadedStorageObject{}, errors.New("最多保留256个临时素材，请等待清理或删除旧素材")
	}
	if total+int64(len(data)) > meteorMediaGlobalBytes || owner+int64(len(data)) > meteorMediaOwnerBytes {
		return UploadedStorageObject{}, errors.New("临时素材额度已满，请等待清理或删除旧素材")
	}
	if err = os.MkdirAll(meteorMediaRoot(), 0700); err != nil {
		return UploadedStorageObject{}, err
	}
	id := uuid.NewString()
	path := filepath.Join(meteorMediaRoot(), id)
	if err = os.WriteFile(path, data, 0600); err != nil {
		return UploadedStorageObject{}, err
	}
	sum := sha256.Sum256(data)
	object := model.StorageObject{ID: id, ProviderID: "meteor-local", ObjectKey: id, MimeType: mediaType, Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:]), CreatedBy: user.ID, CreatedAt: now()}
	if _, err = repository.SaveStorageObject(object); err != nil {
		_ = os.Remove(path)
		return UploadedStorageObject{}, err
	}
	return UploadedStorageObject{ID: id, StorageKey: "server:" + id, URL: MeteorMediaURL(id), Bytes: object.Bytes, MimeType: mediaType}, nil
}

type meteorSectionReadCloser struct {
	*io.SectionReader
	file *os.File
}

func (stream meteorSectionReadCloser) Close() error { return stream.file.Close() }

func meteorDownload(id, rangeHeader string) (DownloadedStorageObject, error) {
	object, err := repository.GetStorageObject(id)
	if err != nil || object.ProviderID != "meteor-local" || object.ObjectKey != object.ID {
		return DownloadedStorageObject{}, errors.New("素材不存在或已过期")
	}
	created, _ := time.Parse(time.RFC3339Nano, object.CreatedAt)
	if !meteorRetainMedia(object, created, time.Now()) {
		return DownloadedStorageObject{}, errors.New("素材已过期，请重新上传")
	}
	if _, err := uuid.Parse(id); err != nil {
		return DownloadedStorageObject{}, errors.New("素材ID无效")
	}
	file, err := os.Open(filepath.Join(meteorMediaRoot(), id))
	if err != nil {
		return DownloadedStorageObject{}, errors.New("素材已过期，请重新上传")
	}
	start, end := int64(0), object.Bytes-1
	status := http.StatusOK
	if rangeHeader != "" {
		if !strings.HasPrefix(rangeHeader, "bytes=") || strings.Contains(rangeHeader, ",") {
			_ = file.Close()
			return DownloadedStorageObject{}, errors.New("范围请求无效")
		}
		left, right, found := strings.Cut(strings.TrimPrefix(rangeHeader, "bytes="), "-")
		if !found {
			_ = file.Close()
			return DownloadedStorageObject{}, errors.New("范围请求无效")
		}
		if left == "" {
			suffix, e := strconv.ParseInt(right, 10, 64)
			if e != nil || suffix <= 0 {
				_ = file.Close()
				return DownloadedStorageObject{}, errors.New("范围请求无效")
			}
			start = max(int64(0), object.Bytes-suffix)
		} else {
			start, err = strconv.ParseInt(left, 10, 64)
			if err == nil && right != "" {
				end, err = strconv.ParseInt(right, 10, 64)
			}
		}
		if err != nil || start < 0 || start > end || start >= object.Bytes {
			_ = file.Close()
			return DownloadedStorageObject{}, errors.New("范围请求无效")
		}
		end = min(end, object.Bytes-1)
		status = http.StatusPartialContent
	}
	contentRange := ""
	if status == http.StatusPartialContent {
		contentRange = fmt.Sprintf("bytes %d-%d/%d", start, end, object.Bytes)
	}
	return DownloadedStorageObject{Object: object, Stream: meteorSectionReadCloser{SectionReader: io.NewSectionReader(file, start, end-start+1), file: file}, StatusCode: status, ContentLength: end - start + 1, ContentRange: contentRange, AcceptRanges: true}, nil
}

func meteorDeleteObject(ctx context.Context, id string) error {
	if !MeteorOwnsObject(ctx, id) {
		return errors.New("素材不存在")
	}
	if meteorActiveMediaReference(id) {
		return errors.New("素材正在生成任务中使用，稍后再删除")
	}
	if _, err := uuid.Parse(id); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(meteorMediaRoot(), id)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return repository.DeleteStorageObjectRecord(id)
}

func meteorActiveMediaReference(id string) bool {
	db, err := repository.DB()
	if err != nil {
		return true
	}
	var count int64
	for _, table := range []string{"video_tasks", "canvas_image_tasks", "canvas_audio_tasks"} {
		if db.Table(table).Where("status NOT IN ? AND (request_body LIKE ? OR response_body LIKE ?)", []string{"completed", "failed", "cancelled"}, "%"+id+"%", "%"+id+"%").Count(&count).Error != nil {
			return true
		}
		if count > 0 {
			return true
		}
	}
	return false
}

func StartMeteorMaintenance() {
	if !MeteorEnabled() {
		return
	}
	go func() {
		for {
			meteorMaintain()
			time.Sleep(time.Minute)
		}
	}()
}

func meteorMaintain() {
	db, err := repository.DB()
	if err != nil {
		return
	}
	_ = repository.DeleteFinishedVideoTasksBefore(time.Now().Add(-meteorMediaTTL).UTC().Format(time.RFC3339Nano))
	_ = repository.DeleteFinishedCanvasImageTasksBefore(time.Now().Add(-meteorMediaTTL).UTC().Format(time.RFC3339Nano))
	_ = repository.DeleteFinishedCanvasAudioTasksBefore(time.Now().Add(-meteorMediaTTL).UTC().Format(time.RFC3339Nano))
	var objects []model.StorageObject
	cutoff := time.Now().Add(-meteorMediaTTL).UTC().Format(time.RFC3339Nano)
	if db.Where("provider_id = ? AND created_at < ?", "meteor-local", cutoff).Limit(100).Find(&objects).Error != nil {
		return
	}
	for _, object := range objects {
		created, _ := time.Parse(time.RFC3339Nano, object.CreatedAt)
		if _, err := uuid.Parse(object.ID); err != nil || object.ObjectKey != object.ID || meteorRetainMedia(object, created, time.Now()) {
			continue
		}
		if time.Since(created) > meteorMediaActiveMaxTTL && meteorActiveMediaReference(object.ID) {
			for _, table := range []string{"video_tasks", "canvas_image_tasks", "canvas_audio_tasks"} {
				_ = db.Table(table).Where("status NOT IN ? AND (request_body LIKE ? OR response_body LIKE ?)", []string{"completed", "failed", "cancelled"}, "%"+object.ID+"%", "%"+object.ID+"%").Update("error_detail", "引用素材已超过7天并清理；原任务编号仍保留，不会自动重发或声明退款。").Error
			}
		}
		if err := os.Remove(filepath.Join(meteorMediaRoot(), object.ID)); err == nil || os.IsNotExist(err) {
			_ = repository.DeleteStorageObjectRecord(object.ID)
		}
	}
}

// Active generation references receive bounded grace, including after restart.
// Unknown submissions never trigger a second paid request or an invented refund.
func meteorRetainMedia(object model.StorageObject, created, at time.Time) bool {
	age := at.Sub(created)
	if age <= meteorMediaTTL {
		return true
	}
	if age > meteorMediaActiveMaxTTL {
		return false
	}
	return meteorActiveMediaReference(object.ID)
}

func meteorSafeMediaType(declared, detected string, data []byte) bool {
	allowed := map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true, "video/mp4": true, "video/webm": true, "video/quicktime": true, "audio/mpeg": true, "audio/mp4": true, "audio/wav": true, "audio/x-wav": true, "audio/ogg": true, "audio/webm": true, "audio/flac": true}
	if !allowed[declared] {
		return false
	}
	if detected == declared {
		return true
	}
	if detected == "audio/wave" && (declared == "audio/wav" || declared == "audio/x-wav") {
		return true
	}
	if detected == "video/mp4" && (declared == "audio/mp4" || declared == "video/quicktime") {
		return true
	}
	if detected == "application/ogg" && declared == "audio/ogg" {
		return true
	}
	if detected == "application/octet-stream" {
		if (declared == "audio/webm" || declared == "video/webm") && len(data) > 4 && string(data[:4]) == "\x1a\x45\xdf\xa3" {
			return true
		}
		if declared == "image/avif" && len(data) > 12 && string(data[4:8]) == "ftyp" && (string(data[8:12]) == "avif" || string(data[8:12]) == "avis") {
			return true
		}
		if declared == "audio/flac" && len(data) > 4 && string(data[:4]) == "fLaC" {
			return true
		}
	}
	// WebM/AVIF signatures are not recognized by every Go detector. Generic
	// octet-stream alone is insufficient; require the actual format magic.
	return false
}
