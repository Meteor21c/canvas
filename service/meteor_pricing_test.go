package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func meteorPricingFixture(t *testing.T, fn http.HandlerFunc) (string, model.ModelChannel) {
	t.Helper()
	server := httptest.NewServer(fn)
	t.Cleanup(server.Close)
	previous := config.Cfg
	config.Cfg = config.Config{MeteorMode: true, MeteorAPIBase: server.URL}
	t.Cleanup(func() { config.Cfg = previous })
	id := "price-" + uuid.NewString()
	channel := model.ModelChannel{ID: "meteor-price-" + id, Protocol: "openai", APIKey: "fixture-private-key", BaseURL: server.URL, Models: []string{"gpt-image-2", "seedream-4", "doubao-seedance-2.0-mini"}, ModelCapabilities: map[string]string{"gpt-image-2": "image", "seedream-4": "image", "doubao-seedance-2.0-mini": "video"}}
	meteorSessions.Lock()
	meteorSessions.byUser[id] = &meteorSession{Token: "fixture-owner-token", ExpiresAt: time.Now().Add(time.Hour), CatalogAt: time.Now(), Channels: []model.ModelChannel{channel}, ChannelGroups: map[string]int64{channel.ID: 5}}
	meteorSessions.Unlock()
	t.Cleanup(func() { meteorSessions.Lock(); delete(meteorSessions.byUser, id); meteorSessions.Unlock() })
	return id, channel
}

func TestMeteorVideoPricesSafeAndParameterMatched(t *testing.T) {
	var prices int
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/videos/pricing" || r.Header.Get("Authorization") != "Bearer fixture-private-key" {
			t.Error("unexpected price request")
		}
		if r.URL.Query().Get("catalog") == "true" {
			fmt.Fprint(w, `{"model":"doubao-seedance-2.0-mini","resolutions":["480p","720p"],"upstream_price":1,"source":"provider-secret","scenarios":[{"resolutions":["480p","720p"],"audio":false,"input_video":false,"billing_mode":"token","currency":"CNY","sale_per_million":"17.25","official_per_million":"50","sale_rate_to_official":"0.345","markup_rate":1.15,"upstream_per_million":15}]}`)
			return
		}
		prices++
		if r.URL.Query().Get("duration") != "5" || r.URL.Query().Get("resolution") != "720p" || r.URL.Query().Get("audio") != "false" {
			t.Error("quote parameters changed")
		}
		fmt.Fprint(w, `{"billing_mode":"token","currency":"CNY","sale_per_million":"17.25","official_per_million":"50","sale_rate_to_official":"0.345","precharge_amount":"1.2","upstream_per_million":15,"markup_rate":1.15,"source":"provider-secret"}`)
	})
	cap, err := MeteorMediaCapabilities(context.Background(), user, "video", channel.ID, "doubao-seedance-2.0-mini")
	if err != nil || !cap.Available || cap.MaxBatch != 1 || cap.Watermark || cap.Duration.Max != 15 {
		t.Fatalf("capabilities: %+v %v", cap, err)
	}
	quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "video", ChannelID: channel.ID, Model: cap.Model, Count: 1, Duration: 5, Resolution: "720p"})
	if err != nil || !quote.Available || quote.SiteUnitPrice == nil || *quote.SiteUnitPrice != "17.25" || quote.EstimatedAmount != nil || *quote.PrechargeAmount != "1.2" {
		t.Fatalf("quote: %+v %v", quote, err)
	}
	raw, _ := json.Marshal([]any{cap, quote})
	for _, forbidden := range []string{"upstream", "markup", "source", "provider-secret", "fixture-private-key", "fixture-owner-token"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatal("private pricing field exposed", forbidden)
		}
	}
	for _, input := range []MeteorQuoteInput{
		{Kind: "video", ChannelID: channel.ID, Model: cap.Model, Count: 2, Duration: 5, Resolution: "720p"},
		{Kind: "video", ChannelID: channel.ID, Model: cap.Model, Count: 1, Duration: 30, Resolution: "720p"},
		{Kind: "video", ChannelID: channel.ID, Model: cap.Model, Count: 1, Duration: 5, Resolution: "4K"},
		{Kind: "video", ChannelID: channel.ID, Model: cap.Model, Count: 1, Duration: 5, Resolution: "720p", Audio: true},
	} {
		if _, err := MeteorMediaQuote(context.Background(), user, input); err == nil {
			t.Fatal("unsupported option quoted", input)
		}
	}
	if prices != 1 {
		t.Fatal("invalid requests reached price endpoint", prices)
	}
}

