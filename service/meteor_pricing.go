package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

// All public prices use a positive allowlist. Never forward raw main responses.
type MeteorQuoteInput struct {
	Kind       string `json:"kind"`
	ChannelID  string `json:"channelId"`
	Model      string `json:"model"`
	Count      int    `json:"count"`
	Resolution string `json:"resolution"`
	Quality    string `json:"quality"`
	Size       string `json:"size"`
	Duration   int    `json:"duration"`
	Audio      bool   `json:"audio"`
	InputVideo bool   `json:"inputVideo"`
}
type MeteorPrice struct {
	Available          bool               `json:"available"`
	Kind               string             `json:"kind"`
	Model              string             `json:"model"`
	ChannelID          string             `json:"channelId"`
	BillingMode        string             `json:"billingMode"`
	Unit               string             `json:"unit"`
	Currency           string             `json:"currency"`
	SiteUnitPrice      *string            `json:"siteUnitPrice"`
	OfficialUnitPrice  *string            `json:"officialUnitPrice"`
	SaleRateToOfficial *string            `json:"saleRateToOfficial"`
	EstimatedAmount    *string            `json:"estimatedAmount"`
	PrechargeAmount    *string            `json:"prechargeAmount"`
	Exact              bool               `json:"exact"`
	Notice             string             `json:"notice"`
	TokenPrices        map[string]*string `json:"tokenPrices,omitempty"`
	ImagePriceBySize   map[string]*string `json:"imagePriceBySize,omitempty"`
}
type MeteorScenario struct {
	Resolutions        []string `json:"resolutions"`
	Audio              bool     `json:"audio"`
	InputVideo         bool     `json:"inputVideo"`
	BillingMode        string   `json:"billingMode"`
	Unit               string   `json:"unit"`
	Currency           string   `json:"currency"`
	SiteUnitPrice      *string  `json:"siteUnitPrice"`
	OfficialUnitPrice  *string  `json:"officialUnitPrice"`
	SaleRateToOfficial *string  `json:"saleRateToOfficial"`
}
type MeteorDuration struct {
	Min    int   `json:"min"`
	Max    int   `json:"max"`
	Values []int `json:"values,omitempty"`
}
type MeteorCapabilities struct {
	VideoInput     *MeteorVideoInputPolicy `json:"videoInput,omitempty"`
	Uploads        *MeteorUploadPolicy     `json:"uploads,omitempty"`
	Kind           string                  `json:"kind"`
	Model          string                  `json:"model"`
	ChannelID      string                  `json:"channelId"`
	Available      bool                    `json:"available"`
	MaxBatch       int                     `json:"maxBatch"`
	MaxReferences  int                     `json:"maxReferences"`
	ForcedProtocol string                  `json:"forcedProtocol"`
	Watermark      bool                    `json:"watermark"`
	Resolutions    []string                `json:"resolutions"`
	Duration       *MeteorDuration         `json:"duration"`
	SupportsAudio  bool                    `json:"supportsAudio"`
	AspectRatios   []string                `json:"aspectRatios"`
	Scenarios      []MeteorScenario        `json:"scenarios"`
	RetentionDays  int                     `json:"retentionDays"`
	Notice         string                  `json:"notice"`
}
type meteorRawScenario struct {
	Resolutions     []string        `json:"resolutions"`
	Audio           *bool           `json:"audio"`
	InputVideo      *bool           `json:"input_video"`
	Mode            string          `json:"billing_mode"`
	Currency        string          `json:"currency"`
	SaleSecond      json.RawMessage `json:"sale_per_second"`
	OfficialSecond  json.RawMessage `json:"official_per_second"`
	SaleMillion     json.RawMessage `json:"sale_per_million"`
	OfficialMillion json.RawMessage `json:"official_per_million"`
	Ratio           json.RawMessage `json:"sale_rate_to_official"`
}
type meteorVideoCatalog struct {
	Model       string               `json:"model"`
	Resolutions []string             `json:"resolutions"`
	Scenarios   []meteorRawScenario  `json:"scenarios"`
	Models      []meteorVideoCatalog `json:"models"`
}

