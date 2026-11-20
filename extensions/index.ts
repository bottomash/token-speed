/**
 * Token 输出速度扩展（彩虹色）
 *
 * 在 pi 的 statusline（底部状态行）显示 assistant 响应的 token 输出速度，
 * 例如 `⚡ 42.3 tok/s`，文字按字符位置着彩虹色。
 *
 * 显示会一直保留：流式输出期间实时刷新，输出结束后更新为整条消息的
 * 准确平均速度，并保留到下一次输出才更新（空闲、工具执行期间不清除）。
 *
 * 实现说明：
 * - 流式过程中按字符类别估算 token：CJK/全角字符与其余字符使用不同权重，
 *   系数由真实会话数据拟合（中位误差约 5%，优于笼统的 4 字符/token）。
 * - 统计 text、thinking、toolcall 三类输出 delta（都计入 output token）。
 * - 滑动窗口计算近期速度：每个样本的 token 视为「上一个样本到该样本」区间
 *   内产出，因此窗口内排除首个样本并以其时间戳为时长起点；
 *   采样不足时回退到累积平均，两者都不足 MIN_SPAN_MS 时不更新，
 *   避免把过短时长算成极高速率。
 * - 消息结束时（message_end）优先用真实 usage.output 计算平均速度，
 *   计时起点同样取首次产出，与流式期间的纯生成速度口径一致（不含 TTFT）。
 * - 彩虹色使用 HSL 色轮，色相按固定步长随字符位置推进（与文本长度无关，
 *   所以速度位数变化时不会整串变色），并根据 pi 主题的颜色模式
 *   （truecolor / 256color）生成对应的 ANSI 转义序列。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";
const WINDOW_MS = 2500; // 滑动窗口时长，用于计算实时速度
const RENDER_INTERVAL_MS = 150; // 状态行刷新节流，避免过于频繁地重绘
const MIN_SPAN_MS = 300; // 采样时长下限，短于此不做速度估算（避免单样本虚高）

// token 估算权重（由真实会话数据拟合：tokens ≈ 0.75 * CJK字符 + 0.35 * 其他字符）
const CJK_TOKEN_WEIGHT = 0.75; // 约 1.34 字符 ≈ 1 token
const OTHER_TOKEN_WEIGHT = 0.35; // 约 2.85 字符 ≈ 1 token
// CJK、假名、全角标点等宽字符
const WIDE_CHAR_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** 按字符类别估算 token 数（emoji 等代理对按一个字符计） */
function estimateTokens(text: string): number {
	let tokens = 0;
	for (const ch of text) {
		tokens += WIDE_CHAR_RE.test(ch) ? CJK_TOKEN_WEIGHT : OTHER_TOKEN_WEIGHT;
	}
	return tokens;
}

// ---- 彩虹色工具 ----
/** 每个着色字符的色相步长；固定值使颜色只由字符位置决定，与文本长度无关 */
const RAINBOW_STEP_DEG = 30;
/** 256 色 6x6x6 色立方的通道值 */
const CUBE = [0, 95, 135, 175, 215, 255];

/** HSL 转 RGB（h: 0-360, s/l: 0-1），返回 0-255 的 [r, g, b] */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0, g = 0, b = 0;
	if (hp < 1) { r = c; g = x; }
	else if (hp < 2) { r = x; g = c; }
	else if (hp < 3) { g = c; b = x; }
	else if (hp < 4) { g = x; b = c; }
	else if (hp < 5) { r = x; b = c; }
	else { r = c; b = x; }
	const m = l - c / 2;
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function nearestCube(v: number): number {
	let best = 0;
	for (let i = 1; i < CUBE.length; i++) {
		if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i;
	}
	return best;
}

/** RGB 映射到 256 色索引（与 pi 主题的 6x6x6 色立方近似一致） */
function rgbTo256(r: number, g: number, b: number): number {
	return 16 + 36 * nearestCube(r) + 6 * nearestCube(g) + nearestCube(b);
}

/** 按字符位置着彩虹色，返回带 ANSI 颜色码的字符串（末尾重置前景色） */
function rainbowize(text: string, mode: "truecolor" | "256color"): string {
	const chars = Array.from(text);
	let out = "";
	let colored = 0; // 已着色字符数：色相只随着色位置推进，不受空格或文本长度影响
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i];
		// 空格不着色，保持原样
		if (ch.trim() === "") {
			out += ch;
			continue;
		}
		const hue = (colored * RAINBOW_STEP_DEG) % 360;
		colored++;
		const [r, g, b] = hslToRgb(hue, 1, 0.6);
		out += mode === "truecolor"
			? `\x1b[38;2;${r};${g};${b}m${ch}`
			: `\x1b[38;5;${rgbTo256(r, g, b)}m${ch}`;
	}
	return out + "\x1b[39m";
}

