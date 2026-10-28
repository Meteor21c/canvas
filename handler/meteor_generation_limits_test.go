package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestMeteorImageBoundaryJSONAndMultipart(t *testing.T) {
	channel := model.ModelChannel{Protocol: "openai", ModelCapabilities: map[string]string{"gpt-image-2": "image", "gpt-5": "text"}}
	for _, fixture := range []struct {
		body, path string
		task       bool
		valid      bool
	}{
		{`{"model":"gpt-image-2","n":4,"images":["a","b","c","d"]}`, "/images/edits", true, true},
		{`{"model":"gpt-image-2","n":5}`, "/images/generations", true, false},
		{`{"model":"gpt-image-2","n":1,"extra_body":{"batch_size":5}}`, "/images/generations", true, false},
		{`{"model":"gpt-image-2","n":1.5}`, "/images/generations", true, false},
		{`{"model":"gpt-image-2","images":["a","b","c","d","e"]}`, "/images/edits", true, false},
		{`{"model":"gpt-image-2","extra_body":{"images":["a","b","c","d","e"]}}`, "/images/edits", true, false},
		{`{"model":"gpt-image-2","_parameterTranslation":{}}`, "/images/generations", true, false},
		{`{"model":"gpt-image-2"}`, "/chat/completions", true, false},
		{`{"model":"gpt-image-2"}`, "/responses", false, false},
		{`{"model":"gpt-5","tools":[{"type":"image_generation"}]}`, "/responses", false, false},
		{`{"model":"gpt-5","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"image"}}]}]}`, "/chat/completions", false, true},
	} {
		err := validateMeteorAIRequest([]byte(fixture.body), "application/json", fixture.path, channel, fixture.task)
		if (err == nil) != fixture.valid {
			t.Errorf("body=%s valid=%v err=%v", fixture.body, fixture.valid, err)
		}
	}
	for count := 4; count <= 5; count++ {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		_ = writer.WriteField("model", "gpt-image-2")
		_ = writer.WriteField("n", "4")
		for index := 0; index < count; index++ {
			part, _ := writer.CreateFormFile("image[]", "image.png")
			_, _ = part.Write([]byte("fixture"))
		}
		_ = writer.Close()
		err := validateMeteorAIRequest(body.Bytes(), writer.FormDataContentType(), "/images/edits", channel, true)
		if (err == nil) != (count == 4) {
			t.Errorf("multipart count%d err%v", count, err)
		}
	}
	channel.Protocol = "gemini"
	if validateMeteorAIRequest([]byte(`{"model":"gpt-image-2"}`), "application/json", "/images/generations", channel, true) == nil {
		t.Fatal("native protocol bypassed images-only")
	}
}

func TestMeteorVideoCanonicalBodyLimitsAndWatermark(t *testing.T) {
	for _, body := range []string{`{"audio":{},"generate_audio":{}}`, `{"audio":true,"generate_audio":false}`, `{"duration":5,"seconds":7}`, `{"count":2}`, `{"extra_body":{"n":2}}`, `{"duration":4.5}`, `{"duration":"oops"}`, `{"_parameterTranslation":{}}`, `{"reference_images":["a","b","c","d","e"]}`} {
		if _, err := meteorVideoBody([]byte(body)); err == nil {
			t.Fatal("unsupported video body accepted", body)
		}
	}
	body, err := meteorVideoBody([]byte(`{"model":"doubao-seedance-2.0-mini","prompt":"fixture","seconds":"5","resolution_name":"720p","watermark":true}`))
	var accepted map[string]any
	_ = json.Unmarshal(body, &accepted)
	if err != nil || accepted["watermark"] != false || accepted["duration"] != float64(5) || accepted["resolution"] != "720p" {
		t.Fatal("video canonical parameters invalid", string(body), err)
	}
}

func TestMeteorVideoReferenceMatchesMainInference(t *testing.T) {
	for _, fixture := range []struct {
		value any
		want  bool
	}{
		{"https://owned.example/clip.mp4", true},
		{"video:https://owned.example/opaque-token", true},
		{"image:https://owned.example/clip.mp4", false},
		{"https://owned.example/signed?filename=clip.webm", true},
		{[]any{"https://owned.example/image.png", "https://owned.example/clip.mov"}, true},
	} {
		if meteorVideoReference(fixture.value) != fixture.want {
			t.Fatal("reference type differs from main billing", fixture)
		}
	}
}