var meteorPricingCache = struct {
	sync.Mutex
	entries map[string]struct {
		At    time.Time
		Value meteorVideoCatalog
	}
}{entries: map[string]struct {
	At    time.Time
	Value meteorVideoCatalog
}{}}

func meteorDecimal(raw json.RawMessage) *string {
	text := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return nil
	}
	out := strconv.FormatFloat(value, 'f', -1, 64)
	return &out
}
func meteorNumber(value float64) *string {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return nil
	}
	text := strconv.FormatFloat(math.Round(value*1e12)/1e12, 'f', -1, 64)
	return &text
}
func meteorMultiply(value *float64, multiplier float64) *string {
	if value == nil {
		return nil
	}
	return meteorNumber(*value * multiplier)
}
func meteorRawMain(ctx context.Context, channel model.ModelChannel, path string, target any) error {
	if !strings.HasPrefix(path, "/v1/videos/pricing?") {
		return errors.New("计价接口无效")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, channel.BaseURL+path, nil)
	if err != nil {
		return errors.New("计价暂不可用")
	}
	SetModelChannelAuthHeader(request, channel)
	response, err := HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return errors.New("计价暂不可用")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return errors.New("当前参数的计价暂不可用")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || json.Unmarshal(raw, target) != nil {
		return errors.New("计价响应无效")
	}
	return nil
}
func meteorMainVideoCatalog(ctx context.Context, channel model.ModelChannel, modelName string) (meteorVideoCatalog, error) {
	// A key rotation or another owner must never reuse key-specific capabilities.
	key := fmt.Sprintf("%s\n%s\n%x", channel.ID, modelName, sha256.Sum256([]byte(channel.APIKey)))
	meteorPricingCache.Lock()
	cached, ok := meteorPricingCache.entries[key]
	meteorPricingCache.Unlock()
	if ok && time.Since(cached.At) < 30*time.Second {
		return cached.Value, nil
	}
	var raw meteorVideoCatalog
	err := meteorRawMain(ctx, channel, "/v1/videos/pricing?catalog=true&model="+url.QueryEscape(modelName), &raw)
	if err != nil {
		return raw, err
	}
	if raw.Model != modelName {
		found := false
		for _, candidate := range raw.Models {
			if candidate.Model == modelName {
				raw = candidate
				found = true
				break
			}
		}
		if !found {
			return meteorVideoCatalog{}, errors.New("此模型暂不可用")
		}
	}
	raw.Models = nil
	if len(raw.Scenarios) == 0 || len(raw.Resolutions) == 0 {
		return raw, errors.New("此模型参数暂不可用")
	}
	meteorPricingCache.Lock()
	if len(meteorPricingCache.entries) > 128 {
		clear(meteorPricingCache.entries)
	}
	meteorPricingCache.entries[key] = struct {
		At    time.Time
		Value meteorVideoCatalog
	}{time.Now(), raw}
	meteorPricingCache.Unlock()
	return raw, nil
}
func meteorVideoDuration(modelName string) *MeteorDuration {
	// Matches the main site's fzyVideoReservationDuration validation, not guessed
	// from price catalog rows. Unknown models fail closed until described there.
	result := &MeteorDuration{Min: 4, Max: 15}
	switch modelName {
	case "doubao-seedance-1.5-pro":
		result.Max = 12
	case "doubao-seedance-2.5":
		result.Max = 30
	case "doubao-seedance-2.0", "doubao-seedance-2.0-fast", "doubao-seedance-2.0-mini":
	case "kling-v3", "kling-v3-omni":
		result.Min = 3
	case "grok-imagine-video", "grok-imagine-video-1.5", "grok-video":
		result.Min = 1
	default:
		return nil
	}
	return result
}
func MeteorMediaCapabilities(ctx context.Context, userID, kind, channelID, modelName string) (MeteorCapabilities, error) {
	cap := MeteorCapabilities{Kind: kind, Model: modelName, ChannelID: channelID, MaxBatch: 4, MaxReferences: 4, ForcedProtocol: "images", Resolutions: []string{}, AspectRatios: []string{}, Scenarios: []MeteorScenario{}, RetentionDays: 7, Uploads: meteorUploadsPolicy()}
	channel, err := MeteorSelectChannel(userID, modelName, channelID)
	if err != nil {
		return cap, err
	}
	cap.ChannelID = channel.ID
	if kind == "image" {
		if channel.ModelCapabilities[modelName] != "image" || channel.Protocol != "openai" {
			return cap, errors.New("当前模型未开放图片生成")
		}
		quote, quoteErr := meteorImageQuote(ctx, userID, channel, MeteorQuoteInput{Kind: "image", Model: modelName, ChannelID: channel.ID, Count: 1, Resolution: "1K"}, MeteorPrice{Kind: "image", Model: modelName, ChannelID: channel.ID})
		if quoteErr == nil {
			for _, tier := range []string{"1K", "2K", "4K"} {
				if quote.ImagePriceBySize[tier] != nil {
					cap.Resolutions = append(cap.Resolutions, tier)
				}
			}
		}
		// Resolutions describe a known model's accepted size tiers, not a fixed
		// per-image total. Token tariffs keep all unknown totals null.
		image2 := strings.ToLower(strings.TrimSpace(modelName))
		if len(cap.Resolutions) == 0 && quoteErr == nil && quote.Available && quote.BillingMode == "token" && (image2 == "gpt-image-2" || strings.HasPrefix(image2, "gpt-image-2-")) {
			cap.Resolutions = []string{"1K", "2K", "4K"}
		}
		cap.Available = true
		return cap, nil
	}
	if kind != "video" {
		return cap, errors.New("不支持的计价类型")
	}
	cap.MaxBatch = 1
	cap.ForcedProtocol = "sub2api"
	cap.Duration = meteorVideoDuration(modelName)
	cap.VideoInput = meteorVideoInputPolicy(modelName)
	if strings.HasPrefix(modelName, "doubao-seedance-") {
		cap.AspectRatios = []string{"16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"}
	} else if strings.HasPrefix(modelName, "kling-") {
		cap.AspectRatios = []string{"16:9", "9:16", "1:1"}
	}
	if channel.ModelCapabilities[modelName] != "video" || cap.Duration == nil {
		cap.Notice = "当前模型能力尚未确认，暂不可提交"
		return cap, nil
	}
	if meteorGrokVideo(modelName) {
		// Main site's native Grok media UI and billing normalizer confirm this
		// conservative set. Its pricing endpoint only describes FZY models.
		cap.Resolutions = []string{"480p", "720p"}
		cap.AspectRatios = []string{"16:9", "9:16", "1:1", "4:3", "3:4"}
		cap.SupportsAudio = true
		for _, audio := range []bool{false, true} {
			for _, video := range []bool{false, true} {
				cap.Scenarios = append(cap.Scenarios, MeteorScenario{Resolutions: cap.Resolutions, Audio: audio, InputVideo: video, BillingMode: "second", Unit: "second", Currency: "USD"})
			}
		}
		cap.Available = true
		return cap, nil
	}
	raw, err := meteorMainVideoCatalog(ctx, channel, modelName)
	if err != nil {
		cap.Notice = "视频参数暂不可用，请稍后刷新"
		return cap, nil
	}
	for _, resolution := range raw.Resolutions {
		if meteorVideoResolutionAllowed(modelName, resolution) {
			cap.Resolutions = append(cap.Resolutions, resolution)
		}
	}
	for _, row := range raw.Scenarios {
		safe := MeteorScenario{Resolutions: []string{}, BillingMode: row.Mode, Currency: row.Currency, Unit: "unknown", SaleRateToOfficial: meteorDecimal(row.Ratio)}
		for _, value := range row.Resolutions {
			if meteorVideoResolutionAllowed(modelName, value) {
				safe.Resolutions = append(safe.Resolutions, value)
			}
		}
		if row.Mode == "second" {
			safe.Unit = "second"
			safe.SiteUnitPrice = meteorDecimal(row.SaleSecond)
			safe.OfficialUnitPrice = meteorDecimal(row.OfficialSecond)
		} else if row.Mode == "token" {
			safe.Unit = "million_output_tokens"
			safe.SiteUnitPrice = meteorDecimal(row.SaleMillion)
			safe.OfficialUnitPrice = meteorDecimal(row.OfficialMillion)
		} else {
			continue
		}
		if len(safe.Resolutions) > 0 && safe.SiteUnitPrice != nil {
			// Main null means this tariff does not vary by that input, not false.
			for _, audio := range meteorScenarioBooleans(row.Audio) {
				for _, video := range meteorScenarioBooleans(row.InputVideo) {
					if modelName == "kling-v3-omni" && audio && video {
						continue
					}
					entry := safe
					entry.Audio, entry.InputVideo = audio, video
					cap.Scenarios = append(cap.Scenarios, entry)
					cap.SupportsAudio = cap.SupportsAudio || audio
				}
			}
		}
	}
	cap.Available = len(cap.Resolutions) > 0 && len(cap.Scenarios) > 0
	return cap, nil
}

