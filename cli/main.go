// gtgw —— Serverless AI Gateway 官方命令行工具。
//
// 版本与 commit 在构建时通过 -ldflags 注入（见 step2 §构建与版本注入）：
//
//	CGO_ENABLED=0 go build -trimpath \
//	  -ldflags "-s -w -X main.version=1.9.1-beta1 -X main.commit=abc1234" -o dist/gtgw .
package main

import (
	"context"
	"os"

	"github.com/alexazhou/gt_ai_gateway/cli/cmd"
)

// version / commit 由构建脚本注入；开发态为 dev / 空。
var (
	version = "dev"
	commit  = ""
)

func main() {
	app := cmd.NewApp(os.Stdout, os.Stderr, os.Getenv, version, commit)
	os.Exit(app.Execute(context.Background(), os.Args[1:]))
}