export default function (pi: ExtensionAPI) {
	let streamStart = 0; // 当前 assistant 消息开始时间戳
	let firstDeltaAt = 0; // 本次消息首个输出 delta 的时间戳
	let firstDeltaTokens = 0; // 首个 delta 的估算 token 数（计时起点对应它的产出区间）
	let totalTokens = 0; // 本次消息累计估算 token 数
	let lastRender = 0; // 上次刷新状态行的时间
	let samples: Array<{ t: number; tokens: number }> = []; // 滑动窗口样本

	function reset() {
		streamStart = 0;
		firstDeltaAt = 0;
		firstDeltaTokens = 0;
		totalTokens = 0;
		lastRender = 0;
		samples = [];
	}

	/**
	 * 计算近期输出速度（tok/s）。
	 * 每个样本的 token 视为「上一个样本到该样本」区间内产出，所以窗口内排除
	 * 首个样本的 token，并以首个样本的时间戳作为时长起点；否则会把窗口外的
	 * 产出时间计入，使速度偏高 n/(n-1) 倍。
	 * 采样不足时回退到整条消息的累积平均（同样排除首个 delta）；仍不足则
	 * 返回 null，避免采样时过短把速度算得虚高。
	 */
	function liveSpeed(now: number): number | null {
		// 丢弃窗口外的旧样本，但至少保留最后一个
		while (samples.length > 1 && now - samples[0].t > WINDOW_MS) {
			samples.shift();
		}

		// 滑动窗口：至少两个样本才能测出速率
		if (samples.length >= 2) {
			const spanMs = now - samples[0].t;
			if (spanMs >= MIN_SPAN_MS) {
				let tokens = 0;
				for (let i = 1; i < samples.length; i++) tokens += samples[i].tokens;
				return tokens / (spanMs / 1000);
			}
		}

		// 采样不足：回退到自首次 delta 以后的累积平均
		if (firstDeltaAt === 0) return null;
		const totalMs = now - firstDeltaAt;
		const accumulated = totalTokens - firstDeltaTokens;
		if (totalMs < MIN_SPAN_MS || accumulated <= 0) return null;
		return accumulated / (totalMs / 1000);
	}

	function formatSpeed(speed: number): string {
		if (speed >= 100) return speed.toFixed(0);
		return speed.toFixed(1);
	}

	function showSpeed(ctx: ExtensionContext, speed: number) {
		const text = `⚡ ${formatSpeed(speed)} tok/s`;
		ctx.ui.setStatus(STATUS_KEY, rainbowize(text, ctx.ui.theme.getColorMode()));
	}

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		// 重置本次消息统计，但保留状态行上显示的上次速度
		reset();
		streamStart = Date.now();
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const ev = event.assistantMessageEvent;
		let deltaTokens = 0;
		if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
			deltaTokens = estimateTokens(ev.delta);
		}
		if (deltaTokens <= 0) return;

		const now = Date.now();
		if (firstDeltaAt === 0) {
			firstDeltaAt = now;
			firstDeltaTokens = deltaTokens;
		}
		totalTokens += deltaTokens;
		samples.push({ t: now, tokens: deltaTokens });

		// 节流：未到刷新间隔则只累积、不重绘
		if (now - lastRender < RENDER_INTERVAL_MS) return;
		lastRender = now;

		const speed = liveSpeed(now);
		if (speed !== null) showSpeed(ctx, speed);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const now = Date.now();
		// 与流式期间保持一致：计时起点取首次产出，只算纯生成阶段（不含 TTFT）
		const startedAt = firstDeltaAt > 0 ? firstDeltaAt : streamStart;
		const elapsed = (now - startedAt) / 1000;

		// 优先用真实 output token 数计算整条消息的平均速度
		let speed: number | null = null;
		const realOutput = event.message.usage?.output;
		if (typeof realOutput === "number" && realOutput > 0 && elapsed > 0) {
			speed = realOutput / elapsed;
		} else if (totalTokens > 0 && elapsed > 0) {
			speed = totalTokens / elapsed;
		}

		// 更新为准确的平均速度并保留显示（不清除）
		if (speed !== null) {
			showSpeed(ctx, speed);
		}
		reset();
	});
}