func meteorScenarioBooleans(value *bool) []bool {
	if value == nil {
		return []bool{false, true}
	}
	return []bool{*value}
}
func meteorValidResolution(value string) bool {
	return value == "480p" || value == "720p" || value == "1080p" || strings.EqualFold(value, "4K")
}
func ValidateMeteorVideo(ctx context.Context, userID, channelID, modelName string, duration int, resolution string, audio, inputVideo bool) error {
	cap, err := MeteorMediaCapabilities(ctx, userID, "video", channelID, modelName)
	if err != nil {
		return err
	}
	if !cap.Available || cap.Duration == nil {
		return errors.New("此视频模型的可用参数尚未确认，请刷新模型后重试")
	}
	if duration < cap.Duration.Min || duration > cap.Duration.Max {
		return fmt.Errorf("视频时长须在%d到%d秒之间", cap.Duration.Min, cap.Duration.Max)
	}
	for _, row := range cap.Scenarios {
		if row.Audio != audio || row.InputVideo != inputVideo {
			continue
		}
		for _, value := range row.Resolutions {
			if strings.EqualFold(value, resolution) {
				return nil
			}
		}
	}
	return errors.New("当前模型不支持所选清晰度、音频或参考视频组合")
}
func MeteorMediaQuote(ctx context.Context, userID string, input MeteorQuoteInput) (MeteorPrice, error) {
	quote := MeteorPrice{Kind: input.Kind, Model: input.Model, ChannelID: input.ChannelID, BillingMode: "unknown", Unit: "unknown", Currency: "USD", Notice: "当前参数暂无确定报价，按实际用量结算。"}
	channel, err := MeteorSelectChannel(userID, input.Model, input.ChannelID)
	if err != nil {
		return quote, err
	}
	quote.ChannelID = channel.ID
	if input.Count == 0 {
		input.Count = 1
	}
	if input.Count < 1 || input.Count > 4 || input.Kind == "video" && input.Count != 1 {
		return quote, errors.New("图片单次最多4张，视频单次仅1条")
	}
	if input.Kind == "image" {
		return meteorImageQuote(ctx, userID, channel, input, quote)
	}
	if input.Kind != "video" {
		return quote, errors.New("不支持的计价类型")
	}
	if err := ValidateMeteorVideo(ctx, userID, channel.ID, input.Model, input.Duration, input.Resolution, input.Audio, input.InputVideo); err != nil {
		return quote, err
	}
	if meteorGrokVideo(input.Model) {
		return meteorGrokVideoQuote(ctx, userID, channel, input, quote)
	}
	query := url.Values{"model": {input.Model}, "resolution": {input.Resolution}, "duration": {strconv.Itoa(input.Duration)}, "audio": {strconv.FormatBool(input.Audio)}, "input_video": {strconv.FormatBool(input.InputVideo)}}
	var raw struct {
		Mode            string          `json:"billing_mode"`
		Currency        string          `json:"currency"`
		SaleMillion     json.RawMessage `json:"sale_per_million"`
		OfficialMillion json.RawMessage `json:"official_per_million"`
		SaleSecond      json.RawMessage `json:"sale_per_second"`
		OfficialSecond  json.RawMessage `json:"official_per_second"`
		Ratio           json.RawMessage `json:"sale_rate_to_official"`
		Precharge       json.RawMessage `json:"precharge_amount"`
	}
	if err := meteorRawMain(ctx, channel, "/v1/videos/pricing?"+query.Encode(), &raw); err != nil {
		return quote, nil
	}
	quote.BillingMode = raw.Mode
	quote.Currency = raw.Currency
	quote.SaleRateToOfficial = meteorDecimal(raw.Ratio)
	quote.PrechargeAmount = meteorDecimal(raw.Precharge)
	if raw.Mode == "second" {
		quote.Unit = "second"
		quote.SiteUnitPrice = meteorDecimal(raw.SaleSecond)
		quote.OfficialUnitPrice = meteorDecimal(raw.OfficialSecond)
		if quote.SiteUnitPrice != nil {
			price, _ := strconv.ParseFloat(*quote.SiteUnitPrice, 64)
			quote.EstimatedAmount = meteorNumber(price * float64(input.Duration))
		}
		quote.Notice = "先预扣，完成后按实际生成时长结算，多退少补"
	} else if raw.Mode == "token" {
		quote.Unit = "million_output_tokens"
		quote.SiteUnitPrice = meteorDecimal(raw.SaleMillion)
		quote.OfficialUnitPrice = meteorDecimal(raw.OfficialMillion)
		quote.Notice = "先预扣，完成后按实际输出Token结算，多退少补"
	}
	quote.Available = quote.SiteUnitPrice != nil && quote.PrechargeAmount != nil
	return quote, nil
}

