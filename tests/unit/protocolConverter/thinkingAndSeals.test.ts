import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { ReasoningEffort } from "../../../src/util/protocol/commonTypes";
import {
    buildThinkingConfigFromAnthropic,
    thinkingConfigToOpenAI,
} from "../../../src/util/protocolConverter/thinkingConfig";
import protocolConverterUtil from "../../../src/util/protocolConverter/protocolConverterUtil";
import { OpenAIToAnthropicConverter } from "../../../src/util/protocolConverter/OpenAIToAnthropicConverter";
import protocolUtils from "../../../src/util/protocolUtil/protocolUtil";

/**
 * thinking（推理强度）跨协议映射 + thinking 签名的封装/验签。
 *
 * 两件事都容易"静默降级"：档位算错 → 上游按错误预算推理（费用/质量双偏）；
 * 验签少一个分支 → 篡改过的凭据被当合法转交（跨供应商串味）。
 */

describe("thinkingConfig：budget_tokens → effort 五档映射", () => {
    const mapBudget = (budget_tokens?: number) => {
        const cfg = buildThinkingConfigFromAnthropic({ type: "enabled", budget_tokens } as any);
        return { cfg, effort: thinkingConfigToOpenAI(cfg) };
    };

    it("未给 budget_tokens → high（缺省按高档）", () => {
        expect(mapBudget(undefined).effort).toBe(ReasoningEffort.HIGH);
    });

    it("各档边界：0→none、≤1500→minimal、≤4000→low、≤7500→medium、≤12000→high、>12000→xhigh", () => {
        expect(mapBudget(0).effort).toBe(ReasoningEffort.NONE);
        expect(mapBudget(1000).effort).toBe(ReasoningEffort.MINIMAL);
        expect(mapBudget(3000).effort).toBe(ReasoningEffort.LOW);
        expect(mapBudget(5000).effort).toBe(ReasoningEffort.MEDIUM);
        expect(mapBudget(10000).effort).toBe(ReasoningEffort.HIGH);
        expect(mapBudget(20000).effort).toBe(ReasoningEffort.XHIGH);
    });

    it("精确边界：1500/4000/7500/12000 各自仍落在本档（上界含在档内）", () => {
        expect(mapBudget(1500).effort).toBe(ReasoningEffort.MINIMAL);
        expect(mapBudget(1501).effort).toBe(ReasoningEffort.LOW);
        expect(mapBudget(4000).effort).toBe(ReasoningEffort.LOW);
        expect(mapBudget(4001).effort).toBe(ReasoningEffort.MEDIUM);
        expect(mapBudget(7500).effort).toBe(ReasoningEffort.MEDIUM);
        expect(mapBudget(7501).effort).toBe(ReasoningEffort.HIGH);
        expect(mapBudget(12000).effort).toBe(ReasoningEffort.HIGH);
        expect(mapBudget(12001).effort).toBe(ReasoningEffort.XHIGH);
    });

    it("budget_tokens=0 时 enabled=false（不当作「开启了但零预算」）", () => {
        expect(mapBudget(0).cfg).toMatchObject({ enabled: false, effort: ReasoningEffort.NONE });
    });

    it("thinking.type=disabled → enabled:false / none", () => {
        const cfg = buildThinkingConfigFromAnthropic({ type: "disabled" } as any);
        expect(cfg).toEqual({ enabled: false, effort: ReasoningEffort.NONE });
    });

    it("adaptive + output_config.effort 采用显式档位；缺省回 high", () => {
        expect(thinkingConfigToOpenAI(buildThinkingConfigFromAnthropic({ type: "adaptive" } as any))).toBe(
            ReasoningEffort.HIGH,
        );
        expect(
            thinkingConfigToOpenAI(
                buildThinkingConfigFromAnthropic({ type: "adaptive" } as any, { effort: "low" } as any),
            ),
        ).toBe(ReasoningEffort.LOW);
    });

    it("未知 thinking.type 且无 output_config → undefined（不猜档位）", () => {
        expect(buildThinkingConfigFromAnthropic({ type: "weird" } as any)).toBeUndefined();
    });
});

