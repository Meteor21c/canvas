package handler

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

// StorageConfig 返回公开存储配置。
func StorageConfig(w http.ResponseWriter, r *http.Request) {
	config, err := service.PublicStorageConfig()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

// SaveUserStorageProvider 保存用户配置的存储提供商。
func SaveUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.UserStorageProviders `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	config, err := service.SaveCurrentUserStorageProvider(r.Context(), request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

// MeasureUserStorageProvider 统计用户存储提供商的已用容量。
func MeasureUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.StorageObjectProviderInput `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.MeasureUserStorageProvider(r.Context(), request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// UploadFile 上传文件到对象存储。
func UploadFile(w http.ResponseWriter, r *http.Request) {
	if service.MeteorEnabled() {
		meteorUploadFile(w, r)
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请选择要上传的文件")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, service.MeteorMaxFileBytes+1))
	if err != nil {
		FailError(w, err)
		return
	}
	contentType := header.Header.Get("Content-Type")
	if strings.TrimSpace(contentType) == "" {
		contentType = http.DetectContentType(data)
	}
	var provider *service.StorageObjectProviderInput
	if raw := strings.TrimSpace(r.FormValue("provider")); raw != "" {
		var parsed service.StorageObjectProviderInput
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			Fail(w, "用户对象存储配置格式错误")
			return
		}
		provider = &parsed
	}
	object, err := service.UploadStorageObjectWithProvider(r.Context(), header.Filename, contentType, data, provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// RegisterDirectFile 登记浏览器已直传至用户 WebDAV 的文件。
func RegisterDirectFile(w http.ResponseWriter, r *http.Request) {
	var request service.DirectStorageObjectInput
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "文件信息格式错误")
		return
	}
	object, err := service.RegisterDirectStorageObject(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// DeleteFile 删除文件。
func DeleteFile(w http.ResponseWriter, r *http.Request, id string) {
	var request struct {
		Provider *service.StorageObjectProviderInput `json:"provider"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&request)
	}
	if err := service.DeleteStorageObject(r.Context(), id, request.Provider); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

// DeleteDirectFileRecord 删除浏览器已直接删除的 WebDAV 文件索引。
func DeleteDirectFileRecord(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteDirectStorageObjectRecord(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

// FileContent 获取文件内容。
func FileContent(w http.ResponseWriter, r *http.Request, id string) {
	if service.MeteorEnabled() && !service.MeteorOwnsObject(r.Context(), id) && !service.MeteorAuthorizeMedia(r) {
		FailWithStatus(w, http.StatusForbidden, "素材不存在")
		return
	}
	download, err := service.DownloadStorageObject(id, r.Header.Get("Range"))
	if err != nil {
		FailError(w, err)
		return
	}
	defer download.Stream.Close()
	w.Header().Set("Content-Type", download.Object.MimeType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if service.MeteorEnabled() {
		w.Header().Set("Cache-Control", "private, max-age=300")
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	if download.AcceptRanges {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	if download.ContentRange != "" {
		w.Header().Set("Content-Range", download.ContentRange)
	}
	if download.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(download.ContentLength, 10))
	}
	if download.StatusCode != 0 {
		service.SetMeteorDownloadHeaders(w, r)
		w.WriteHeader(download.StatusCode)
	}
	_, _ = io.Copy(w, download.Stream)
}

// FileInfo 获取文件元数据。
func FileInfo(w http.ResponseWriter, r *http.Request, id string) {
	if service.MeteorEnabled() && !service.MeteorOwnsObject(r.Context(), id) {
		FailWithStatus(w, http.StatusForbidden, "素材不存在")
		return
	}
	object, err := service.StorageObjectInfo(id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// AdminMeasureStorageProvider 管理员统计存储容量。
func AdminMeasureStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Index    int                    `json:"index"`
		Provider *model.StorageProvider `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.MeasureAdminStorageProvider(request.Index, request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// Bound this optional remote-image adapter independently from model execution.
var meteorImageProxySlots = make(chan struct{}, 2)

// ProxyImage 代理图片请求（解决跨域和机器人检测问题）。
func ProxyImage(w http.ResponseWriter, r *http.Request) {
	if service.MeteorEnabled() {
		select {
		case meteorImageProxySlots <- struct{}{}:
			defer func() { <-meteorImageProxySlots }()
		default:
			FailWithStatus(w, http.StatusTooManyRequests, "图片读取繁忙，请稍后再试")
			return
		}
	}
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		Fail(w, "url 参数不能为空")
		return
	}
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		Fail(w, "无效的 url")
		return
	}
	// The safe client resolves and pins public IPs at dial time and applies the
	// same checks to every redirect. No caller credentials are forwarded.
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		Fail(w, "无效的图片地址")
		return
	}
	req.Header.Set("User-Agent", "MeteorCanvas/0.8.2")
	req.Header.Set("Accept", "image/avif,image/webp,image/png,image/jpeg,image/gif")
	resp, err := service.SafeProxyHTTPClient().Do(req)
	if err != nil {
		FailWithStatus(w, http.StatusBadGateway, "代理图片请求失败")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		FailWithStatus(w, http.StatusBadGateway, "代理图片请求失败")
		return
	}
	contentType, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	contentType = strings.ToLower(contentType)
	isImage := strings.HasPrefix(contentType, "image/")
	if service.MeteorEnabled() {
		switch contentType {
		case "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif":
		default:
			FailWithStatus(w, http.StatusBadGateway, "仅允许安全的图片响应")
			return
		}
	}
	var data []byte
	if isImage {
		const limit = 32 << 20
		if resp.ContentLength > limit {
			FailWithStatus(w, http.StatusBadGateway, "图片过大")
			return
		}
		data, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err != nil || len(data) == 0 || len(data) > limit {
			FailWithStatus(w, http.StatusBadGateway, "图片为空、过大或读取失败")
			return
		}
		if service.MeteorEnabled() {
			sniffed := http.DetectContentType(data)
			// Some AVIF decoders report octet-stream; its ISO BMFF signature
			// must still be present. Executable/XML/HTML responses are refused.
			avif := contentType == "image/avif" && len(data) >= 12 && string(data[4:8]) == "ftyp" && (string(data[8:12]) == "avif" || string(data[8:12]) == "avis")
			if !strings.HasPrefix(sniffed, "image/") && !avif || strings.Contains(sniffed, "svg") {
				FailWithStatus(w, http.StatusBadGateway, "图片内容与格式不符")
				return
			}
		}
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if service.MeteorEnabled() {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=86400")
	}
	w.WriteHeader(resp.StatusCode)
	if isImage {
		_, _ = w.Write(data)
		return
	}
	_, _ = io.Copy(w, resp.Body)
}
