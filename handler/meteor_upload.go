package handler

import (
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/tigerowo/infinite-canvas/service"
)

// Streaming multipart avoids FormFile's 32MiB memory buffer and io.ReadAll.
func meteorUploadFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, service.MeteorVideoMaxBytes+(1<<20))
	parts, err := r.MultipartReader()
	if err != nil {
		FailWithStatus(w, 400, "请选择要上传的文件")
		return
	}
	var uploaded *service.UploadedStorageObject
	fail := func(message string) {
		if uploaded != nil {
			_ = service.DeleteStorageObject(r.Context(), uploaded.ID, nil)
		}
		FailWithStatus(w, 400, message)
	}
	for count := 0; ; count++ {
		part, e := parts.NextPart()
		if errors.Is(e, io.EOF) {
			break
		}
		if e != nil {
			fail("上传内容无效或超过本站大小额度")
			return
		}
		if count >= 8 {
			_ = part.Close()
			fail("上传字段过多")
			return
		}
		if part.FormName() == "file" && part.FileName() != "" {
			if uploaded != nil {
				_ = part.Close()
				fail("每次只能上传一个素材")
				return
			}
			object, e := service.MeteorUploadStream(r.Context(), part.FileName(), part.Header.Get("Content-Type"), part)
			_ = part.Close()
			if e != nil {
				fail(e.Error())
				return
			}
			uploaded = &object
			continue
		}
		data, e := io.ReadAll(io.LimitReader(part, 8193))
		_ = part.Close()
		if e != nil || len(data) > 8192 {
			fail("上传字段过长")
			return
		}
		if part.FormName() == "provider" && strings.TrimSpace(string(data)) != "" && strings.TrimSpace(string(data)) != "null" {
			fail("自定义对象存储暂不开放")
			return
		}
	}
	if uploaded == nil {
		FailWithStatus(w, 400, "请选择要上传的文件")
		return
	}
	OK(w, *uploaded)
}
