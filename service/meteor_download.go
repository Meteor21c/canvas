package service

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"unicode"

	"github.com/tigerowo/infinite-canvas/repository"
)

type MeteorDownloadInput struct {
	StorageKey  string `json:"storageKey"`
	VideoTaskID string `json:"videoTaskId"`
	Filename    string `json:"filename"`
}

func validDownloadFilename(name string) bool {
	return name != "" && name != "." && name != ".." && len(name) <= 180 && !strings.ContainsAny(name, "/\\") && strings.IndexFunc(name, unicode.IsControl) < 0
}

// Mint only an owned, internal media URL. No remote URL or account key is accepted.
func MeteorDownloadURL(ctx context.Context, input MeteorDownloadInput) (string, error) {
	user, ok := UserFromContext(ctx)
	if !MeteorEnabled() || !ok || !validDownloadFilename(input.Filename) || (input.StorageKey == "") == (input.VideoTaskID == "") {
		return "", errors.New("下载参数无效")
	}
	var target string
	if input.StorageKey != "" {
		id, valid := strings.CutPrefix(input.StorageKey, "server:")
		if !valid || !MeteorOwnsObject(ctx, id) {
			return "", errors.New("素材不存在或无权访问")
		}
		file, err := meteorDownload(id, "")
		if err != nil {
			return "", err
		}
		_ = file.Stream.Close()
		target = MeteorMediaURL(id)
	} else {
		task, found, err := repository.GetUserVideoTask(user.ID, input.VideoTaskID)
		if err != nil || !found || meteorVideoExpired(task) || !IsCompletedVideoTaskStatus(task.Status) {
			return "", errors.New("视频不存在、尚未完成或已过期")
		}
		target = MeteorVideoURL(task.ID)
	}
	return target + "&download=1&filename=" + url.QueryEscape(input.Filename), nil
}

func SetMeteorDownloadHeaders(w http.ResponseWriter, r *http.Request) {
	if !MeteorEnabled() || r.URL.Query().Get("download") != "1" {
		return
	}
	filename := r.URL.Query().Get("filename")
	if !validDownloadFilename(filename) {
		filename = "video.mp4"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Accel-Buffering", "no")
}
