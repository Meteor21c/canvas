package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"strconv"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

var meteorCountFields = map[string]bool{"n": true, "count": true, "num_images": true, "num_outputs": true, "output_count": true, "batch_size": true, "batchsize": true, "candidatecount": true}
var meteorReferenceFields = map[string]bool{"image": true, "images": true, "image[]": true, "input_image": true, "input_images": true, "reference_images": true, "references": true, "input_reference": true, "input_reference[]": true}

// Inspect all count aliases, including custom nested options, before any task is
// claimed or any paid request is sent. The main gateway remains billing truth.
func meteorValidateValues(value any, maxBatch int) error {
	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			lower := strings.ToLower(key)
			if lower == "_parametertranslation" || lower == "parametertranslation" {
				return errors.New("画布不支持自定义协议转换")
			}
			if meteorCountFields[lower] {
				n, err := strconv.ParseFloat(strings.TrimSpace(toMeteorString(child)), 64)
				if err != nil || n < 1 || n > float64(maxBatch) || n != float64(int(n)) {
					return errors.New("图片单次最多4张，视频单次仅1条")
				}
			}
			if err := meteorValidateValues(child, maxBatch); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range value {
			if err := meteorValidateValues(child, maxBatch); err != nil {
				return err
			}
		}
	}
	return nil
}

func toMeteorString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	raw, _ := json.Marshal(value)
	return string(raw)
}

func meteorReferenceCount(value any) int {
	switch value := value.(type) {
	case nil:
		return 0
	case string:
		if strings.TrimSpace(value) == "" {
			return 0
		}
		return 1
	case []any:
		return len(value)
	default:
		return 1
	}
}

func meteorAllImageReferences(value any) int {
	count := 0
	switch value := value.(type) {
	case map[string]any:
		for name, child := range value {
			if meteorReferenceFields[strings.ToLower(name)] {
				count += meteorReferenceCount(child)
			} else {
				count += meteorAllImageReferences(child)
			}
		}
	case []any:
		for _, child := range value {
			count += meteorAllImageReferences(child)
		}
	}
	return count
}

func meteorHasImageGeneration(value any) bool {
	switch value := value.(type) {
	case map[string]any:
		for key, child := range value {
			lower := strings.ToLower(key)
			if lower == "type" && strings.EqualFold(toMeteorString(child), "image_generation") {
				return true
			}
			if lower == "modalities" || lower == "responsemodalities" || lower == "response_modalities" {
				if entries, ok := child.([]any); ok {
					for _, entry := range entries {
						if strings.EqualFold(toMeteorString(entry), "image") {
							return true
						}
					}
				}
			}
			if meteorHasImageGeneration(child) {
				return true
			}
		}
	case []any:
		for _, child := range value {
			if meteorHasImageGeneration(child) {
				return true
			}
		}
	}
	return false
}

func validateMeteorAIRequest(body []byte, contentType, path string, channel model.ModelChannel, imageTask bool) error {
	imageEndpoint := path == "/images/generations" || path == "/images/edits"
	if imageTask && !imageEndpoint {
		return errors.New("图片生成仅支持 images 协议")
	}
	if imageEndpoint && (channel.Protocol != "openai" || channel.ModelCapabilities[readAIModelFromBody(body, contentType)] != "image") {
		return errors.New("当前渠道未开放 images 图片生成协议")
	}
	if strings.HasPrefix(contentType, "multipart/form-data") {
		if !imageEndpoint {
			return errors.New("当前接口不支持此格式")
		}
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return errors.New("图片请求格式无效")
		}
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		references := 0
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return errors.New("图片请求格式无效")
			}
			name := strings.ToLower(part.FormName())
			if part.FileName() != "" {
				if name != "mask" {
					references++
				}
				_, _ = io.Copy(io.Discard, part)
			} else {
				raw, err := io.ReadAll(io.LimitReader(part, (1<<20)+1))
				if err != nil || len(raw) > 1<<20 {
					return errors.New("图片请求格式无效")
				}
				value := any(string(raw))
				var parsed any
				if json.Unmarshal(raw, &parsed) == nil {
					value = parsed
				}
				if err := meteorValidateValues(map[string]any{name: value}, 4); err != nil {
					return err
				}
				references += meteorAllImageReferences(map[string]any{name: value})
			}
			_ = part.Close()
		}
		if references > 4 {
			return errors.New("参考图片最多4张")
		}
		return nil
	}
	var input map[string]any
	if json.Unmarshal(body, &input) != nil {
		return errors.New("请求必须是有效JSON")
	}
	if !imageEndpoint {
		if channel.ModelCapabilities[readStringPath(input, "model")] == "image" || meteorHasImageGeneration(input) {
			return errors.New("图片生成仅支持 images 协议")
		}
		return nil
	}
	if err := meteorValidateValues(input, 4); err != nil {
		return err
	}
	if meteorAllImageReferences(input) > 4 {
		return errors.New("参考图片最多4张")
	}
	return nil
}