func meteorGrokVideo(modelName string) bool {
	return modelName == "grok-imagine-video" || modelName == "grok-imagine-video-1.5" || modelName == "grok-video"
}

func meteorGrokVideoQuote(ctx context.Context, userID string, channel model.ModelChannel, input MeteorQuoteInput, quote MeteorPrice) (MeteorPrice, error) {
	meteorSessions.Lock()
	session := meteorSessions.byUser[userID]
	token := ""
	groupID := int64(0)
	if session != nil {
		token = session.Token
		groupID = session.ChannelGroups[channel.ID]
	}
	meteorSessions.Unlock()
	if token == "" {
		return quote, ErrMeteorSession
	}
	var groups []meteorGroup
	var rates map[string]float64
	if meteorGet(ctx, "/api/v1/groups/available", token, &groups) != nil || meteorGet(ctx, "/api/v1/groups/rates", token, &rates) != nil {
		return quote, nil
	}
	quote.BillingMode, quote.Unit = "second", "second"
	quote.Notice = "按实际生成时长结算。"
	for _, group := range groups {
		if group.ID != groupID {
			continue
		}
		rate := group.Rate
		if value, ok := rates[strconv.FormatInt(groupID, 10)]; ok {
			rate = &value
		}
		if group.VideoIndependent {
			rate = group.VideoRate
		}
		if rate == nil || *rate < 0 {
			return quote, nil
		}
		var unit *string
		if prices, ok := group.VideoPrices[input.Model].(map[string]any); ok {
			if value, exists := prices[input.Resolution]; exists {
				raw, _ := json.Marshal(value)
				unit = meteorDecimal(raw)
			}
		}
		if unit == nil {
			switch input.Resolution {
			case "480p":
				unit = meteorDecimal(group.VideoPrice480p)
			case "720p":
				unit = meteorDecimal(group.VideoPrice720p)
			}
		}
		if unit == nil {
			return quote, nil
		}
		value, _ := strconv.ParseFloat(*unit, 64)
		quote.SiteUnitPrice = meteorNumber(value * *rate)
		quote.EstimatedAmount = meteorNumber(value * *rate * float64(input.Duration))
		quote.Available = quote.SiteUnitPrice != nil
		return quote, nil
	}
	return quote, nil
}

