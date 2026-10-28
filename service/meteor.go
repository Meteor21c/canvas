package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

var ErrMeteorSession = errors.New("请返回流星 API 重新登录后再继续，原任务不会自动重发")

type meteorSession struct {
	User          model.AuthUser
	Token         string
	VerifiedAt    time.Time
	ExpiresAt     time.Time
	CatalogAt     time.Time
	Channels      []model.ModelChannel
	ChannelGroups map[string]int64
}

var meteorSessions = struct {
	sync.Mutex
	byToken map[string]*meteorSession
	byUser  map[string]*meteorSession
}{byToken: map[string]*meteorSession{}, byUser: map[string]*meteorSession{}}

func MeteorEnabled() bool { return config.Cfg.MeteorMode }

func MeteorBaseURL() (string, error) {
	u, err := url.Parse(strings.TrimRight(config.Cfg.MeteorAPIBase, "/"))
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Hostname() != "host.docker.internal" && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && !(u.Hostname() == "sub2api" && u.Port() == "8080")) || u.Port() == "" {
		return "", errors.New("主站内部地址配置无效")
	}
	return u.String(), nil
}

var meteorHTTPTransport = &http.Transport{Proxy: nil, MaxIdleConns: 8, MaxIdleConnsPerHost: 4, MaxConnsPerHost: 4, IdleConnTimeout: 30 * time.Second}

func meteorClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: meteorHTTPTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func meteorGet(ctx context.Context, path, token string, result any) error {
	base, err := MeteorBaseURL()
	if err != nil {
		return err
	}
	if !strings.HasPrefix(path, "/api/v1/") && path != "/v1/models" {
		return errors.New("主站接口路径不允许")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return ErrMeteorSession
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := meteorClient(15 * time.Second).Do(req)
	if err != nil {
		return ErrMeteorSession
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return ErrMeteorSession
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return ErrMeteorSession
	}
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &envelope) != nil || envelope.Code != 0 || len(envelope.Data) == 0 {
		return ErrMeteorSession
	}
	if json.Unmarshal(envelope.Data, result) != nil {
		return ErrMeteorSession
	}
	return nil
}

func MeteorAuthenticate(ctx context.Context, token string) (model.AuthUser, error) {
	if token == "" || len(token) > 8192 {
		return model.AuthUser{}, ErrMeteorSession
	}
	hash := sha256.Sum256([]byte(token))
	key := hex.EncodeToString(hash[:])
	meteorSessions.Lock()
	cached := meteorSessions.byToken[key]
	if cached != nil && time.Since(cached.VerifiedAt) < 10*time.Second && time.Now().Before(cached.ExpiresAt) {
		user := cached.User
		meteorSessions.Unlock()
		return user, nil
	}
	meteorSessions.Unlock()
	var me struct {
		ID      int64   `json:"id"`
		Role    string  `json:"role"`
		Balance float64 `json:"balance"`
		Status  string  `json:"status"`
	}
	var access struct {
		Allowed bool `json:"allowed"`
	}
	if meteorGet(ctx, "/api/v1/auth/me", token, &me) != nil || me.ID <= 0 || me.Role != "admin" || me.Status != "active" || meteorGet(ctx, "/api/v1/canvas/access", token, &access) != nil || !access.Allowed {
		return model.AuthUser{}, ErrMeteorSession
	}
	id := "meteor_user_" + strconv.FormatInt(me.ID, 10)
	user, found, err := repository.GetUserByID(id)
	if err != nil {
		return model.AuthUser{}, ErrMeteorSession
	}
	if !found {
		user = model.User{ID: id, Username: id, DisplayName: "流星站主", Role: model.UserRoleUser, Status: model.UserStatusActive, AffCode: id, CreatedAt: now(), UpdatedAt: now()}
		if _, err = repository.SaveUser(user); err != nil {
			return model.AuthUser{}, ErrMeteorSession
		}
	}
	public := model.PublicUser(user)
	public.Role = model.UserRoleUser
	public.Credits = me.Balance
	expiry := time.Now().Add(15 * time.Minute)
	session := &meteorSession{User: public, Token: token, VerifiedAt: time.Now(), ExpiresAt: expiry}
	meteorSessions.Lock()
	if previous := meteorSessions.byUser[id]; previous != nil {
		session.Channels = previous.Channels
		session.CatalogAt = previous.CatalogAt
		session.ChannelGroups = previous.ChannelGroups
	}
	for oldKey, old := range meteorSessions.byToken {
		if time.Now().After(old.ExpiresAt) {
			delete(meteorSessions.byToken, oldKey)
		}
	}
	meteorSessions.byToken[key] = session
	meteorSessions.byUser[id] = session
	meteorSessions.Unlock()
	return public, nil
}

