package handler

import (
	"encoding/json"
	"testing"
)

func TestMeteorEnhancementCanonicalBody(t *testing.T) {
	body, err := meteorVideoBody([]byte(`{"model":"tencent-mps-superres","url":"https://example.com/source.mp4","resolution":"2K","frameRate":60,"sourceDurationSeconds":99}`))
	var accepted map[string]any
	_ = json.Unmarshal(body, &accepted)
	if err != nil || accepted["url"] != "https://example.com/source.mp4" || accepted["frameRate"] != float64(60) || accepted["resolution"] != "2k" {
		t.Fatal("invalid enhancement body", string(body), err)
	}
	for _, field := range []string{"prompt", "duration", "sourceDurationSeconds", "audio"} {
		if _, found := accepted[field]; found {
			t.Fatal("untrusted or generated option forwarded", field)
		}
	}
	for _, raw := range []string{
		`{"model":"tencent-mps-superres","url":"https://example.com/source.mp4","resolution":"1080p","frameRate":24}`,
		`{"model":"tencent-mps-superres","url":"https://example.com/source.mp4","resolution":"4K","frameRate":30,"prompt":"generate"}`,
		`{"model":"tencent-mps-superres","url":"https://example.com/source.mp4","resolution":"8K","frameRate":120}`,
		`{"model":"tencent-mps-superres","resolution":"720p","frameRate":30}`,
	} {
		if _, err := meteorVideoBody([]byte(raw)); err == nil {
			t.Fatal("invalid enhancement accepted", raw)
		}
	}
}