type meteorPlazaPricing struct {
	Mode        string   `json:"billing_mode"`
	Input       *float64 `json:"input_price"`
	Output      *float64 `json:"output_price"`
	Cache       *float64 `json:"cache_read_price"`
	ImageInput  *float64 `json:"image_input_price"`
	ImageOutput *float64 `json:"image_output_price"`
	Request     *float64 `json:"per_request_price"`
	Intervals   []struct {
		Tier  string   `json:"tier_label"`
		Price *float64 `json:"per_request_price"`
	} `json:"intervals"`
}
type meteorPlazaModel struct {
	Name        string              `json:"name"`
	Pricing     *meteorPlazaPricing `json:"pricing"`
	Official    *meteorPlazaPricing `json:"official_pricing"`
	TimePricing json.RawMessage     `json:"time_pricing"`
}
type meteorPlazaGroup struct {
	ID               int64              `json:"id"`
	Rate             *float64           `json:"rate_multiplier"`
	UserRate         *float64           `json:"user_rate_multiplier"`
	ImageIndependent bool               `json:"image_rate_independent"`
	ImageRate        *float64           `json:"image_rate_multiplier"`
	PeakEnabled      bool               `json:"peak_rate_enabled"`
	PeakStart        string             `json:"peak_start"`
	PeakEnd          string             `json:"peak_end"`
	PeakRate         *float64           `json:"peak_rate_multiplier"`
	Models           []meteorPlazaModel `json:"models"`
}

