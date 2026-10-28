package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func meteorVideoBody(raw []byte) ([]byte, error) {
	var input map[string]any
	if json.Unmarshal(raw, &input) != nil {
		return nil, errors.New("视频请求必须是JSON")
	}
	if err := meteorValidateValues(input, 1); err != nil {
		return nil, err
	}
	out := map[string]any{}
	for _, field := range []string{"model", "prompt", "duration", "resolution", "aspect_ratio", "mode", "audio", "reference_images", "start_image_url", "end_image_url"} {
		if value, ok := input[field]; ok {
			out[field] = value
		}
	}
	if out["duration"] == nil {
		out["duration"] = input["seconds"]
	}
	if value, ok := out["duration"].(string); ok {
		if duration, err := strconv.Atoi(value); err == nil {
			out["duration"] = duration
		}
	}
	if out["duration"] == nil {
		out["duration"] = 5
	}
	duration, err := strconv.ParseFloat(toMeteorString(out["duration"]), 64)
	if err != nil || duration != float64(int(duration)) {
		return nil, errors.New("视频时长须为整数秒")
	}
	out["duration"] = int(duration)
	if out["audio"] == nil {
		out["audio"] = false
	}
	if _, ok := out["audio"].(bool); !ok {
		return nil, errors.New("视频音频参数无效")
	}
	if out["resolution"] == nil {
		out["resolution"] = firstNonEmpty(readStringPath(input, "resolution_name"), readStringPath(input, "quality"), readStringPath(input, "vquality"), "720p")
	}
	if out["aspect_ratio"] == nil {
		if size := readStringPath(input, "size"); strings.Contains(size, ":") {
			out["aspect_ratio"] = size
		}
	}
	if out["reference_images"] == nil {
		if value, ok := input["references"]; ok {
			out["reference_images"] = value
		}
	}
	if out["start_image_url"] == nil {
		if value, ok := input["first_frame"]; ok {
			out["start_image_url"] = value
		}
	}
	if out["end_image_url"] == nil {
		if value, ok := input["last_frame"]; ok {
			out["end_image_url"] = value
		}
	}

	if out["resolution"] == nil {
		out["resolution"] = input["resolution_name"]
	}
	if out["reference_images"] == nil {
		for _, field := range []string{"input_reference[]", "input_reference", "images"} {
			if value, ok := input[field]; ok {
				out["reference_images"] = value
				break
			}
		}
	}
	if out["start_image_url"] == nil {
		out["start_image_url"] = input["first_frame_url"]
	}
	if out["end_image_url"] == nil {
		out["end_image_url"] = input["last_frame_url"]
	}
	refs := []any{}
	appendRefs := func(value any, prefix string) {
		if single, ok := value.(string); ok {
			value = []any{single}
		}
		if values, ok := value.([]any); ok {
			for _, item := range values {
				if entry, ok := item.(map[string]any); ok {
					item = firstNonEmpty(readStringPath(entry, "url"), readStringPath(entry, "image_url"))
				}
				if text, ok := item.(string); ok && text != "" {
					refs = append(refs, prefix+text)
				}
			}
		}
	}
	appendRefs(out["reference_images"], "")
	appendRefs(input["reference_videos"], "video:")
	appendRefs(input["reference_audios"], "audio:")
	appendRefs(input["video_reference[]"], "video:")
	appendRefs(input["audio_reference[]"], "audio:")
	if len(refs) > 0 {
		out["reference_images"] = refs
	}
	referenceCount := len(refs) + meteorReferenceCount(out["start_image_url"]) + meteorReferenceCount(out["end_image_url"])
	if referenceCount > 4 {
		return nil, errors.New("视频参考素材最多4个")
	}
	out["watermark"] = false

	// Main gateway supplies the existing asset-library review and billing queue.
	return json.Marshal(out)
}

