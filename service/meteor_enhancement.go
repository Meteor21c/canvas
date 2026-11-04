package service

import (
	"context"
	"errors"
	"path/filepath"
)

// Resolve a source through the same owner, expiry, size and SSRF checks as all
// other references. Probe a local file only; enhancement runs on the provider.
func MeteorPrepareEnhancementSource(ctx context.Context, value string, frameRate int) (string, float64, error) {
	if frameRate != 30 && frameRate != 60 && frameRate != 120 {
		return "", 0, errors.New("视频帧率档位无效")
	}
	object, err := MeteorResolveMaterial(ctx, value, "video")
	if err != nil {
		return "", 0, err
	}
	metadata, err := meteorProbeMedia(ctx, filepath.Join(meteorMediaRoot(), object.ID), object.MimeType)
	if err != nil {
		return "", 0, err
	}
	if metadata.FrameRate > float64(frameRate)+0.2 {
		return "", 0, errors.New("所选帧率档位低于源视频帧率，请选择更高档位")
	}
	return MeteorAbsoluteMediaURL(object.URL), metadata.Duration, nil
}