describe("thinking 签名：封包 / 验签", () => {
    it("原样往返：同源同模型能解出 signature 与 thinking", () => {
        const token = protocolConverterUtil.sealThinkingSignature("anthropic", "sig-abc", {
            model: "claude-3",
            thinking: "some thought",
        });

        expect(protocolConverterUtil.unsealThinkingSignature(token, "anthropic", "claude-3")).toEqual({
            signature: "sig-abc",
            thinking: "some thought",
            // #297：该凭据没有 source 字段（老口径）⇒ 来源未校验；新凭据带 source 时为 true
            sourceChecked: false,
        });
    });

    it("段数不足的凭据 → null（不是 500，也不是放行）", () => {
        expect(protocolConverterUtil.unsealThinkingSignature("gt-think.onlyonepart", "anthropic")).toBeNull();
    });

    it("MAC 被改动 → null（篡改凭据不放行）", () => {
        const token = protocolConverterUtil.sealThinkingSignature("anthropic", "sig-abc", { model: "m" });
        const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");

        expect(protocolConverterUtil.unsealThinkingSignature(tampered, "anthropic", "m")).toBeNull();
    });

    it("同一凭据换给另一个模型用 → null（防跨模型串用）", () => {
        const token = protocolConverterUtil.sealThinkingSignature("anthropic", "sig-abc", { model: "model-a" });

        expect(protocolConverterUtil.unsealThinkingSignature(token, "anthropic", "model-b")).toBeNull();
    });

    it("换源使用（anthropic 凭据当 responses 用）→ null", () => {
        const token = protocolConverterUtil.sealThinkingSignature("anthropic", "sig-abc");

        expect(protocolConverterUtil.unsealThinkingSignature(token, "responses")).toBeNull();
    });

    /**
     * 用公开配置入口（THINKING_SIGNATURE_SECRET）自己算一个合法 MAC，
     * 就能把「MAC 过了但 payload 不是 JSON」这一格喂到——不是靠改实现，是靠改配置。
     */
    describe("已知密钥下自助构造：MAC 合法 + 载荷非 JSON", () => {
        const SECRET = "test-secret-for-seal-probe";
        const signRaw = (payloadB64: string) =>
            `gw_sig_v1.${payloadB64}.${createHmac("sha256", SECRET).update(payloadB64).digest("base64url")}`;

        let prevSecret: string | undefined;
        beforeEach(() => {
            prevSecret = process.env.THINKING_SIGNATURE_SECRET;
            process.env.THINKING_SIGNATURE_SECRET = SECRET;
        });
        afterEach(() => {
            if (prevSecret === undefined) delete process.env.THINKING_SIGNATURE_SECRET;
            else process.env.THINKING_SIGNATURE_SECRET = prevSecret;
        });

        it("前提校验：该密钥下 seal ↔ unseal 正常往返（证明 MAC 校验这一关确实能过）", () => {
            const token = protocolConverterUtil.sealThinkingSignature("anthropic", "sig-abc", { model: "m" });

            expect(protocolConverterUtil.unsealThinkingSignature(token, "anthropic", "m")).toEqual({
                signature: "sig-abc",
                sourceChecked: false,
            });
        });

        it("MAC 正确但载荷不是 JSON → null（结构非法不放行，而不是抛 500）", () => {
            const payloadB64 = Buffer.from("this is not json", "utf8").toString("base64url");

            expect(protocolConverterUtil.unsealThinkingSignature(signRaw(payloadB64), "anthropic")).toBeNull();
        });

        it("MAC 正确但载荷是截断的 JSON → null", () => {
            const payloadB64 = Buffer.from('{"v":1,"src":"anthropic",', "utf8").toString("base64url");

            expect(protocolConverterUtil.unsealThinkingSignature(signRaw(payloadB64), "anthropic")).toBeNull();
        });

        it("MAC 正确但载荷是二进制垃圾字节 → null（UTF-8 解不出 JSON）", () => {
            const payloadB64 = Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("base64url");

            expect(protocolConverterUtil.unsealThinkingSignature(signRaw(payloadB64), "anthropic")).toBeNull();
        });

        it("MAC 正确且载荷是合法 JSON 但非对象（null）→ null（isRecord 守卫）", () => {
            const payloadB64 = Buffer.from("null", "utf8").toString("base64url");

            expect(protocolConverterUtil.unsealThinkingSignature(signRaw(payloadB64), "anthropic")).toBeNull();
        });

        it("MAC 正确但载荷是数组 → null（isRecord 不认数组）", () => {
            const payloadB64 = Buffer.from('[{"v":1,"src":"anthropic","signature":"s"}]', "utf8").toString(
                "base64url",
            );

            expect(protocolConverterUtil.unsealThinkingSignature(signRaw(payloadB64), "anthropic")).toBeNull();
        });
    });
});

describe("零散判定点", () => {
    it("BaseConverter 默认 onUpstreamEnd() 返回空数组（未 override 的转换器不补发尾部事件）", () => {
        const converter = new OpenAIToAnthropicConverter("gpt-4");

        expect(converter.onUpstreamEnd()).toEqual([]);
    });

    it("isApiFormat 只认三种 wire format", () => {
        expect(protocolUtils.isApiFormat("openai")).toBe(true);
        expect(protocolUtils.isApiFormat("anthropic")).toBe(true);
        expect(protocolUtils.isApiFormat("responses")).toBe(true);
        expect(protocolUtils.isApiFormat("gemini")).toBe(false);
    });
});
