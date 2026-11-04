package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"time"
)

// Only accounting fields cross this boundary. Prompts, files and task IDs are
// intentionally absent, including when a main-server response adds fields.
type MeteorVideoCostRecord struct {
	CreatedAt         time.Time `json:"createdAt"`
	Resolution        string    `json:"resolution"`
	DurationSeconds   float64   `json:"durationSeconds"`
	DurationSource    string    `json:"durationSource"`
	Currency          string    `json:"currency"`
	AspectRatio       string    `json:"aspectRatio,omitempty"`
	InputImageCount   int       `json:"inputImageCount,omitempty"`
	InputVideoSeconds float64   `json:"inputVideoSeconds,omitempty"`
	Audio             *bool     `json:"audio,omitempty"`
	FrameRate         int       `json:"frameRate,omitempty"`
	SceneName         string    `json:"sceneName"`
	OutputTokens      int64     `json:"outputTokens"`
	ActualAmount      *string   `json:"actualAmount"`
	AveragePerSecond  *string   `json:"averagePerSecond"`
}

func MeteorVideoCostHistory(ctx context.Context, userID, channelID, modelName string) ([]MeteorVideoCostRecord, error) {
	channel, err := MeteorSelectChannel(userID, modelName, channelID)
	if err != nil {
		return nil, err
	}
	if channel.ModelCapabilities[modelName] != "video" {
		return nil, errors.New("当前模型未开放视频功能")
	}
	if meteorGrokVideo(modelName) {
		return []MeteorVideoCostRecord{}, nil
	}
	query := url.Values{"model": {modelName}, "history": {"true"}}
	var raw struct {
		History []struct {
			CreatedAt         time.Time       `json:"created_at"`
			Resolution        string          `json:"resolution"`
			DurationSeconds   float64         `json:"duration_seconds"`
			DurationSource    string          `json:"duration_source"`
			Currency          string          `json:"currency"`
			AspectRatio       string          `json:"aspect_ratio"`
			InputImageCount   int             `json:"input_image_count"`
			InputVideoSeconds float64         `json:"input_video_seconds"`
			Audio             *bool           `json:"audio"`
			FrameRate         int             `json:"frame_rate"`
			SceneName         string          `json:"scene_name"`
			OutputTokens      int64           `json:"output_tokens"`
			ActualAmount      json.RawMessage `json:"actual_amount"`
			AveragePerSecond  json.RawMessage `json:"average_per_second"`
		} `json:"history"`
	}
	if meteorRawMain(ctx, channel, "/v1/videos/pricing?"+query.Encode(), &raw) != nil {
		return nil, errors.New("费用记录暂不可用，请稍后重试")
	}
	result := []MeteorVideoCostRecord{}
	for _, row := range raw.History {
		if len(result) >= 20 {
			break
		}
		amount := meteorDecimal(row.ActualAmount)
		if amount == nil || row.CreatedAt.IsZero() || row.DurationSeconds < 0 || row.DurationSeconds > 86400 || math.IsNaN(row.DurationSeconds) || math.IsInf(row.DurationSeconds, 0) || row.OutputTokens < 0 || (row.Currency != "CNY" && row.Currency != "USD") {
			continue
		}
		if row.DurationSource != "actual" && row.DurationSource != "requested" {
			row.DurationSource = "unknown"
			row.DurationSeconds = 0
		}
		if row.SceneName != "无视频参考" && row.SceneName != "含视频参考" && row.SceneName != "视频增强" {
			row.SceneName = "视频生成"
		}
		if !meteorVideoResolutionAllowed(modelName, row.Resolution) {
			row.Resolution = ""
		}
		switch row.AspectRatio {
		case "16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive":
		default:
			row.AspectRatio = ""
		}
		if row.FrameRate != 30 && row.FrameRate != 60 && row.FrameRate != 120 {
			row.FrameRate = 0
		}
		if row.InputImageCount < 0 || row.InputImageCount > 10 {
			row.InputImageCount = 0
		}
		if row.InputVideoSeconds < 0 || row.InputVideoSeconds > 86400 || math.IsNaN(row.InputVideoSeconds) || math.IsInf(row.InputVideoSeconds, 0) {
			row.InputVideoSeconds = 0
		}
		average := meteorDecimal(row.AveragePerSecond)
		if row.DurationSeconds <= 0 {
			average = nil
		}
		result = append(result, MeteorVideoCostRecord{CreatedAt: row.CreatedAt, Resolution: row.Resolution, DurationSeconds: row.DurationSeconds, DurationSource: row.DurationSource, Currency: row.Currency, AspectRatio: row.AspectRatio, InputImageCount: row.InputImageCount, InputVideoSeconds: row.InputVideoSeconds, Audio: row.Audio, FrameRate: row.FrameRate, SceneName: row.SceneName, OutputTokens: row.OutputTokens, ActualAmount: amount, AveragePerSecond: average})
	}
	return result, nil
}
