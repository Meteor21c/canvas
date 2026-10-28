package service

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

var meteorUploadSlots = make(chan struct{}, 2)
var meteorProbeSlots = make(chan struct{}, 2)

type meteorMediaMetadata struct {
	Width, Height int
	Duration      float64
}

func meteorMediaKind(mediaType string) string { kind, _, _ := strings.Cut(mediaType, "/"); return kind }
func meteorMediaLimit(mediaType string) int64 {
	switch meteorMediaKind(mediaType) {
	case "image":
		return MeteorImageMaxBytes
	case "video":
		return MeteorVideoMaxBytes
	case "audio":
		return MeteorAudioMaxBytes
	}
	return 0
}

type meteorContextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r meteorContextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.r.Read(p)
	}
}

// MeteorUploadStream never buffers the complete file, including multipart and
// remote imports. Only two uploads/probes may run simultaneously on this site.
func MeteorUploadStream(ctx context.Context, filename, contentType string, source io.Reader) (UploadedStorageObject, error) {
	return meteorUploadStream(ctx, filename, contentType, source, 0)
}
func meteorUploadStream(ctx context.Context, filename, contentType string, source io.Reader, resultLimit int64) (UploadedStorageObject, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return UploadedStorageObject{}, ErrMeteorSession
	}
	select {
	case meteorUploadSlots <- struct{}{}:
		defer func() { <-meteorUploadSlots }()
	default:
		return UploadedStorageObject{}, errors.New("素材上传繁忙，请稍后重试")
	}
	if err := os.MkdirAll(meteorMediaRoot(), 0700); err != nil {
		return UploadedStorageObject{}, errors.New("素材存储暂不可用")
	}
	file, err := os.CreateTemp(meteorMediaRoot(), "upload-")
	if err != nil {
		return UploadedStorageObject{}, errors.New("素材存储暂不可用")
	}
	tempPath := file.Name()
	defer os.Remove(tempPath)
	defer file.Close()
	_ = file.Chmod(0600)
	reader := bufio.NewReaderSize(meteorContextReader{ctx: ctx, r: source}, 512)
	prefix, peekErr := reader.Peek(512)
	if peekErr != nil && !errors.Is(peekErr, io.EOF) && !errors.Is(peekErr, bufio.ErrBufferFull) {
		return UploadedStorageObject{}, errors.New("读取素材失败")
	}
	mediaType, _, _ := mime.ParseMediaType(strings.ToLower(contentType))
	detected := http.DetectContentType(prefix)
	if mediaType == "" || mediaType == "application/octet-stream" {
		mediaType = detected
	}
	if mediaType == "audio/wave" {
		mediaType = "audio/wav"
	}
	if !meteorSafeMediaType(mediaType, detected, prefix) {
		return UploadedStorageObject{}, errors.New("文件格式无效；只支持常见图片、视频和音频，不支持HTML或SVG")
	}
	limit := meteorMediaLimit(mediaType)
	if resultLimit > 0 {
		limit = resultLimit
	}
	if limit <= 0 {
		return UploadedStorageObject{}, errors.New("不支持的素材格式")
	}
	hash := sha256.New()
	count, err := io.CopyBuffer(io.MultiWriter(file, hash), io.LimitReader(reader, limit+1), make([]byte, 64<<10))
	if err != nil {
		return UploadedStorageObject{}, errors.New("读取素材失败")
	}
	if count == 0 || count > limit {
		return UploadedStorageObject{}, fmt.Errorf("本站%s素材保护额度为%d MiB", map[string]string{"image": "图片", "video": "视频", "audio": "音频"}[meteorMediaKind(mediaType)], limit>>20)
	}
	if err = file.Close(); err != nil {
		return UploadedStorageObject{}, errors.New("素材保存失败")
	}
	metadata, err := meteorProbeMedia(ctx, tempPath, mediaType)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	meteorMediaMu.Lock()
	defer meteorMediaMu.Unlock()
	db, err := repository.DB()
	if err != nil {
		return UploadedStorageObject{}, errors.New("素材存储暂不可用")
	}
	var total, owner, ownerCount int64
	if err = db.Model(&model.StorageObject{}).Where("provider_id = ?", "meteor-local").Select("COALESCE(SUM(bytes),0)").Scan(&total).Error; err != nil {
		return UploadedStorageObject{}, errors.New("素材存储暂不可用")
	}
	if err = db.Model(&model.StorageObject{}).Where("provider_id = ? AND created_by = ?", "meteor-local", user.ID).Select("COALESCE(SUM(bytes),0)").Scan(&owner).Error; err != nil {
		return UploadedStorageObject{}, errors.New("素材存储暂不可用")
	}
	if err = db.Model(&model.StorageObject{}).Where("provider_id = ? AND created_by = ?", "meteor-local", user.ID).Count(&ownerCount).Error; err != nil {
		return UploadedStorageObject{}, errors.New("素材存储暂不可用")
	}
	if ownerCount >= meteorMediaOwnerMaxFiles {
		return UploadedStorageObject{}, errors.New("最多保留256个临时素材，请等待清理或删除旧素材")
	}
	if total+count > meteorMediaGlobalBytes || owner+count > meteorMediaOwnerBytes {
		return UploadedStorageObject{}, errors.New("临时素材额度已满，请等待清理或删除旧素材")
	}
	id := uuid.NewString()
	target := filepath.Join(meteorMediaRoot(), id)
	if err = os.Rename(tempPath, target); err != nil {
		return UploadedStorageObject{}, errors.New("素材保存失败")
	}
	object := model.StorageObject{ID: id, ProviderID: "meteor-local", ObjectKey: id, MimeType: mediaType, Bytes: count, SHA256: hex.EncodeToString(hash.Sum(nil)), CreatedBy: user.ID, CreatedAt: now(), Width: metadata.Width, Height: metadata.Height, DurationSeconds: metadata.Duration, MetadataVerified: true}
	if _, err = repository.SaveStorageObject(object); err != nil {
		_ = os.Remove(target)
		return UploadedStorageObject{}, errors.New("素材存储暂不可用")
	}
	return meteorUploadedObject(object), nil
}