func TestMeteorImageTokenAndTierPricesRemainHonest(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/groups/available" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.Path != "/api/v1/model-plaza" {
			t.Error("unexpected route", r.URL.Path)
		}
		fmt.Fprint(w, `{"code":0,"data":{"groups":[{"id":5,"rate_multiplier":2,"user_rate_multiplier":1.5,"image_rate_independent":true,"image_rate_multiplier":1.2,"models":[{"name":"gpt-image-2","pricing":{"billing_mode":"token","input_price":0.000005,"output_price":0.00001,"image_output_price":0.00003},"official_pricing":{"output_price":0.00004}},{"name":"seedream-4","pricing":{"billing_mode":"image","intervals":[{"tier_label":"1K","per_request_price":0.1},{"tier_label":"2K","per_request_price":0.2},{"tier_label":"4K","per_request_price":0.4}]}}]}]}}`)
	})
	quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "image", ChannelID: channel.ID, Model: "gpt-image-2", Count: 4, Size: "1024x1024"})
	if err != nil || !quote.Available || quote.BillingMode != "token" || quote.SiteUnitPrice == nil || *quote.SiteUnitPrice != "45" || *quote.TokenPrices["inputPerMillion"] != "7.5" {
		t.Fatalf("token rate: %+v %v", quote, err)
	}
	if quote.EstimatedAmount != nil || quote.PrechargeAmount != nil || quote.OfficialUnitPrice != nil || quote.SaleRateToOfficial != nil || quote.Exact {
		t.Fatal("invented per-image total or mixed official text/image prices", quote)
	}
	quote, err = MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "image", ChannelID: channel.ID, Model: "seedream-4", Count: 4, Resolution: "1K", Size: "4096x4096"})
	if err != nil || !quote.Available || *quote.SiteUnitPrice != "0.48" || *quote.EstimatedAmount != "1.92" || !quote.Exact {
		t.Fatalf("tier precedence/multiplier: %+v %v", quote, err)
	}
	if quote.ImagePriceBySize["1K"] == nil || *quote.ImagePriceBySize["1K"] != "0.12" {
		t.Fatal("tier table missing", quote)
	}
	if _, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "image", ChannelID: channel.ID, Model: "seedream-4", Count: 5}); err == nil {
		t.Fatal("five images permitted")
	}
}

