package service

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/repository"
)

// A signed playback URL is not an arbitrary download target. Resolve its task
// using the authenticated owner, then read only that task's fixed gateway path.
// This also supports relative playback URLs without a public self-request.
func meteorResolveTaskVideoMaterial(ctx context.Context, id string) (UploadedStorageObject, error) {
	user, ok := UserFromContext(ctx)
	if !ok || id == "" || len(id) > 200 || strings.ContainsAny(id, "/\\\r\n") {
		return UploadedStorageObject{}, errors.New("视频素材不存在或不属于当前用户")
	}
	task, found, err := repository.GetUserVideoTask(user.ID, id)
	if err != nil || !found || task.UserID != user.ID || !IsCompletedVideoTaskStatus(task.Status) {
		return UploadedStorageObject{}, errors.New("视频素材不存在或尚未完成")
	}
	if task.Model == "tencent-mps-superres" {
		return UploadedStorageObject{}, errors.New("请下载后重新上传视频")
	}
	expiry, err := time.Parse(time.RFC3339Nano, MeteorVideoExpiry(task))
	if err != nil || !time.Now().Before(expiry) || meteorVideoExpired(task) {
		return UploadedStorageObject{}, errors.New("视频素材已过期，请重新上传")
	}
	upstreamID := firstVideoTaskValue(task.UpstreamTaskID, task.UpstreamVideoID)
	if upstreamID == "" || len(upstreamID) > 512 || strings.ContainsAny(upstreamID, "/\\\r\n") {
		return UploadedStorageObject{}, errors.New("视频素材任务无效")
	}
	channel, err := MeteorSelectChannel(user.ID, task.Model, task.ChannelID)
	if err != nil {
		return UploadedStorageObject{}, errors.New("视频素材渠道暂不可用")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(channel.BaseURL, "/")+"/v1/videos/"+url.PathEscape(upstreamID)+"/content", nil)
	if err != nil {
		return UploadedStorageObject{}, errors.New("视频素材任务无效")
	}
	SetModelChannelAuthHeader(req, channel)
	response, err := HTTPClientForChannel(channel).Do(req)
	if err != nil {
		return UploadedStorageObject{}, errors.New("视频素材下载暂不可用")
	}
	defer response.Body.Close()
	mediaType, _, _ := mime.ParseMediaType(strings.ToLower(response.Header.Get("Content-Type")))
	if response.StatusCode != http.StatusOK || meteorMediaKind(mediaType) != "video" || response.ContentLength > MeteorVideoMaxBytes {
		return UploadedStorageObject{}, errors.New("视频素材格式、大小或下载状态无效")
	}
	return MeteorUploadStream(ctx, "task-video-material", mediaType, response.Body)
}