func meteorCreateVideo(w http.ResponseWriter, r *http.Request) {
	unlock := service.LockMeteorCreation()
	defer unlock()
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		FailWithStatus(w, 401, "请先登录")
		return
	}
	id := readClientVideoTaskID(r)
	if id == "" {
		id = "client_video_task_" + uuid.NewString()
	}
	if existing, found, _ := service.GetUserVideoTask(user.ID, id); found {
		OK(w, service.VideoTaskResponse(existing))
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, (16<<20)+1))
	if err != nil || len(raw) > 16<<20 {
		FailWithStatus(w, 413, "视频请求不能超过16 MiB")
		return
	}
	body, err := meteorVideoBody(raw)
	if err != nil {
		Fail(w, err.Error())
		return
	}
	var input map[string]any
	_ = json.Unmarshal(body, &input)
	modelName := readStringPath(input, "model")
	channel, err := service.MeteorSelectChannel(user.ID, modelName, r.Header.Get("X-Model-Channel-ID"))
	if err != nil {
		FailWithStatus(w, 400, err.Error())
		return
	}
	duration, _ := strconv.Atoi(toMeteorString(input["duration"]))
	audio, _ := input["audio"].(bool)
	inputVideo := meteorVideoReference(input["reference_images"]) || meteorVideoReference(input["start_image_url"]) || meteorVideoReference(input["end_image_url"])
	if err := service.ValidateMeteorVideo(r.Context(), user.ID, channel.ID, modelName, duration, readStringPath(input, "resolution"), audio, inputVideo); err != nil {
		FailWithStatus(w, 400, err.Error())
		return
	}
	claimed, err := service.ClaimMeteorTask("video", id, user.ID)
	if err != nil {
		FailWithStatus(w, 409, "任务编号不可复用")
		return
	}
	if !claimed {
		OK(w, map[string]any{"id": id, "object": "video", "status": "result_expired", "error": map[string]string{"message": "原结果已清理，此编号不会自动重发；请查看主站记录。"}})
		return
	}
	task, err := service.CreateVideoTask(service.VideoTaskCreateInput{UserID: user.ID, UserDisplayName: user.DisplayName, Model: modelName, ChannelID: channel.ID, ChannelName: channel.Name, Source: readVideoTaskSource(r), SourceID: readVideoTaskSourceID(r), ClientTaskID: id, Status: "submission_unknown", Seconds: readStringPath(input, "duration"), Size: readStringPath(input, "resolution"), RequestBody: summarizeAIRequest(body, "application/json")})
	if err != nil {
		Fail(w, "任务保存失败，请勿重复提交")
		return
	}
	release, err := service.AcquireMeteorGeneration(r.Context())
	if err != nil {
		OK(w, service.VideoTaskResponse(task))
		return
	}
	defer release()
	// Once sent, an unknown response must remain unknown rather than resubmit.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, channel.BaseURL+"/v1/videos/generations", bytes.NewReader(body))
	if err != nil {
		Fail(w, "请求创建失败")
		return
	}
	request.Header.Set("Content-Type", "application/json")
	service.SetModelChannelAuthHeader(request, channel)
	payload, status, err := doAIRequest(request, channel)
	if err != nil {
		task.ErrorDetail = "无法确认上游是否接受原请求，已保留任务且不会自动重发，请检查主站记录。"
		_, _ = repository.SaveVideoTask(task)
		OK(w, service.VideoTaskResponse(task))
		return
	}
	if status >= 400 {
		task.Status = "failed"
		task.Error = service.MeteorRedact(readUpstreamAIErrorMessage(payload, status))
		task.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
		_, _ = repository.SaveVideoTask(task)
		OK(w, service.VideoTaskResponse(task))
		return
	}
	parsed := parseVideoTaskPayload(payload, modelName)
	task.UpstreamTaskID = parsed.UpstreamTaskID
	task.UpstreamVideoID = parsed.UpstreamVideoID
	if task.UpstreamTaskID == "" && task.UpstreamVideoID == "" {
		task.ErrorDetail = "上游未返回任务编号，状态未确认，不会自动重发。"
		_, _ = repository.SaveVideoTask(task)
		OK(w, service.VideoTaskResponse(task))
		return
	}
	task.Status = firstNonEmpty(parsed.Status, "pending")
	task.Progress = parsed.Progress
	task.Error = parsed.Error
	task.ErrorDetail = parsed.ErrorDetail
	if service.IsCompletedVideoTaskStatus(task.Status) {
		task.VideoURL = "/v1/videos/" + url.PathEscape(task.UpstreamTaskID) + "/content"
		task.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, _ = repository.SaveVideoTask(task)
	service.WakeVideoTaskPoller()
	OK(w, service.VideoTaskResponse(task))
}