type meteorActualImageGroup struct {
	meteorPlazaGroup
	Price1K *float64 `json:"image_price_1k"`
	Price2K *float64 `json:"image_price_2k"`
	Price4K *float64 `json:"image_price_4k"`
}

type meteorGroupImageOverride struct {
	meteorPlazaPricing
	Models      []string        `json:"models"`
	TimePricing json.RawMessage `json:"time_pricing"`
}

// Main image billing resolves explicit group model rules first, then an
// explicitly configured image size price, before channel/default token rates.
// The plaza is a display catalogue and need not include every bindable group.
func meteorActualImagePricing(ctx context.Context, token string, groupID int64, input MeteorQuoteInput) (meteorPlazaGroup, bool) {
	var groups []meteorActualImageGroup
	if meteorGet(ctx, "/api/v1/groups/available", token, &groups) != nil {
		return meteorPlazaGroup{}, false
	}
	for _, actual := range groups {
		if actual.ID != groupID {
			continue
		}
		prices := map[string]*float64{"1K": actual.Price1K, "2K": actual.Price2K, "4K": actual.Price4K}
		hasSizePrice := prices[meteorImageTier(input.Resolution, input.Size)] != nil
		group := actual.meteorPlazaGroup
		// Canvas is restricted to the authenticated site owner. Read only the
		// pricing-rule fields from that owner's selected group; other admin
		// fields (including operating costs) are never decoded or returned.
		var configured struct {
			Pricing []meteorGroupImageOverride `json:"model_pricing"`
		}
		if meteorGet(ctx, "/api/v1/admin/groups/"+strconv.FormatInt(groupID, 10), token, &configured) != nil {
			return group, hasSizePrice
		}
		match := meteorMatchGroupImageOverride(configured.Pricing, input.Model)
		if match == nil && !hasSizePrice {
			return meteorPlazaGroup{}, false
		}
		var rates map[string]float64
		if meteorGet(ctx, "/api/v1/groups/rates", token, &rates) != nil {
			return group, true
		}
		if rate, ok := rates[strconv.FormatInt(groupID, 10)]; ok {
			group.UserRate = &rate
		}
		entry := meteorPlazaModel{Name: input.Model}
		if match != nil {
			pricing := match.meteorPlazaPricing
			if pricing.Mode == "" {
				pricing.Mode = "token"
			}
			entry.Pricing, entry.TimePricing = &pricing, match.TimePricing
		} else {
			entry.Pricing = &meteorPlazaPricing{Mode: "image"}
			for _, tier := range []string{"1K", "2K", "4K"} {
				if price := prices[tier]; price != nil {
					entry.Pricing.Intervals = append(entry.Pricing.Intervals, struct {
						Tier  string   `json:"tier_label"`
						Price *float64 `json:"per_request_price"`
					}{tier, price})
				}
			}
		}
		group.Models = []meteorPlazaModel{entry}
		return group, true
	}
	return meteorPlazaGroup{}, false
}