func TestMeteorActualImageGroupOutsidePlazaQuotesEverySizeAndCount(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer fixture-owner-token" {
			t.Fatal("unexpected authenticated read")
		}
		switch r.URL.Path {
		case "/api/v1/groups/available":
			fmt.Fprint(w, `{"code":0,"data":[{"id":5,"rate_multiplier":2,"image_rate_independent":false,"image_rate_multiplier":1.2,"allow_image_generation":true,"image_price_1k":0.1,"image_price_2k":0.2,"image_price_4k":0.4}]}`)
		case "/api/v1/groups/rates":
			fmt.Fprint(w, `{"code":0,"data":{"5":0.5}}`)
		case "/api/v1/admin/groups/5":
			fmt.Fprint(w, `{"code":0,"data":{"id":5,"model_pricing":[],"provider":"private-provider","upstream_cost":123}}`)
		default:
			t.Fatal("fixed group image prices must not depend on display plaza", r.URL.Path)
		}
	})
	for _, size := range []struct{ tier, unit string }{{"1K", "0.05"}, {"2K", "0.1"}, {"4K", "0.2"}} {
		for _, count := range []int{1, 4} {
			quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "image", ChannelID: channel.ID, Model: "gpt-image-2", Count: count, Resolution: size.tier})
			if err != nil || !quote.Available || quote.SiteUnitPrice == nil || *quote.SiteUnitPrice != size.unit || quote.BillingMode != "image" || !quote.Exact || quote.EstimatedAmount == nil {
				t.Fatal("configured image group price unavailable", size.tier, count, err)
			}
			unit, _ := strconv.ParseFloat(size.unit, 64)
			if *quote.EstimatedAmount != *meteorNumber(unit * float64(count)) || len(quote.ImagePriceBySize) != 3 || quote.PrechargeAmount != nil {
				t.Fatal("size/count/group rate mismatch")
			}
			raw, _ := json.Marshal(quote)
			for _, forbidden := range []string{"private-provider", "upstream", "provider", "model_pricing", "fixture-owner-token"} {
				if strings.Contains(string(raw), forbidden) {
					t.Fatal("group internals exposed")
				}
			}
		}
	}
}

func TestMeteorExplicitGroupModelPriceBeatsGeneralImagePrice(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/groups/available":
			fmt.Fprint(w, `{"code":0,"data":[{"id":5,"rate_multiplier":2,"image_rate_independent":true,"image_rate_multiplier":1.2,"image_price_1k":0.1}]}`)
		case "/api/v1/groups/rates":
			fmt.Fprint(w, `{"code":0,"data":{"5":0.5}}`)
		case "/api/v1/admin/groups/5":
			fmt.Fprint(w, `{"code":0,"data":{"model_pricing":[{"models":["gpt-image-*"],"billing_mode":"per_request","per_request_price":9},{"models":["gpt-image-2"],"billing_mode":"token","input_price":0.000005,"image_output_price":0.00003},{"models":["seedream-*"],"billing_mode":"per_request","per_request_price":0.9}]}}`)
		default:
			t.Fatal("unexpected pricing source", r.URL.Path)
		}
	})
	quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "image", ChannelID: channel.ID, Model: "gpt-image-2", Count: 4, Resolution: "4K"})
	if err != nil || !quote.Available || quote.BillingMode != "token" || quote.SiteUnitPrice == nil || *quote.SiteUnitPrice != "15" || quote.EstimatedAmount != nil || quote.PrechargeAmount != nil {
		t.Fatal("token exact override lost to wildcard or flat image price", err)
	}
	quote, err = MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "image", ChannelID: channel.ID, Model: "seedream-4", Count: 4, Resolution: "4K"})
	if err != nil || !quote.Available || quote.BillingMode != "request" || quote.SiteUnitPrice == nil || *quote.SiteUnitPrice != "1.08" || *quote.EstimatedAmount != "4.32" {
		t.Fatal("explicit per-request override or image independent rate lost", err)
	}
}

func TestMeteorConfiguredImagePriceDoesNotIgnoreUnknownOverride(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/groups/available":
			fmt.Fprint(w, `{"code":0,"data":[{"id":5,"rate_multiplier":1,"image_price_1k":0.1}]}`)
		case "/api/v1/groups/rates":
			fmt.Fprint(w, `{"code":0,"data":{}}`)
		case "/api/v1/admin/groups/5":
			w.WriteHeader(http.StatusForbidden)
		default:
			t.Fatal("must not substitute unrelated prices when override cannot be verified")
		}
	})
	quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "image", ChannelID: channel.ID, Model: "gpt-image-2", Resolution: "1K"})
	if err != nil || quote.Available || quote.SiteUnitPrice != nil || quote.EstimatedAmount != nil {
		t.Fatal("unknown override was assumed absent", err)
	}
}

