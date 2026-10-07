import { afterAll, afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Note = [string, string | undefined];

const UPSTREAM_LINE = "TPS 10.0 tok/s. Cache hit 50.0%, 1.0s";
const UPSTREAM_SOURCE = `export default function (pi) {
	pi.on("agent_end", (_event, ctx) => { if (ctx.hasUI) ctx.ui.notify(${JSON.stringify(UPSTREAM_LINE)}, "info"); });
}
`;

const temps: string[] = [];
afterAll(() => {
	for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
	setSystemTime();
});

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "tps-plus-test-"));
	temps.push(dir);
	return dir;
}

function makePi() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	};
	const emit = async (name: string, event: unknown, ctx?: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	return { pi, emit, handlers };
}

function makeCtx(model?: unknown) {
	const notes: Note[] = [];
	class Ctx {
		#ui = true;
		model = model;
		get hasUI() {
			return this.#ui;
		}
		ui = { notify: (message: string, level?: string) => notes.push([message, level]) };
	}
	return { ctx: new Ctx(), notes };
}

function fakeUpstream(pi: { on(name: string, handler: Handler): void }) {
	pi.on("agent_end", (_event, ctx) => {
		const c = ctx as { hasUI: boolean; ui: { notify(m: string, l: string): void } };
		if (c.hasUI) c.ui.notify(UPSTREAM_LINE, "info");
	});
}

async function load(name: string, senpi: Record<string, unknown>, piAi: Record<string, unknown> = {}) {
	mock.module("@code-yeongyu/senpi", () => ({ getPackageDir: undefined, ...senpi }));
	mock.module("@earendil-works/pi-ai", () => ({ resolvePromptCacheTtlSeconds: undefined, ...piAi }));
	return import(`../extension/tps.js?case=${name}`);
}

const reply = { message: { role: "assistant" } };

describe("wrap", () => {
	test("appends when the last reply started and when the model's cache expires", async () => {
		const { wrap } = await load("wrap", {}, { resolvePromptCacheTtlSeconds: (model: { ttl: number }) => model.ttl });
		const { pi, emit } = makePi();
		const { ctx, notes } = makeCtx({ ttl: 3600 });
		wrap(pi, fakeUpstream);
		await emit("agent_start", {});
		setSystemTime(new Date(2026, 9, 7, 14, 32, 5));
		await emit("message_start", reply);
		setSystemTime(new Date(2026, 9, 7, 14, 33, 9));
		await emit("message_start", { message: { role: "user" } });
		await emit("message_start", reply);
		await emit("message_start", { message: { role: "toolResult" } });
		await emit("agent_end", { messages: [] }, ctx);
		expect(notes).toEqual([[`${UPSTREAM_LINE}. 14:33:09, cache till 15:33`, "info"]]);
	});

	for (const [name, resolve] of [
		["no-ttl", () => undefined],
		["ttl-throws", () => {
			throw new Error("boom");
		}],
	] as const) {
		test(`shows only the reply time when the model has no known cache TTL (${name})`, async () => {
			const { wrap } = await load(name, {}, { resolvePromptCacheTtlSeconds: resolve });
			const { pi, emit } = makePi();
			const { ctx, notes } = makeCtx({ id: "m" });
			wrap(pi, fakeUpstream);
			setSystemTime(new Date(2026, 9, 7, 14, 32, 5));
			await emit("message_start", reply);
			await emit("agent_end", { messages: [] }, ctx);
			expect(notes).toEqual([[`${UPSTREAM_LINE}. 14:32:05`, "info"]]);
		});
	}

	test("leaves the notice unchanged when no reply started in this run", async () => {
		const { wrap } = await load("noreply", {});
		const { pi, emit } = makePi();
		const { ctx, notes } = makeCtx();
		wrap(pi, fakeUpstream);
		await emit("message_start", reply);
		await emit("agent_start", {});
		await emit("agent_end", { messages: [] }, ctx);
		expect(notes).toEqual([[UPSTREAM_LINE, "info"]]);
	});

	test("passes other events, their context and the rest of the API through untouched", async () => {
		const { wrap } = await load("passthrough", {});
		const { pi, emit } = makePi();
		const seen: unknown[] = [];
		const extra = { ...pi, flag: 7, self() { return this; } };
		wrap(extra, (api: typeof extra) => {
			seen.push(api.flag, api.self() === extra);
			api.on("message_end", (event, ctx) => {
				seen.push(event, ctx);
			});
		});
		const event = { message: { role: "assistant" } };
		const ctx = { tag: "ctx" };
		await emit("message_end", event, ctx);
		expect(seen).toEqual([7, true, event, ctx]);
		expect(seen[3]).toBe(ctx);
	});
});

describe("default export", () => {
	test("runs the upstream tps file found under the running senpi package", async () => {
		const pkg = tempDir();
		mkdirSync(join(pkg, "dist", "core", "extensions", "builtin"), { recursive: true });
		writeFileSync(join(pkg, "dist", "core", "extensions", "builtin", "tps.js"), UPSTREAM_SOURCE);
		const mod = await load("found", { getPackageDir: () => pkg });
		const { pi, emit, handlers } = makePi();
		const { ctx, notes } = makeCtx();
		await mod.default(pi);
		expect(handlers.has("session_start")).toBe(false);
		setSystemTime(new Date(2026, 9, 7, 9, 5, 0));
		await emit("agent_start", {});
		await emit("message_start", reply);
		await emit("agent_end", { messages: [] }, ctx);
		expect(notes).toEqual([[`${UPSTREAM_LINE}. 09:05:00`, "info"]]);
	});

	test("prefers the flat layout when the package dir is dist itself", async () => {
		const { upstreamPath } = await load("flat", {});
		const pkg = tempDir();
		mkdirSync(join(pkg, "core", "extensions", "builtin"), { recursive: true });
		writeFileSync(join(pkg, "core", "extensions", "builtin", "tps.js"), UPSTREAM_SOURCE);
		expect(upstreamPath(pkg)).toBe(join(pkg, "core", "extensions", "builtin", "tps.js"));
	});

	for (const [name, senpi] of [
		["missing-file", { getPackageDir: () => tempDir() }],
		["missing-api", {}],
	] as const) {
		test(`warns once at session start and registers nothing else when upstream is unavailable (${name})`, async () => {
			const mod = await load(name, senpi);
			const { pi, emit, handlers } = makePi();
			const { ctx, notes } = makeCtx();
			await mod.default(pi);
			expect([...handlers.keys()]).toEqual(["session_start"]);
			await emit("session_start", {}, ctx);
			expect(notes).toHaveLength(1);
			expect(notes[0][0]).toStartWith("tps: senpi tps not loaded");
			expect(notes[0][1]).toBe("warning");
		});
	}
});
