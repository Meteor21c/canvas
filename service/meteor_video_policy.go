package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// These byte budgets protect this site's memory/disk; they are not provider limits.
const (
	MeteorImageMaxBytes     int64 = 20 << 20
	MeteorVideoMaxBytes     int64 = 50 << 20
	MeteorAudioMaxBytes     int64 = 20 << 20
	MeteorReferenceMaxBytes int64 = 100 << 20
)

type MeteorUploadPolicy struct {
	ImageMaxBytes          int64  `json:"imageMaxBytes"`
	VideoMaxBytes          int64  `json:"videoMaxBytes"`
	AudioMaxBytes          int64  `json:"audioMaxBytes"`
	TotalReferenceMaxBytes int64  `json:"totalReferenceMaxBytes"`
	PolicySource           string `json:"policySource"`
	MetadataRequired       bool   `json:"metadataRequired"`
}
type MeteorReferenceLimits struct {
	Images int `json:"images"`
	Videos int `json:"videos"`
	Audios int `json:"audios"`
	Total  int `json:"total"`
}
type MeteorVideoInputPolicy struct {
	Modes                            []string              `json:"modes"`
	ReferenceTypes                   []string              `json:"referenceTypes"`
	FirstFrame                       bool                  `json:"firstFrame"`
	LastFrame                        bool                  `json:"lastFrame"`
	LastFrameRequiresFirst           bool                  `json:"lastFrameRequiresFirst"`
	FramesWithReferences             bool                  `json:"framesWithReferences"`
	AudioOnlyReferences              bool                  `json:"audioOnlyReferences"`
	ReferenceVideoWithGeneratedAudio bool                  `json:"referenceVideoWithGeneratedAudio"`
	ReferenceDuration                *MeteorDuration       `json:"referenceDuration,omitempty"`
	ReferenceLimits                  MeteorReferenceLimits `json:"referenceLimits"`
	ValidationNotice                 string                `json:"validationNotice"`
}

func meteorUploadsPolicy() *MeteorUploadPolicy {
	return &MeteorUploadPolicy{ImageMaxBytes: MeteorImageMaxBytes, VideoMaxBytes: MeteorVideoMaxBytes, AudioMaxBytes: MeteorAudioMaxBytes, TotalReferenceMaxBytes: MeteorReferenceMaxBytes, PolicySource: "site", MetadataRequired: true}
}

func meteorVideoInputPolicy(modelName string) *MeteorVideoInputPolicy {
	p := &MeteorVideoInputPolicy{Modes: []string{"text", "frames"}, ReferenceTypes: []string{}, FirstFrame: true, LastFrame: true, LastFrameRequiresFirst: true, ReferenceVideoWithGeneratedAudio: true, ReferenceLimits: MeteorReferenceLimits{Total: 4}, ValidationNotice: "本站保护额度：单张图片20 MiB、单个视频50 MiB、单个音频20 MiB，单次素材总计100 MiB且最多4个。首尾帧与参考素材分开提交；暂不开放自动时长、样片及视频编辑模式。"}
	switch modelName {
	case "doubao-seedance-2.5":
		p.Modes = append(p.Modes, "reference")
		p.ReferenceTypes = []string{"image", "video", "audio"}
		p.ReferenceLimits = MeteorReferenceLimits{Images: 4, Videos: 4, Audios: 4, Total: 4}
		p.AudioOnlyReferences = true
		p.ReferenceDuration = &MeteorDuration{Min: 2, Max: 30}
	case "doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini":
		p.Modes = append(p.Modes, "reference")
		p.ReferenceTypes = []string{"image", "video", "audio"}
		p.ReferenceLimits = MeteorReferenceLimits{Images: 4, Videos: 3, Audios: 3, Total: 4}
		p.ReferenceDuration = &MeteorDuration{Min: 2, Max: 15}
	case "doubao-seedance-1.5-pro":
	case "kling-v3":
		p.LastFrameRequiresFirst = false
	case "kling-v3-omni":
		p.Modes = append(p.Modes, "reference")
		p.ReferenceTypes = []string{"image", "video"}
		p.ReferenceLimits = MeteorReferenceLimits{Images: 4, Videos: 4, Total: 4}
		p.ReferenceVideoWithGeneratedAudio = false
		p.LastFrameRequiresFirst = false
	default:
		// Native Grok remains governed by its existing adapter and price scenarios.
		return nil
	}
	return p
}

// MeteorVideoMaterials is parsed once from the canonical video request. URLs are
// replaced by owned, verified media URLs before a paid task may be claimed.
type MeteorVideoMaterials struct {
	Model       string
	Prompt      string
	AspectRatio string
	Audio       bool
	FirstFrame  string
	LastFrame   string
	References  []string
}

