package service

import (
	"io"
	"strings"
	"testing"
)

func TestPromptResponseLimit(t *testing.T) {
	for _, size := range []int{0, 10, 4 << 20, (4 << 20) + 1} {
		body, err := readPromptResponse(io.LimitReader(strings.NewReader(strings.Repeat("p", size)), int64(size)))
		if size > 4<<20 {
			if err == nil || body != nil {
				t.Fatal("oversized prompt source accepted")
			}
		} else if err != nil || len(body) != size {
			t.Fatalf("valid prompt source rejected: %d", size)
		}
	}
}
