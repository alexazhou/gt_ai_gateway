package cmd

import (
	"encoding/json"
	"testing"
)

// TestYuanFromMicro 钉住「微元 → 元」的展示换算：差 1e6 倍是静默错误，只有断言具体字符串才看得见。
func TestYuanFromMicro(t *testing.T) {
	cases := []struct {
		units float64
		want  string
	}{
		{1_000_000, "1"},
		{-500_000, "-0.5"},
		{1_230_000, "1.23"},
		{0, "0"},
		{1, "0.000001"},
	}
	for _, c := range cases {
		if got := yuanFromMicro(c.units); got != c.want {
			t.Fatalf("yuanFromMicro(%v) = %q, 期望 %q", c.units, got, c.want)
		}
	}
}

// TestRewriteAmountToYuan 覆盖后端的三种响应形态：{list,total}、裸数组（充值记录列表就是它）、单对象。
func TestRewriteAmountToYuan(t *testing.T) {
	t.Run("裸数组", func(t *testing.T) {
		out := rewriteAmountToYuan([]byte(`[{"id":3,"amount":1000000},{"id":4,"amount":-500000}]`))
		var got []map[string]any
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("输出不是合法 JSON：%s", out)
		}
		if got[0]["amount"] != "1" || got[1]["amount"] != "-0.5" {
			t.Fatalf("amount 未换算成元：%v", got)
		}
	})

	t.Run("{list,total}", func(t *testing.T) {
		out := rewriteAmountToYuan([]byte(`{"list":[{"id":3,"amount":1230000}],"total":1}`))
		var got struct {
			List  []map[string]any `json:"list"`
			Total int              `json:"total"`
		}
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("输出不是合法 JSON：%s", out)
		}
		if got.List[0]["amount"] != "1.23" || got.Total != 1 {
			t.Fatalf("amount/total 处理有误：%v", got)
		}
	})

	t.Run("单对象", func(t *testing.T) {
		out := rewriteAmountToYuan([]byte(`{"id":3,"amount":1000000}`))
		var got map[string]any
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("输出不是合法 JSON：%s", out)
		}
		if got["amount"] != "1" {
			t.Fatalf("amount 未换算成元：%v", got)
		}
	})

	t.Run("无 amount / 非 JSON 原样返回", func(t *testing.T) {
		if got := string(rewriteAmountToYuan([]byte(`{"id":3}`))); got != `{"id":3}` {
			t.Fatalf("无 amount 时应原样返回，实际 %q", got)
		}
		if got := string(rewriteAmountToYuan([]byte("not-json"))); got != "not-json" {
			t.Fatalf("非 JSON 应原样返回，实际 %q", got)
		}
	})
}
