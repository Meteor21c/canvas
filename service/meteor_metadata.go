package service

import (
	"encoding/json"
	"errors"
	"strings"
)

// MeteorValidateMetadata prevents durable Canvas documents from becoming a
// credential store or retaining binary inline media. User content is otherwise
// preserved, including original node types and agent state.
func MeteorValidateMetadata(raw []byte) error {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return errors.New("项目数据格式无效")
	}
	var walk func(any, int) error
	walk = func(v any, depth int) error {
		if depth > 80 {
			return errors.New("项目层级过深")
		}
		switch x := v.(type) {
		case map[string]any:
			for key, child := range x {
				normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(key))
				switch normalized {
				case "apikey", "authorization", "accesstoken", "refreshtoken", "password", "passwordhash", "clientsecret", "jwtsecret", "signingsecret":
					if child != nil && child != "" {
						return errors.New("项目不能包含密钥或登录凭证")
					}
				}
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range x {
				if err := walk(child, depth+1); err != nil {
					return err
				}
			}
		case string:
			if strings.HasPrefix(x, "data:") || strings.HasPrefix(x, "blob:") {
				return errors.New("请先上传素材，项目不能保存内联文件或临时地址")
			}
			if MeteorRedact(x) != x {
				return errors.New("项目不能包含密钥或登录凭证")
			}
		}
		return nil
	}
	return walk(value, 0)
}
