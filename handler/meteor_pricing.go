package handler

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func MeteorCapabilities(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !service.MeteorEnabled() || !ok {
		FailWithStatus(w, 403, "请先登录")
		return
	}
	value, err := service.MeteorMediaCapabilities(r.Context(), user.ID, r.URL.Query().Get("kind"), r.URL.Query().Get("channelId"), r.URL.Query().Get("model"))
	if err != nil {
		FailWithStatus(w, 400, "当前模型或渠道不可用")
		return
	}
	OK(w, value)
}
func MeteorQuote(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !service.MeteorEnabled() || !ok {
		FailWithStatus(w, 403, "请先登录")
		return
	}
	var input service.MeteorQuoteInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		FailWithStatus(w, 400, "计价参数无效")
		return
	}
	value, err := service.MeteorMediaQuote(r.Context(), user.ID, input)
	if err != nil {
		FailWithStatus(w, 400, err.Error())
		return
	}
	OK(w, value)
}
