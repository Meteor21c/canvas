package handler

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/service"
)

type multipartZeroReader struct{}

func (multipartZeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

// Generate image payloads on demand: the test itself never holds a second
// 100 MiB request. The model is deliberately after the files.
func streamedCanvasMultipart(t *testing.T, sizes []int64, extraFields int) (io.Reader, string, int64) {
	t.Helper()
	var headers bytes.Buffer
	writer := multipart.NewWriter(&headers)
	var chunks []io.Reader
	var length int64
	flush := func() {
		value := bytes.Clone(headers.Bytes())
		chunks = append(chunks, bytes.NewReader(value))
		length += int64(len(value))
		headers.Reset()
	}
	if err := writer.WriteField("_canvas_prompt", "prompt"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("n", "4"); err != nil {
		t.Fatal(err)
	}
	for i, size := range sizes {
		if _, err := writer.CreateFormFile("image", fmt.Sprintf("reference-%d.png", i)); err != nil {
			t.Fatal(err)
		}
		flush()
		chunks = append(chunks, io.LimitReader(multipartZeroReader{}, size))
		length += size
	}
	for i := 0; i < extraFields; i++ {
		if err := writer.WriteField(fmt.Sprintf("field-%d", i), strings.Repeat("x", int(meteorAIFieldMaxBytes))); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.WriteField("model", "test-model"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	flush()
	return io.MultiReader(chunks...), writer.FormDataContentType(), length
}

func meteorMultipartMode(t *testing.T) {
	t.Helper()
	previous := config.Cfg
	config.Cfg.MeteorMode = true
	t.Cleanup(func() { config.Cfg = previous })
}

func TestMeteorCanvasMultipartTenImagesStreamWithoutCopiesOrTempFiles(t *testing.T) {
	meteorMultipartMode(t)
	temp := t.TempDir()
	t.Setenv("TMPDIR", temp)
	sizes := make([]int64, 10)
	for i := range sizes {
		sizes[i] = service.MeteorImageMaxBytes
	}
	reader, contentType, length := streamedCanvasMultipart(t, sizes, 0)
	request := httptest.NewRequest(http.MethodPost, "/api/canvas/tasks/images", reader)
	request.ContentLength = length
	request.Header.Set("Content-Type", contentType)
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	body, cleanedType, _, _, _, _, _, prompt, _, err := readCanvasTaskAIRequest(request, "/images/edits")
	if err != nil || prompt != "prompt" || len(body) < int(service.MeteorReferenceMaxBytes) {
		t.Fatalf("100 MiB input failed: size=%d prompt=%q err=%v", len(body), prompt, err)
	}
	if got := readMultipartModel(body, cleanedType); got != "test-model" {
		t.Fatalf("model after files = %q", got)
	}
	if count := readAIRequestCount(body, cleanedType, false); count != 4 {
		t.Fatalf("generation count = %d", count)
	}
	summary := summarizeMultipartAIRequest(body, cleanedType)
	if !strings.Contains(summary, "reference-9.png") || !strings.Contains(summary, "10485760") {
		t.Fatalf("missing file metadata in bounded summary: %.200s", summary)
	}
	cached := httptest.NewRequest(http.MethodPost, "/api/v1/images/edits", unreadableMultipartBody{})
	cached = cached.WithContext(context.WithValue(cached.Context(), canvasAIRequestBodyKey{}, body))
	cached.Header.Set("Content-Type", cleanedType)
	forwardBody, _, _, err := readAIRequest(cached)
	if err != nil || len(forwardBody) != len(body) || &forwardBody[0] != &body[0] {
		t.Fatal("internal forwarding copied or reread the validated body", err)
	}
	runtime.ReadMemStats(&after)
	allocated := after.TotalAlloc - before.TotalAlloc
	t.Logf("100 MiB multipart parse, metadata scans and cached forwarding allocated %.2f MiB", float64(allocated)/(1<<20))
	if allocated > 125<<20 {
		t.Fatalf("multipart allocated %d MiB; should keep only one 100 MiB body", allocated>>20)
	}
	files, err := os.ReadDir(temp)
	if err != nil || len(files) != 0 {
		t.Fatalf("multipart touched temp storage: %v %v", files, err)
	}
}

type unreadableMultipartBody struct{}

func (unreadableMultipartBody) Read([]byte) (int, error) {
	return 0, fmt.Errorf("body must not be read")
}

func TestMeteorCanvasMultipartRejectsImageCountSizeAndTextBudgets(t *testing.T) {
	meteorMultipartMode(t)
	for _, tc := range []struct {
		name   string
		sizes  []int64
		fields int
		want   string
	}{
		{"single image", []int64{service.MeteorImageMaxBytes + 1}, 0, "10 MiB"},
		{"reference count", make([]int64, 11), 0, "最多10张"},
		{"field total", nil, 17, "1 MiB"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader, contentType, length := streamedCanvasMultipart(t, tc.sizes, tc.fields)
			_, _, _, err := readCanvasTaskMultipartFields(reader, contentType, length, true)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q: %v", tc.want, err)
			}
		})
	}
	if _, err := readMultipartTextField(strings.NewReader(strings.Repeat("x", int(meteorAIFieldMaxBytes+1)))); err == nil {
		t.Fatal("oversized text field accepted")
	}
	if _, _, _, err := readCanvasTaskMultipartFields(unreadableMultipartBody{}, "multipart/form-data; boundary=fixture", meteorAIMultipartMaxBytes+1, true); err == nil || !strings.Contains(err.Error(), "100 MiB") {
		t.Fatal("declared oversized request was read", err)
	}
	reader, contentType, _ := streamedCanvasMultipart(t, []int64{service.MeteorImageMaxBytes + 1}, 0)
	if _, _, _, err := readCanvasTaskMultipartFields(reader, contentType, -1, true); err == nil || !strings.Contains(err.Error(), "10 MiB") {
		t.Fatal("chunked oversized image accepted", err)
	}
}

func TestMeteorJSONAndUnknownLengthBodiesStayBounded(t *testing.T) {
	meteorMultipartMode(t)
	request := httptest.NewRequest(http.MethodPost, "/api/canvas/tasks/images", unreadableMultipartBody{})
	request.Header.Set("Content-Type", "application/json")
	request.ContentLength = meteorAIJSONMaxBytes + 1
	if _, _, _, _, _, _, _, _, _, err := readCanvasTaskAIRequest(request, "/images/generations"); err == nil || !strings.Contains(err.Error(), "32 MiB") {
		t.Fatal("oversized JSON wrapper accepted", err)
	}
	request.Header.Set("X-Canvas-Node-Request", "true")
	if _, _, _, err := readAIRequest(request); err == nil || !strings.Contains(err.Error(), "32 MiB") {
		t.Fatal("external header bypassed body limit", err)
	}
	if _, err := readBoundedAIRequestBody(io.LimitReader(multipartZeroReader{}, 1025), -1, 1024); err == nil {
		t.Fatal("chunked body exceeded its cap")
	}
	reader, contentType, _ := streamedCanvasMultipart(t, []int64{1}, 0)
	body, cleaned, _, err := readCanvasTaskMultipartFields(reader, contentType, -1, true)
	if err != nil || readMultipartModel(body, cleaned) != "test-model" {
		t.Fatal("bounded unknown-length multipart rejected", err)
	}
}

func TestMeteorMultipartOwnsBothSlotsAndJSONKeepsNormalCapacity(t *testing.T) {
	meteorMultipartMode(t)
	multipartRequest := httptest.NewRequest(http.MethodPost, "/api/v1/images/edits", unreadableMultipartBody{})
	multipartRequest.Header.Set("Content-Type", "multipart/form-data; boundary=fixture")
	release, ok := tryAIRequestGeneration(multipartRequest)
	if !ok {
		t.Fatal("first multipart request rejected")
	}
	if _, ok := tryAIRequestGeneration(multipartRequest); ok {
		release()
		t.Fatal("second multipart request admitted")
	}
	jsonRequest := httptest.NewRequest(http.MethodPost, "/api/v1/images/generations", nil)
	jsonRequest.Header.Set("Content-Type", "application/json")
	if releaseJSON, ok := tryAIRequestGeneration(jsonRequest); ok {
		releaseJSON()
		release()
		t.Fatal("JSON request admitted while a large multipart owns both slots")
	}
	multipartRequest.Header.Set("X-Canvas-Node-Request", "true")
	recorder := httptest.NewRecorder()
	proxyAIRequest(recorder, multipartRequest, "/images/edits")
	release()
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("public header bypassed multipart slot: status=%d", recorder.Code)
	}
	releaseFirst, ok := tryAIRequestGeneration(jsonRequest)
	if !ok {
		t.Fatal("first JSON request rejected after multipart release")
	}
	defer releaseFirst()
	releaseSecond, ok := tryAIRequestGeneration(jsonRequest)
	if !ok {
		t.Fatal("second JSON request rejected")
	}
	defer releaseSecond()
	if _, ok := tryAIRequestGeneration(jsonRequest); ok {
		t.Fatal("third JSON request admitted")
	}
}