func MeteorValidateVideoInput(input MeteorVideoMaterials) error {
	p := meteorVideoInputPolicy(input.Model)
	if p == nil {
		return nil
	}
	if input.FirstFrame == "" && input.LastFrame == "" && len(input.References) == 0 && strings.TrimSpace(input.Prompt) == "" {
		return errors.New("文生视频需要填写提示词")
	}
	if input.LastFrame != "" && input.FirstFrame == "" && p.LastFrameRequiresFirst {
		return errors.New("当前模型尾帧需要同时提供首帧")
	}
	if (input.FirstFrame != "" || input.LastFrame != "") && len(input.References) > 0 && !p.FramesWithReferences {
		return errors.New("请选择首尾帧或参考素材其中一种输入方式，本站暂不支持混用")
	}
	if input.Model == "doubao-seedance-2.5" && input.FirstFrame != "" && input.AspectRatio != "" && input.AspectRatio != "adaptive" {
		return errors.New("当前模型首帧模式的画面比例须为adaptive")
	}

	if input.AspectRatio != "" {
		ratios := []string{"16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"}
		if strings.HasPrefix(input.Model, "kling-") {
			ratios = []string{"16:9", "9:16", "1:1"}
		}
		valid := false
		for _, ratio := range ratios {
			valid = valid || ratio == input.AspectRatio
		}
		if !valid {
			return errors.New("当前模型不支持所选画面比例")
		}
	}
	count := MeteorReferenceLimits{}
	for _, ref := range input.References {
		switch MeteorReferenceType(ref) {
		case "video":
			count.Videos++
		case "audio":
			count.Audios++
		default:
			count.Images++
		}
	}
	if count.Images > p.ReferenceLimits.Images || count.Videos > p.ReferenceLimits.Videos || count.Audios > p.ReferenceLimits.Audios {
		return fmt.Errorf("当前模型参考素材上限：图片%d、视频%d、音频%d个", p.ReferenceLimits.Images, p.ReferenceLimits.Videos, p.ReferenceLimits.Audios)
	}
	count.Total = count.Images + count.Videos + count.Audios
	if input.FirstFrame != "" {
		count.Total++
	}
	if input.LastFrame != "" {
		count.Total++
	}
	if count.Total > p.ReferenceLimits.Total {
		return errors.New("视频单次素材最多4个")
	}
	if count.Audios > 0 && count.Images+count.Videos == 0 && !p.AudioOnlyReferences {
		return errors.New("当前模型音频参考需要搭配图片或视频")
	}
	if count.Videos > 0 && input.Audio && !p.ReferenceVideoWithGeneratedAudio {
		return errors.New("当前模型使用参考视频时须关闭生成音频")
	}
	return nil
}

func MeteorReferenceType(value string) string {
	for _, kind := range []string{"video", "audio", "image"} {
		if strings.HasPrefix(strings.ToLower(value), kind+":") {
			return kind
		}
	}
	return "image"
}
func meteorReferenceValue(value string) string {
	for _, kind := range []string{"video", "audio", "image", "reference", "start", "end"} {
		if strings.HasPrefix(strings.ToLower(value), kind+":") {
			return strings.TrimSpace(value[len(kind)+1:])
		}
	}
	return strings.TrimSpace(value)
}

func MeteorPrepareVideoMaterials(ctx context.Context, input MeteorVideoMaterials) (MeteorVideoMaterials, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	if err := MeteorValidateVideoInput(input); err != nil {
		return input, err
	}
	var total int64
	prepare := func(value, kind string) (string, error) {
		if value == "" {
			return "", nil
		}
		object, err := MeteorResolveMaterial(ctx, meteorReferenceValue(value), kind)
		if err != nil {
			return "", err
		}
		total += object.Bytes
		if total > MeteorReferenceMaxBytes {
			return "", errors.New("单次参考素材总大小不能超过100 MiB")
		}
		if p := meteorVideoInputPolicy(input.Model); p != nil && p.ReferenceDuration != nil && (kind == "video" || kind == "audio") {
			if object.DurationSeconds < float64(p.ReferenceDuration.Min) || object.DurationSeconds > float64(p.ReferenceDuration.Max) {
				return "", fmt.Errorf("当前模型参考视频或音频时长须在%d到%d秒之间", p.ReferenceDuration.Min, p.ReferenceDuration.Max)
			}
		}
		return MeteorAbsoluteMediaURL(object.URL), nil
	}
	var err error
	if input.FirstFrame, err = prepare(input.FirstFrame, "image"); err != nil {
		return input, err
	}
	if input.LastFrame, err = prepare(input.LastFrame, "image"); err != nil {
		return input, err
	}
	for i, ref := range input.References {
		kind := MeteorReferenceType(ref)
		value, e := prepare(ref, kind)
		if e != nil {
			return input, e
		}
		if kind != "image" {
			value = kind + ":" + value
		}
		input.References[i] = value
	}
	return input, nil
}

func meteorVideoResolutionAllowed(modelName, value string) bool {
	if !meteorValidResolution(value) {
		return false
	}
	switch modelName {
	case "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini":
		return value == "480p" || value == "720p"
	case "doubao-seedance-1.5-pro", "doubao-seedance-2.5":
		return value == "480p" || value == "720p" || value == "1080p"
	}
	return true
}
