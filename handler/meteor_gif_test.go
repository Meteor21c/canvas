package handler

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image/gif"
	"strings"
	"testing"
)

func TestCanvasGIFKeepsAllOriginalFrames(t *testing.T) {
	encoded := "R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7"
	payload := []byte(fmt.Sprintf(`{"data":[{"b64_json":%q}]}`, encoded))
	urls, mime, _, err := imageURLsFromAIResponse(payload, "application/json", true, false)
	if err != nil || len(urls) != 1 || mime != "image/gif" || !strings.HasPrefix(urls[0], "data:image/gif;base64,") {
		t.Fatalf("GIF delivery failed: mime=%s err=%v", mime, err)
	}
	raw, _, err := imageCandidateBytes(urls[0])
	original, _ := base64.StdEncoding.DecodeString(encoded)
	if err != nil || !bytes.Equal(raw, original) {
		t.Fatal("original bytes changed")
	}
	animation, err := gif.DecodeAll(bytes.NewReader(raw))
	if err != nil || len(animation.Image) != 2 || animation.LoopCount != 0 {
		t.Fatal("animation lost", err)
	}
}