type meteorKey struct {
	ID        int64      `json:"id"`
	UserID    int64      `json:"user_id"`
	GroupID   int64      `json:"group_id"`
	Key       string     `json:"key"`
	Name      string     `json:"name"`
	Status    string     `json:"status"`
	ExpiresAt *time.Time `json:"expires_at"`
	Quota     float64    `json:"quota"`
	QuotaUsed float64    `json:"quota_used"`
}
type meteorGroup struct {
	ID               int64           `json:"id"`
	Name             string          `json:"name"`
	Platform         string          `json:"platform"`
	AllowImage       bool            `json:"allow_image_generation"`
	AllowVideo       bool            `json:"allow_video_generation"`
	VideoEnabled     bool            `json:"video_enabled"`
	VideoPrices      map[string]any  `json:"video_model_prices"`
	VideoPrice480p   json.RawMessage `json:"video_price_480p"`
	VideoPrice720p   json.RawMessage `json:"video_price_720p"`
	VideoPrice1080p  json.RawMessage `json:"video_price_1080p"`
	VideoPrice4K     json.RawMessage `json:"video_price_4k"`
	Rate             *float64        `json:"rate_multiplier"`
	VideoIndependent bool            `json:"video_rate_independent"`
	VideoRate        *float64        `json:"video_rate_multiplier"`
}