func meteorMatchGroupImageOverride(rules []meteorGroupImageOverride, modelName string) *meteorGroupImageOverride {
	normalize := func(value string) string {
		value = strings.ToLower(strings.TrimSpace(value))
		if strings.HasPrefix(value, "claude-") {
			value = strings.ReplaceAll(value, ".", "-")
		}
		return value
	}
	name := normalize(modelName)
	var wildcard *meteorGroupImageOverride
	for i := range rules {
		for _, pattern := range rules[i].Models {
			pattern = normalize(pattern)
			if pattern == name {
				return &rules[i]
			}
			if strings.HasSuffix(pattern, "*") && strings.HasPrefix(name, strings.TrimSuffix(pattern, "*")) && wildcard == nil {
				wildcard = &rules[i]
			}
		}
	}
	return wildcard
}

func meteorImageTimePricingConfigured(raw json.RawMessage) bool {
	if len(raw) == 0 || string(raw) == "null" {
		return false
	}
	var schedule struct {
		Enabled *bool             `json:"enabled"`
		Periods []json.RawMessage `json:"periods"`
	}
	if json.Unmarshal(raw, &schedule) != nil {
		return true
	}
	return (schedule.Enabled == nil || *schedule.Enabled) && len(schedule.Periods) > 0
}

func meteorImageQuote(ctx context.Context, userID string, channel model.ModelChannel, input MeteorQuoteInput, quote MeteorPrice) (MeteorPrice, error) {
	if channel.ModelCapabilities[input.Model] != "image" || channel.Protocol != "openai" {
		return quote, errors.New("当前模型未开放图片生成")
	}
	meteorSessions.Lock()
	session := meteorSessions.byUser[userID]
	token := ""
	groupID := int64(0)
	if session != nil {
		token = session.Token
		groupID = session.ChannelGroups[channel.ID]
	}
	meteorSessions.Unlock()
	if token == "" {
		return quote, ErrMeteorSession
	}
	var plaza struct {
		Groups []meteorPlazaGroup `json:"groups"`
	}
	if actual, handled := meteorActualImagePricing(ctx, token, groupID, input); handled {
		plaza.Groups = []meteorPlazaGroup{actual}
	} else if meteorGet(ctx, "/api/v1/model-plaza", token, &plaza) != nil {
		return quote, nil
	}
	for _, group := range plaza.Groups {
		if group.ID != groupID {
			continue
		}
		for _, entry := range group.Models {
			if entry.Name != input.Model || entry.Pricing == nil {
				continue
			}
			pricing := entry.Pricing
			rateValue := group.Rate
			if group.UserRate != nil {
				rateValue = group.UserRate
			}
			if rateValue == nil {
				return quote, nil
			}
			rate := *rateValue
			if rate < 0 {
				return quote, nil
			}
			quote.BillingMode = pricing.Mode
			quote.Available = true
			if pricing.Mode == "image" || pricing.Mode == "per_request" {
				if pricing.Mode == "per_request" {
					quote.BillingMode = "request"
				}
				if group.ImageIndependent {
					if group.ImageRate == nil {
						quote.Available = false
						return quote, nil
					}
					rate = *group.ImageRate
				}
				quote.Unit = "image"
				quote.ImagePriceBySize = map[string]*string{}
				for _, tier := range pricing.Intervals {
					if tier.Price != nil {
						quote.ImagePriceBySize[tier.Tier] = meteorMultiply(tier.Price, rate)
					}
				}
				tier := meteorImageTier(input.Resolution, input.Size)
				price := pricing.Request
				for _, row := range pricing.Intervals {
					if strings.EqualFold(row.Tier, tier) {
						price = row.Price
						break
					}
				}
				if len(pricing.Intervals) > 0 && quote.ImagePriceBySize[tier] == nil {
					price = nil
				}
				quote.SiteUnitPrice = meteorMultiply(price, rate)
				quote.Available = quote.SiteUnitPrice != nil
				if price != nil {
					quote.EstimatedAmount = meteorNumber(*price * rate * float64(input.Count))
					quote.Exact = true
					quote.Notice = "按所选尺寸与数量计费。"
				}
				return quote, nil
			}
			if pricing.Mode != "token" {
				quote.Available = false
				quote.BillingMode = "unknown"
				return quote, nil
			}
			quote.Unit = "million_output_tokens"
			// Main plaza token prices are USD/token. Include active peak multiplier;
			// configured model time periods/tiers require unknown rather than guesses.
			if group.PeakEnabled {
				location, _ := time.LoadLocation("Asia/Shanghai")
				minute := time.Now().In(location).Format("15:04")
				active := minute >= group.PeakStart && minute < group.PeakEnd
				if group.PeakStart > group.PeakEnd {
					active = minute >= group.PeakStart || minute < group.PeakEnd
				}
				if active {
					if group.PeakRate == nil || *group.PeakRate < 0 {
						quote.Available = false
						return quote, nil
					}
					rate *= *group.PeakRate
				}
			}
			if len(pricing.Intervals) > 0 || meteorImageTimePricingConfigured(entry.TimePricing) {
				quote.Available = false
				quote.Notice = "当前参数暂无确定报价，按实际用量结算。"
				return quote, nil
			}
			quote.TokenPrices = map[string]*string{"inputPerMillion": meteorMultiply(pricing.Input, rate*1e6), "outputPerMillion": meteorMultiply(pricing.Output, rate*1e6), "cacheReadPerMillion": meteorMultiply(pricing.Cache, rate*1e6), "imageInputPerMillion": meteorMultiply(pricing.ImageInput, rate*1e6), "imageOutputPerMillion": meteorMultiply(pricing.ImageOutput, rate*1e6)}
			quote.SiteUnitPrice = quote.TokenPrices["imageOutputPerMillion"]
			if quote.SiteUnitPrice == nil {
				quote.SiteUnitPrice = quote.TokenPrices["outputPerMillion"]
			}
			quote.Available = quote.SiteUnitPrice != nil
			if entry.Official != nil {
				if pricing.ImageOutput != nil {
					quote.OfficialUnitPrice = meteorMultiply(entry.Official.ImageOutput, 1e6)
				} else {
					quote.OfficialUnitPrice = meteorMultiply(entry.Official.Output, 1e6)
				}
				if quote.SiteUnitPrice != nil && quote.OfficialUnitPrice != nil {
					sale, _ := strconv.ParseFloat(*quote.SiteUnitPrice, 64)
					official, _ := strconv.ParseFloat(*quote.OfficialUnitPrice, 64)
					if official > 0 {
						quote.SaleRateToOfficial = meteorNumber(sale / official)
					}
				}
			}
			quote.Notice = "按实际输入、缓存与图像输出 Token 结算，生成前无法确定总价。"
			return quote, nil
		}
	}
	return quote, nil
}
func meteorImageTier(resolution, size string) string {
	parts := strings.Split(strings.ToLower(size), "x")
	if len(parts) == 2 {
		w, _ := strconv.Atoi(parts[0])
		h, _ := strconv.Atoi(parts[1])
		long := max(w, h)
		if long > 2048 {
			return "4K"
		}
		if long > 1024 {
			return "2K"
		}
		if long > 0 {
			return "1K"
		}
	}
	if resolution != "" {
		value := strings.ToUpper(resolution)
		if value == "1K" || value == "2K" || value == "4K" {
			return value
		}
	}
	return "2K"
}
