package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func MeteorDownload(w http.ResponseWriter, r *http.Request) {
	var input service.MeteorDownloadInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2048))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		FailWithStatus(w, 400, "下载参数无效")
		return
	}
	target, err := service.MeteorDownloadURL(r.Context(), input)
	if err != nil {
		FailWithStatus(w, 403, err.Error())
		return
	}
	OK(w, map[string]string{"url": target})
}