func MeteorChannels(userID string, force bool) ([]model.ModelChannel, error) {
	meteorSessions.Lock()
	session := meteorSessions.byUser[userID]
	if session == nil || time.Now().After(session.ExpiresAt) {
		meteorSessions.Unlock()
		return nil, ErrMeteorSession
	}
	if !force && time.Since(session.CatalogAt) < time.Minute {
		channels := append([]model.ModelChannel(nil), session.Channels...)
		meteorSessions.Unlock()
		return channels, nil
	}
	token := session.Token
	meteorSessions.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var groups []meteorGroup
	if err := meteorGet(ctx, "/api/v1/groups/available", token, &groups); err != nil {
		return nil, err
	}
	byID := map[int64]meteorGroup{}
	for _, group := range groups {
		byID[group.ID] = group
	}
	ownerID, _ := strconv.ParseInt(strings.TrimPrefix(userID, "meteor_user_"), 10, 64)
	base, err := MeteorBaseURL()
	if err != nil {
		return nil, err
	}
	channels := []model.ModelChannel{}
	channelGroups := map[string]int64{}
	for page := 1; page <= 10; page++ {
		var keys struct {
			Items []meteorKey `json:"items"`
			Total int         `json:"total"`
		}
		if err := meteorGet(ctx, fmt.Sprintf("/api/v1/keys?page=%d&page_size=100&status=active", page), token, &keys); err != nil {
			return nil, err
		}
		for _, key := range keys.Items {
			group, allowed := byID[key.GroupID]
			if !allowed || key.UserID != ownerID || key.Status != "active" || key.Key == "" || key.ExpiresAt != nil && time.Now().After(*key.ExpiresAt) || key.Quota > 0 && key.QuotaUsed >= key.Quota {
				continue
			}
			var models []struct {
				ID string `json:"id"`
			}
			if meteorGet(ctx, "/v1/models", key.Key, &models) != nil {
				continue
			}
			imageModels, textModels, videoModels, geminiModels := []string{}, []string{}, []string{}, []string{}
			for _, entry := range models {
				name := strings.TrimSpace(entry.ID)
				if name == "" {
					continue
				}
				lower := strings.ToLower(name)
				if group.Platform == "gemini" || strings.Contains(lower, "gemini") {
					if strings.Contains(lower, "veo") {
						if meteorGroupAllowsVideo(group) {
							videoModels = append(videoModels, name)
						}
					} else {
						geminiModels = append(geminiModels, name)
					}
					continue
				}
				if strings.Contains(lower, "video") || strings.Contains(lower, "seedance") || strings.Contains(lower, "kling") || strings.Contains(lower, "veo") || strings.Contains(lower, "sora") {
					if meteorGroupAllowsVideo(group) {
						videoModels = append(videoModels, name)
					}
					continue
				}
				if strings.Contains(lower, "image") || strings.Contains(lower, "seedream") || strings.Contains(lower, "banana") || strings.Contains(lower, "gemini") && group.AllowImage {
					if group.AllowImage {
						imageModels = append(imageModels, name)
					}
					if strings.Contains(lower, "gemini") {
						textModels = append(textModels, name)
					}
					continue
				}
				textModels = append(textModels, name)
			}
			id := "meteor-key-" + strconv.FormatInt(key.ID, 10)
			name := firstNonEmpty(key.Name, group.Name, "流星 API")
			makeChannel := func(suffix, protocol string, names []string, capability string) {
				if len(names) == 0 {
					return
				}
				caps := map[string]string{}
				for _, name := range names {
					caps[name] = capability
				}
				channelGroups[id+suffix] = group.ID
				channels = append(channels, model.ModelChannel{ID: id + suffix, Protocol: protocol, Name: name, BaseURL: base, APIKey: key.Key, Models: names, ModelCapabilities: caps, Weight: 1, Timeout: 600, Enabled: true})
			}
			makeChannel("", "openai", append(textModels, imageModels...), "")
			if len(channels) > 0 {
				last := &channels[len(channels)-1]
				if last.ID == id {
					for _, name := range textModels {
						last.ModelCapabilities[name] = "text"
					}
					for _, name := range imageModels {
						last.ModelCapabilities[name] = "image"
					}
				}
			}
			makeChannel("-video", "sub2api", videoModels, "video")
			makeChannel("-gemini", "gemini", geminiModels, "text")
		}
		if len(keys.Items) == 0 || page*100 >= keys.Total {
			break
		}
	}
	meteorSessions.Lock()
	if current := meteorSessions.byUser[userID]; current != nil {
		current.Channels = channels
		current.ChannelGroups = channelGroups
		current.CatalogAt = time.Now()
	}
	meteorSessions.Unlock()
	return append([]model.ModelChannel(nil), channels...), nil
}

func MeteorSelectChannel(userID, modelName, channelID string) (model.ModelChannel, error) {
	channels, err := MeteorChannels(userID, false)
	if err != nil {
		return model.ModelChannel{}, err
	}
	for _, channel := range channels {
		if channelID != "" && channel.ID != channelID {
			continue
		}
		for _, name := range channel.Models {
			if name == modelName {
				return channel, nil
			}
		}
	}
	return model.ModelChannel{}, errors.New("本人密钥中没有可用的该模型渠道，请刷新模型目录")
}

func MeteorSelectAnyChannel(modelName, channelID string) (model.ModelChannel, error) {
	meteorSessions.Lock()
	ids := []string{}
	for id := range meteorSessions.byUser {
		ids = append(ids, id)
	}
	meteorSessions.Unlock()
	for _, id := range ids {
		if channel, err := MeteorSelectChannel(id, modelName, channelID); err == nil {
			return channel, nil
		}
	}
	return model.ModelChannel{}, ErrMeteorSession
}