func meteorVideoReference(value any) bool {
	if entries, ok := value.([]any); ok {
		for _, entry := range entries {
			if meteorVideoReference(entry) {
				return true
			}
		}
		return false
	}
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return false
	}
	if prefix, rest, ok := strings.Cut(text, ":"); ok {
		switch strings.ToLower(prefix) {
		case "video":
			return strings.TrimSpace(rest) != ""
		case "image", "audio":
			return false
		case "reference", "start", "end":
			text = strings.TrimSpace(rest)
		}
	}
	parsed, err := url.Parse(text)
	if err != nil {
		return false
	}
	name := firstNonEmpty(parsed.Query().Get("name"), parsed.Query().Get("filename"), parsed.Path)
	switch strings.ToLower(path.Ext(name)) {
	case ".mp4", ".mov", ".webm", ".m4v":
		return true
	}
	return false
}

func meteorPollVideo(ctx context.Context, task model.VideoTask) (service.VideoTaskPollUpdate, error) {
	id := firstNonEmpty(task.UpstreamTaskID, task.UpstreamVideoID)
	if id == "" {
		return service.VideoTaskPollUpdate{Status: task.Status}, nil
	}
	channel, err := service.MeteorSelectChannel(task.UserID, task.Model, task.ChannelID)
	if err != nil {
		return service.VideoTaskPollUpdate{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, channel.BaseURL+"/v1/videos/generations/"+url.PathEscape(id), nil)
	if err != nil {
		return service.VideoTaskPollUpdate{}, err
	}
	service.SetModelChannelAuthHeader(request, channel)
	payload, status, err := doAIRequest(request, channel)
	if err != nil {
		return service.VideoTaskPollUpdate{}, err
	}
	if status >= 400 {
		return service.VideoTaskPollUpdate{Status: task.Status, ErrorDetail: fmt.Sprintf("状态查询暂不可用（%d），不会重发原请求", status)}, nil
	}
	parsed := parseVideoTaskPayload(payload, task.Model)
	result := service.VideoTaskPollUpdate{Status: firstNonEmpty(parsed.Status, task.Status), Progress: parsed.Progress, Seconds: parsed.Seconds, Size: parsed.Size, Error: service.MeteorRedact(parsed.Error), ErrorDetail: service.MeteorRedact(parsed.ErrorDetail)}
	if service.IsCompletedVideoTaskStatus(result.Status) {
		result.VideoURL = "/v1/videos/" + url.PathEscape(id) + "/content"
	}
	return result, nil
}

func meteorVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	task, err := service.MeteorVideoForContent(r, id)
	if err != nil {
		FailWithStatus(w, 403, err.Error())
		return
	}
	if !service.IsCompletedVideoTaskStatus(task.Status) {
		FailWithStatus(w, 409, "视频尚未完成")
		return
	}
	channel, err := service.MeteorSelectChannel(task.UserID, task.Model, task.ChannelID)
	if err != nil {
		FailWithStatus(w, 401, service.ErrMeteorSession.Error())
		return
	}
	upstreamID := firstNonEmpty(task.UpstreamTaskID, task.UpstreamVideoID)
	if upstreamID == "" {
		FailWithStatus(w, 404, "视频任务不存在")
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, channel.BaseURL+"/v1/videos/"+url.PathEscape(upstreamID)+"/content", nil)
	if err != nil {
		Fail(w, "视频内容不可用")
		return
	}
	service.SetModelChannelAuthHeader(request, channel)
	request.Header.Set("Range", r.Header.Get("Range"))
	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		FailWithStatus(w, 502, "视频下载暂不可用")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 && response.StatusCode != 206 {
		FailWithStatus(w, response.StatusCode, "视频内容已过期或暂不可用")
		return
	}
	contentType := strings.ToLower(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if !strings.HasPrefix(contentType, "video/") {
		FailWithStatus(w, 502, "视频内容格式无效")
		return
	}
	for _, header := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if value := response.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=300")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 512<<20))
}
