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
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, errors.New("视频请求必须是JSON")
	}
	if err := meteorValidateValues(input, 1); err != nil {
		return nil, err
	}
	for _, field := range []string{"draft_task_id", "omni_reference_task_type", "content", "elements", "element_list", "video_list", "image_list"} {
		if value, ok := input[field]; ok && value != nil {
			return nil, errors.New("当前画布暂不支持此视频参数：" + field)
		}
	}
	if value, ok := input["draft"]; ok && value != false && value != nil {
		return nil, errors.New("当前画布暂不支持样片模式")
	}
	out := map[string]any{}
	for _, field := range []string{"model", "prompt", "resolution", "aspect_ratio", "mode", "audio"} {
		if value, ok := input[field]; ok && value != nil {
			out[field] = value
		}
	}
	textAlias := func(names ...string) (string, error) {
		result := ""
		for _, name := range names {
			value, ok := input[name]
			if !ok || value == nil {
				continue
			}
			text, ok := value.(string)
			if !ok {
				return "", errors.New("视频参数须为文本：" + name)
			}
			text = strings.TrimSpace(text)
			if text == "" {
				continue
			}
			if result != "" && result != text {
				return "", errors.New("视频输入参数重复且不一致：" + name)
			}
			result = text
		}
		return result, nil
	}
	var err error
	if out["model"], err = textAlias("model"); err != nil {
		return nil, err
	}
	if out["prompt"], err = textAlias("prompt"); err != nil {
		return nil, err
	}
	if out["resolution"], err = textAlias("resolution", "resolution_name", "quality", "vquality"); err != nil {
		return nil, err
	}
	if out["resolution"] == "" {
		out["resolution"] = "720p"
	}
	if out["aspect_ratio"], err = textAlias("aspect_ratio", "ratio"); err != nil {
		return nil, err
	}
	if out["aspect_ratio"] == "" {
		if size := readStringPath(input, "size"); strings.Contains(size, ":") {
			out["aspect_ratio"] = size
		}
	}

	if input["duration"] != nil && input["seconds"] != nil {
		left, e1 := strconv.ParseFloat(toMeteorString(input["duration"]), 64)
		right, e2 := strconv.ParseFloat(toMeteorString(input["seconds"]), 64)
		if e1 != nil || e2 != nil || left != right {
			return nil, errors.New("视频时长参数重复且不一致")
		}
	}
	durationValue := input["duration"]
	if durationValue == nil {
		durationValue = input["seconds"]
	}
	if durationValue == nil {
		durationValue = 5
	}
	duration, err := strconv.ParseFloat(toMeteorString(durationValue), 64)
	if err != nil || duration != float64(int(duration)) {
		return nil, errors.New("视频时长须为整数秒")
	}
	out["duration"] = int(duration)

	if input["audio"] != nil && input["generate_audio"] != nil {
		left, ok1 := input["audio"].(bool)
		right, ok2 := input["generate_audio"].(bool)
		if !ok1 || !ok2 || left != right {
			return nil, errors.New("生成音频参数重复且不一致")
		}
	}
	audio := out["audio"]
	if audio == nil {
		audio = input["generate_audio"]
	}
	if audio == nil {
		audio = false
	}
	if _, ok := audio.(bool); !ok {
		return nil, errors.New("视频音频参数无效")
	}
	out["audio"] = audio
	first, err := textAlias("start_image_url", "first_frame", "first_frame_url")
	if err != nil {
		return nil, err
	}
	last, err := textAlias("end_image_url", "last_frame", "last_frame_url")
	if err != nil {
		return nil, err
	}
	refs := []string{}
	appendRefs := func(value any, prefix string) error {
		if value == nil {
			return nil
		}
		if single, ok := value.(string); ok {
			if strings.TrimSpace(single) == "" {
				return nil
			}
			value = []any{single}
		}
		values, ok := value.([]any)
		if !ok {
			return errors.New("参考素材参数须为地址列表")
		}
		for _, item := range values {
			if entry, ok := item.(map[string]any); ok {
				item = entry["url"]
				if item == nil {
					item = entry["image_url"]
				}
				if nested, ok := item.(map[string]any); ok {
					item = nested["url"]
				}
			}
			text, ok := item.(string)
			if !ok || strings.TrimSpace(text) == "" {
				return errors.New("参考素材地址无效，不会自动忽略")
			}
			text = strings.TrimSpace(text)
			if prefix != "" {
				if strings.HasPrefix(strings.ToLower(text), prefix) {
					text = text[len(prefix):]
				}
				if kind := service.MeteorReferenceType(text); kind != "image" {
					return errors.New("参考素材类型与字段不一致")
				}
			}
			refs = append(refs, prefix+text)
		}
		return nil
	}
	for _, field := range []string{"reference_images", "references", "input_reference[]", "input_reference", "images"} {
		if err = appendRefs(input[field], ""); err != nil {
			return nil, err
		}
	}
	for _, field := range []string{"reference_videos", "video_reference[]"} {
		if err = appendRefs(input[field], "video:"); err != nil {
			return nil, err
		}
	}
	for _, field := range []string{"reference_audios", "audio_reference[]"} {
		if err = appendRefs(input[field], "audio:"); err != nil {
			return nil, err
		}
	}
	if len(refs)+meteorReferenceCount(first)+meteorReferenceCount(last) > 4 {
		return nil, errors.New("视频参考素材最多4个")
	}
	if readStringPath(out, "model") == "doubao-seedance-2.5" && first != "" && out["aspect_ratio"] == "" {
		out["aspect_ratio"] = "adaptive"
	}
	materials := service.MeteorVideoMaterials{Model: readStringPath(out, "model"), Prompt: readStringPath(out, "prompt"), AspectRatio: readStringPath(out, "aspect_ratio"), Audio: audio.(bool), FirstFrame: first, LastFrame: last, References: refs}
	if err = service.MeteorValidateVideoInput(materials); err != nil {
		return nil, err
	}
	if len(refs) > 0 {
		out["reference_images"] = refs
	}
	if first != "" {
		out["start_image_url"] = first
	}
	if last != "" {
		out["end_image_url"] = last
	}
	out["watermark"] = false
	return json.Marshal(out)
}

func meteorPrepareVideoBody(ctx context.Context, input map[string]any) ([]byte, error) {
	refs := []string{}
	if values, ok := input["reference_images"].([]any); ok {
		for _, entry := range values {
			value, ok := entry.(string)
			if !ok {
				return nil, errors.New("参考素材地址无效")
			}
			refs = append(refs, value)
		}
	}
	audio, _ := input["audio"].(bool)
	materials, err := service.MeteorPrepareVideoMaterials(ctx, service.MeteorVideoMaterials{Model: readStringPath(input, "model"), Prompt: readStringPath(input, "prompt"), AspectRatio: readStringPath(input, "aspect_ratio"), Audio: audio, FirstFrame: readStringPath(input, "start_image_url"), LastFrame: readStringPath(input, "end_image_url"), References: refs})
	if err != nil {
		return nil, err
	}
	if len(materials.References) > 0 {
		input["reference_images"] = materials.References
	}
	if materials.FirstFrame != "" {
		input["start_image_url"] = materials.FirstFrame
	}
	if materials.LastFrame != "" {
		input["end_image_url"] = materials.LastFrame
	}
	return json.Marshal(input)
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
		FailWithStatus(w, 400, err.Error())
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
	body, err = meteorPrepareVideoBody(r.Context(), input)
	if err != nil {
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
	service.SetMeteorDownloadHeaders(w, r)
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 512<<20))
}