type meteorRoundTripper struct {
	base *url.URL
	next http.RoundTripper
}

func (transport meteorRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != transport.base.Scheme || req.URL.Host != transport.base.Host || req.URL.User != nil || (!strings.HasPrefix(req.URL.Path, "/v1/") && !strings.HasPrefix(req.URL.Path, "/v1beta/")) {
		return nil, errors.New("模型请求只能访问本站网关")
	}
	return transport.next.RoundTrip(req)
}
func meteorGatewayClient(channel model.ModelChannel) *http.Client {
	base, _ := MeteorBaseURL()
	u, _ := url.Parse(base)
	if u == nil {
		u = &url.URL{}
	}
	return &http.Client{Timeout: 600 * time.Second, Transport: meteorRoundTripper{base: u, next: meteorHTTPTransport}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func MeteorPublicChannels(userID string) ([]model.PublicModelChannelInfo, error) {
	channels, err := MeteorChannels(userID, false)
	if err != nil {
		return nil, err
	}
	public := []model.PublicModelChannelInfo{}
	for _, channel := range channels {
		public = append(public, model.PublicModelChannelInfo{ID: channel.ID, Protocol: channel.Protocol, Name: channel.Name, BaseURL: "", Models: channel.Models, ModelCapabilities: channel.ModelCapabilities, Weight: 1, Timeout: 600, Enabled: true})
	}
	return public, nil
}

func MeteorSettings(userID string) (model.PublicSetting, error) {
	channels, err := MeteorPublicChannels(userID)
	if err != nil {
		return model.PublicSetting{}, err
	}
	deny, allow := false, true
	settings := model.PublicSetting{Auth: model.PublicAuthSetting{AllowRegister: &deny}, Storage: model.PublicStorageSetting{Mode: "server_sqlite_s3", AllowUserProvider: false, AllowUserGlobalProvider: true}, ModelChannel: model.PublicModelChannelSetting{Channels: channels, AllowCustomChannel: &deny, AllowUserRemoteChannel: &allow, ModelCosts: []model.ModelCost{}, AvailableModels: []string{}}}
	settings.Storage.RetentionDays = 7
	seen := map[string]bool{}
	for _, channel := range channels {
		for _, name := range channel.Models {
			if !seen[name] {
				settings.ModelChannel.AvailableModels = append(settings.ModelChannel.AvailableModels, name)
				seen[name] = true
			}
			switch channel.ModelCapabilities[name] {
			case "image":
				if settings.ModelChannel.DefaultImageModel == "" {
					settings.ModelChannel.DefaultImageModel = name
				}
			case "video":
				if settings.ModelChannel.DefaultVideoModel == "" {
					settings.ModelChannel.DefaultVideoModel = name
				}
			case "text":
				if settings.ModelChannel.DefaultTextModel == "" {
					settings.ModelChannel.DefaultTextModel = name
				}
			}
		}
	}
	return settings, nil
}

func MeteorRedact(value string) string {
	meteorSessions.Lock()
	defer meteorSessions.Unlock()
	for _, session := range meteorSessions.byUser {
		if session.Token != "" {
			value = strings.ReplaceAll(value, session.Token, "[redacted]")
		}
		for _, channel := range session.Channels {
			if channel.APIKey != "" {
				value = strings.ReplaceAll(value, channel.APIKey, "[redacted]")
			}
		}
	}
	return value
}

func meteorGroupAllowsVideo(group meteorGroup) bool {
	if group.AllowVideo || group.VideoEnabled || len(group.VideoPrices) > 0 {
		return true
	}
	for _, price := range []json.RawMessage{group.VideoPrice480p, group.VideoPrice720p, group.VideoPrice1080p, group.VideoPrice4K} {
		value := strings.TrimSpace(string(price))
		if value != "" && value != "null" && value != `""` {
			return true
		}
	}
	return false
}