func TestMeteorDisabledOrEmptyTimePricingDoesNotHideKnownTokenRate(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `{"enabled":false,"periods":[{}]}`, `{"timezone":"Asia/Shanghai","periods":[]}`} {
		if meteorImageTimePricingConfigured(json.RawMessage(raw)) {
			t.Fatal("inactive schedule treated as variable price", raw)
		}
	}
	if !meteorImageTimePricingConfigured(json.RawMessage(`{"timezone":"Asia/Shanghai","periods":[{"start_time":"00:00","end_time":"23:59","multiplier":2}]}`)) {
		t.Fatal("active schedule ignored")
	}
}

func TestMeteorMissingImagePriceOrMultiplierIsNull(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"code":0,"data":{"groups":[{"id":5,"models":[{"name":"gpt-image-2","pricing":{"billing_mode":"token","image_output_price":0.00003}}]}]}}`)
	})
	quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "image", ChannelID: channel.ID, Model: "gpt-image-2"})
	if err != nil || quote.Available || quote.SiteUnitPrice != nil || quote.EstimatedAmount != nil {
		t.Fatal("missing multiplier became free", quote, err)
	}
	raw, _ := json.Marshal(quote)
	if !strings.Contains(string(raw), `"siteUnitPrice":null`) || !strings.Contains(string(raw), `"prechargeAmount":null`) {
		t.Fatal("unknown money is not null", string(raw))
	}
}

func TestMeteorExistingGrokVideoKeepsSupportedOptionsAndUsesOwnGroupPrice(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/groups/available":
			fmt.Fprint(w, `{"code":0,"data":[{"id":5,"rate_multiplier":2,"video_rate_independent":true,"video_rate_multiplier":1.2,"video_model_prices":{"grok-imagine-video-1.5":{"720p":0.1}}}]}`)
		case "/api/v1/groups/rates":
			fmt.Fprint(w, `{"code":0,"data":{"5":0.5}}`)
		default:
			t.Errorf("native Grok incorrectly required FZY pricing route: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	meteorSessions.Lock()
	channel.Models = append(channel.Models, "grok-imagine-video-1.5")
	channel.ModelCapabilities["grok-imagine-video-1.5"] = "video"
	meteorSessions.byUser[user].Channels = []model.ModelChannel{channel}
	meteorSessions.Unlock()
	cap, err := MeteorMediaCapabilities(context.Background(), user, "video", channel.ID, "grok-imagine-video-1.5")
	if err != nil || !cap.Available || cap.Duration.Min != 1 || cap.Duration.Max != 15 || len(cap.Resolutions) != 2 {
		t.Fatal("legal native Grok video disabled", cap, err)
	}
	quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "video", Model: cap.Model, ChannelID: channel.ID, Count: 1, Resolution: "720p", Duration: 5})
	if err != nil || !quote.Available || *quote.SiteUnitPrice != "0.12" || *quote.EstimatedAmount != "0.6" || quote.PrechargeAmount != nil || quote.OfficialUnitPrice != nil || quote.SaleRateToOfficial != nil {
		t.Fatal("native Grok price not using own group or invented missing values", quote, err)
	}
	if err := ValidateMeteorVideo(context.Background(), user, channel.ID, cap.Model, 16, "720p", false, false); err == nil {
		t.Fatal("native Grok duration exceeded main rules")
	}
}

func TestMeteorNullableScenarioMatchesMainWildcardSemantics(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"model":"doubao-seedance-2.0-mini","resolutions":["720p"],"scenarios":[{"resolutions":["720p"],"audio":null,"input_video":false,"billing_mode":"token","currency":"CNY","sale_per_million":17.25}]}`)
	})
	cap, err := MeteorMediaCapabilities(context.Background(), user, "video", channel.ID, "doubao-seedance-2.0-mini")
	if err != nil || !cap.SupportsAudio || len(cap.Scenarios) != 2 {
		t.Fatal("null audio interpreted as false", cap, err)
	}
	for _, audio := range []bool{false, true} {
		if err := ValidateMeteorVideo(context.Background(), user, channel.ID, cap.Model, 5, "720p", audio, false); err != nil {
			t.Fatal("supported audio option rejected", audio, err)
		}
	}
}
