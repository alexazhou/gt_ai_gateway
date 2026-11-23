package stream

import (
	"encoding/json"
	"fmt"
)

// jsonUnmarshal 是 encoding/json 的防御性包装：畸形输入只会得到 error，不会 panic。
// SSE 的 chunk 来自网络，可能被截断、可能被中间层改写，这里必须能承受任何字节序列。
func jsonUnmarshal(data []byte, out any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("stream: JSON 解析抖动：%v", r)
		}
	}()
	return json.Unmarshal(data, out)
}
