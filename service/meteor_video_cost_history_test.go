package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestMeteorVideoCostHistoryOnlyReturnsOwnerAccountingFields(t *testing.T) {
	requests := 0
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/v1/videos/pricing" || r.URL.Query().Get("history") != "true" || r.URL.Query().Has("user_id") || r.Header.Get("Authorization") != "Bearer fixture-private-key" {
			t.Error("history must use the authenticated channel key only")
		}
		fmt.Fprint(w, `{"history":[{"created_at":"2026-11-04T10:00:00Z","resolution":"720p","duration_seconds":10,"duration_source":"actual","currency":"CNY","scene_name":"无视频参考","output_tokens":500000,"actual_amount":"10","average_per_second":"1","prompt":"private-prompt","url":"private-url","api_key":"private-key","task_id":"private-task","user_id":999},{"created_at":"2026-11-04T10:00:00Z","duration_seconds":-1,"actual_amount":"2","currency":"CNY"}]}`)
	})
	rows, err := MeteorVideoCostHistory(context.Background(), user, channel.ID, "doubao-seedance-2.0-mini")
	if err != nil || len(rows) != 1 || rows[0].ActualAmount == nil || *rows[0].ActualAmount != "10" {
		t.Fatalf("unexpected history: %+v, %v", rows, err)
	}
	data, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"private-prompt", "private-url", "private-key", "private-task", "user_id", "api_key", "task_id"} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("history leaked %s", forbidden)
		}
	}
	if _, err := MeteorVideoCostHistory(context.Background(), user, "another-users-channel", "doubao-seedance-2.0-mini"); err == nil {
		t.Fatal("cross-channel history must fail")
	}
	if requests != 1 {
		t.Fatalf("unauthorized lookup reached upstream: %d", requests)
	}
}

func TestMeteorQuoteKeepsUncappedHistoryReference(t *testing.T) {
	user, channel := meteorPricingFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("catalog") == "true" {
			fmt.Fprint(w, `{"model":"doubao-seedance-2.0-mini","resolutions":["720p"],"scenarios":[{"resolutions":["720p"],"audio":false,"input_video":false,"billing_mode":"token","currency":"CNY","sale_per_million":"20"}]}`)
			return
		}
		fmt.Fprint(w, `{"billing_mode":"token","currency":"CNY","sale_per_million":"20","precharge_amount":"5","estimated_amount":"10","estimate_source":"personal","estimate_samples":3,"estimate_low":"9","estimate_high":"11","markup_rate":"1.15"}`)
	})
	quote, err := MeteorMediaQuote(context.Background(), user, MeteorQuoteInput{Kind: "video", Model: "doubao-seedance-2.0-mini", ChannelID: channel.ID, Duration: 10, Resolution: "720p", Count: 1})
	if err != nil || quote.EstimatedAmount == nil || *quote.EstimatedAmount != "10" || quote.EstimateHigh == nil || *quote.EstimateHigh != "11" || quote.PrechargeAmount == nil || *quote.PrechargeAmount != "5" || quote.EstimateSamples != 3 {
		t.Fatalf("uncapped reference lost: %+v, %v", quote, err)
	}
}
