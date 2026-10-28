package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/service"
)

// MeteorBoundary is installed before every original application route. The
// health endpoint alone is anonymous; original local auth/admin never applies.
func MeteorBoundary(c *gin.Context) {
	if !service.MeteorEnabled() {
		c.Next()
		return
	}
	path := c.Request.URL.Path
	if path == "/api/health" {
		c.Next()
		return
	}
	for _, prefix := range []string{"/api/admin", "/api/auth/register", "/api/auth/login", "/api/auth/linux-do", "/api/anonymous", "/api/bridge", "/api/ai/direct-request", "/api/ai/autodl", "/api/v1/workflow-providers", "/api/v1/comfy-bridges", "/api/v1/workflow-tasks", "/api/v1/storage/measure", "/api/v1/files/direct", "/api/v1/user-config/storage"} {
		if strings.HasPrefix(path, prefix) {
			handler.FailWithStatus(c.Writer, http.StatusForbidden, "此操作由流星 API 统一管理")
			c.Abort()
			return
		}
	}
	videoID := strings.TrimSuffix(strings.TrimPrefix(path, "/api/v1/videos/"), "/content")
	if (strings.HasPrefix(path, "/api/v1/videos/") && strings.HasSuffix(path, "/content") && service.MeteorAuthorizeVideo(c.Request, videoID)) || service.MeteorAuthorizeMedia(c.Request) {
		c.Next()
		return
	}
	parts := strings.SplitN(c.GetHeader("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		handler.FailWithStatus(c.Writer, http.StatusUnauthorized, "请先登录流星 API")
		c.Abort()
		return
	}
	user, err := service.MeteorAuthenticate(c.Request.Context(), strings.TrimSpace(parts[1]))
	if err != nil {
		handler.FailWithStatus(c.Writer, http.StatusUnauthorized, "请返回流星 API 登录有效账户后重试")
		c.Abort()
		return
	}
	c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), user))
	if c.Request.Body != nil {
		limit := int64(33 << 20)
		if path == "/api/v1/files" {
			limit = int64(service.MeteorMaxFileBytes + (1 << 20))
		}
		if c.Request.ContentLength > limit {
			handler.FailWithStatus(c.Writer, http.StatusRequestEntityTooLarge, "请求内容过大")
			c.Abort()
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Vary", "Authorization")
	c.Next()
}