func meteorUploadedObject(object model.StorageObject) UploadedStorageObject {
	return UploadedStorageObject{ID: object.ID, StorageKey: "server:" + object.ID, URL: MeteorMediaURL(object.ID), Bytes: object.Bytes, MimeType: object.MimeType, ExpiresAt: MeteorExpiry(object.CreatedAt), Width: object.Width, Height: object.Height, DurationSeconds: object.DurationSeconds}
}

type meteorBoundedOutput struct {
	bytes.Buffer
	limit int
}

func (w *meteorBoundedOutput) Write(p []byte) (int, error) {
	if w.Len()+len(p) > w.limit {
		return 0, errors.New("metadata output too large")
	}
	return w.Buffer.Write(p)
}

// ffprobe accepts only local files/pipe, fixed arguments and bounded output.
// Untrusted URLs are never passed to it and each invocation has a deadline.
func meteorProbeMedia(ctx context.Context, filename, mediaType string) (meteorMediaMetadata, error) {
	metadata := meteorMediaMetadata{}
	if meteorMediaKind(mediaType) == "image" {
		file, err := os.Open(filename)
		if err != nil {
			return metadata, errors.New("素材读取失败")
		}
		conf, _, decodeErr := image.DecodeConfig(file)
		_ = file.Close()
		if decodeErr == nil {
			metadata.Width, metadata.Height = conf.Width, conf.Height
			return metadata, meteorValidateDimensions(metadata)
		}
	}
	select {
	case meteorProbeSlots <- struct{}{}:
		defer func() { <-meteorProbeSlots }()
	default:
		return metadata, errors.New("素材校验繁忙，请稍后重试")
	}
	probeCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, "ffprobe", "-v", "error", "-max_alloc", "16777216", "-threads", "1", "-protocol_whitelist", "file,pipe", "-probesize", "4194304", "-analyzeduration", "5000000", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", filename)
	output := &meteorBoundedOutput{limit: 64 << 10}
	cmd.Stdout = output
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		return metadata, errors.New("素材无法解析；请检查文件格式或稍后重试")
	}
	var result struct {
		Streams []struct {
			Type     string `json:"codec_type"`
			Width    int    `json:"width"`
			Height   int    `json:"height"`
			Duration string `json:"duration"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if json.Unmarshal(output.Bytes(), &result) != nil {
		return metadata, errors.New("素材元数据无效")
	}
	kind := meteorMediaKind(mediaType)
	hasVideo, hasAudio := false, false
	for _, stream := range result.Streams {
		if stream.Type == "video" {
			hasVideo = true
			metadata.Width = max(metadata.Width, stream.Width)
			metadata.Height = max(metadata.Height, stream.Height)
		}
		if stream.Type == "audio" {
			hasAudio = true
		}
		duration, _ := strconv.ParseFloat(stream.Duration, 64)
		metadata.Duration = max(metadata.Duration, duration)
	}
	duration, _ := strconv.ParseFloat(result.Format.Duration, 64)
	metadata.Duration = max(metadata.Duration, duration)
	if (kind == "image" || kind == "video") && !hasVideo || kind == "audio" && (!hasAudio || hasVideo) {
		return metadata, errors.New("素材真实类型与声明不符")
	}
	if kind != "image" && (metadata.Duration <= 0 || metadata.Duration > 300 || math.IsNaN(metadata.Duration) || math.IsInf(metadata.Duration, 0)) {
		return metadata, errors.New("音视频时长无法读取或超过本站300秒保护额度")
	}
	if kind != "audio" {
		if err := meteorValidateDimensions(metadata); err != nil {
			return metadata, err
		}
	}
	return metadata, nil
}
func meteorValidateDimensions(m meteorMediaMetadata) error {
	if m.Width <= 0 || m.Height <= 0 || m.Width > 8192 || m.Height > 8192 || int64(m.Width)*int64(m.Height) > 40_000_000 {
		return errors.New("素材尺寸无效或超过本站8192边长/4000万像素保护额度")
	}
	return nil
}

func MeteorAbsoluteMediaURL(value string) string {
	if strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://") {
		return value
	}
	base := strings.TrimRight(config.Cfg.MeteorPublicBase, "/")
	if base == "" {
		base = "https://api.meteor21c.fun"
	}
	return base + "/" + strings.TrimLeft(value, "/")
}

// Owned objects are renewed in place; other HTTP/data inputs are imported with
// the same streaming/signature/metadata/quota checks as a browser upload.
func MeteorResolveMaterial(ctx context.Context, value, kind string) (UploadedStorageObject, error) {
	user, ok := UserFromContext(ctx)
	if !ok {
		return UploadedStorageObject{}, ErrMeteorSession
	}
	value = strings.TrimSpace(value)
	parsed, err := url.Parse(value)
	if err != nil || parsed.User != nil {
		return UploadedStorageObject{}, errors.New("素材地址无效")
	}
	mediaPath := strings.TrimPrefix(parsed.Path, "/studio")
	if strings.HasPrefix(mediaPath, "/api/files/") && strings.HasSuffix(mediaPath, "/content") {
		id := strings.TrimSuffix(strings.TrimPrefix(mediaPath, "/api/files/"), "/content")
		if _, err = uuid.Parse(id); err != nil {
			return UploadedStorageObject{}, errors.New("素材ID无效")
		}
		object, err := repository.GetStorageObject(id)
		if err != nil || object.CreatedBy != user.ID || object.ProviderID != "meteor-local" || object.ObjectKey != id {
			return UploadedStorageObject{}, errors.New("素材不存在或不属于当前用户")
		}
		created, e := time.Parse(time.RFC3339Nano, object.CreatedAt)
		if e != nil || !meteorRetainMedia(object, created, time.Now()) {
			return UploadedStorageObject{}, errors.New("素材已过期，请重新上传")
		}
		if object.Bytes <= 0 || object.Bytes > meteorMediaLimit(object.MimeType) || meteorMediaKind(object.MimeType) != kind {
			return UploadedStorageObject{}, errors.New("素材类型或大小不符合当前输入要求")
		}
		if !object.MetadataVerified {
			metadata, e := meteorProbeMedia(ctx, filepath.Join(meteorMediaRoot(), id), object.MimeType)
			if e != nil {
				return UploadedStorageObject{}, e
			}
			object.Width, object.Height, object.DurationSeconds, object.MetadataVerified = metadata.Width, metadata.Height, metadata.Duration, true
			if _, e = repository.SaveStorageObject(object); e != nil {
				return UploadedStorageObject{}, errors.New("素材校验保存失败")
			}
		}
		if _, err = os.Stat(filepath.Join(meteorMediaRoot(), id)); err != nil {
			return UploadedStorageObject{}, errors.New("素材已清理，请重新上传")
		}
		return meteorUploadedObject(object), nil
	}
	if parsed.Scheme == "data" {
		header, encoded, found := strings.Cut(value, ",")
		if !found || !strings.HasSuffix(header, ";base64") {
			return UploadedStorageObject{}, errors.New("素材数据格式无效")
		}
		mediaType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
		if meteorMediaKind(mediaType) != kind {
			return UploadedStorageObject{}, errors.New("素材类型与当前输入要求不符")
		}
		return MeteorUploadStream(ctx, "inline-material", mediaType, base64.NewDecoder(base64.StdEncoding, strings.NewReader(encoded)))
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return UploadedStorageObject{}, errors.New("请上传素材或使用可访问的HTTP/HTTPS地址")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, value, nil)
	if err != nil {
		return UploadedStorageObject{}, errors.New("素材地址无效")
	}
	response, err := SafeProxyHTTPClient().Do(req)
	if err != nil {
		return UploadedStorageObject{}, errors.New("素材下载失败，请通过本站重新上传")
	}
	defer response.Body.Close()
	mediaType, _, _ := mime.ParseMediaType(strings.ToLower(response.Header.Get("Content-Type")))
	if response.StatusCode != 200 || meteorMediaKind(mediaType) != kind || response.ContentLength > meteorMediaLimit(mediaType) {
		return UploadedStorageObject{}, errors.New("素材响应类型、状态或大小无效，请通过本站重新上传")
	}
	return MeteorUploadStream(ctx, "imported-material", mediaType, response.Body)
}
