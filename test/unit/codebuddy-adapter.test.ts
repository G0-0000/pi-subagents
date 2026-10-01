import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll, resolveAgentName } from "../../src/agents/agents.ts";
import { CODEBUDDY_ADAPTER_ID, CODEBUDDY_ENV_ALLOWLIST, CODEBUDDY_WRITER_ADAPTER_ID, CODEBUDDY_WRITER_TOOLS, createCodeBuddyJsonlParser, resolveCodeBuddyLaunch } from "../../src/runs/shared/codebuddy-adapter.ts";
import { externalCliReceiptMetadata, resolveExternalCliRunnerStatus } from "../../src/runs/shared/external-cli-contract.ts";
import { formatHerdrMachineRunnerUnsupported } from "../../src/runs/shared/herdr-machine.ts";
import { clearExternalCliPreflightCacheForTests } from "../../src/runs/shared/external-cli-preflight.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";
import { buildWorkflowReceipt, readWorkflowReceipt, writeWorkflowReceipt } from "../../src/workflows/workflow-receipt.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-codebuddy-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	clearExternalCliPreflightCacheForTests();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCodeBuddyScript(dir: string): string {
	const scriptPath = path.join(dir, "fake-codebuddy.cjs");
	fs.writeFileSync(scriptPath, String.raw`
+const args = process.argv.slice(2);
+if (args[0] === "--version") { console.log("2.161.0"); process.exit(0); }
+if (args[0] === "--help") {
+  console.log("Usage: codebuddy [options] [command] [prompt]");
+  console.log("CodeBuddy Code - starts an interactive session by default, use -p/--print for");
+  console.log("--print --input-format text --output-format stream-json --verbose --permission-mode plan acceptEdits --tools --strict-mcp-config --mcp-config --setting-sources --no-session-persistence");
+  process.exit(0);
+}
+let prompt = "";
+process.stdin.on("data", chunk => prompt += chunk);
+process.stdin.on("end", () => {
+  if (prompt.includes("malformed")) return process.stdout.write("{bad json}\n");
+  if (prompt.includes("oversized")) return process.stdout.write(JSON.stringify({type:"assistant", value:"x".repeat(300000)}) + "\n");
+  process.stdout.write(JSON.stringify({type:"system", subtype:"init"}) + "\n");
+  if (prompt.includes("missing-terminal")) return;
+  if (prompt.includes("auth-error")) return process.stdout.write(JSON.stringify({type:"result", subtype:"error_during_execution", is_error:true, errors:["authentication required"]}) + "\n");
+  if (prompt.includes("max-turns")) return process.stdout.write(JSON.stringify({type:"result", subtype:"error_max_turns", is_error:true, result:"partial"}) + "\n");
+  if (prompt.includes("budget")) return process.stdout.write(JSON.stringify({type:"result", subtype:"error_max_budget_usd", is_error:true, result:"partial"}) + "\n");
+  if (prompt.includes("missing-text")) return process.stdout.write(JSON.stringify({type:"result", subtype:"success", is_error:false, result:""}) + "\n");
+  process.stdout.write(JSON.stringify({type:"assistant", message:{content:[{type:"text", text:"untrusted partial"}]}}) + "\n");
+  process.stdout.write(JSON.stringify({type:"result", subtype:"success", is_error:false, result:"trusted final result", session_id:"not-persisted"}) + "\n");
+  process.stdout.write(JSON.stringify({type:"system", subtype:"init"}) + "\n");
+  if (prompt.includes("duplicate-terminal")) process.stdout.write(JSON.stringify({type:"result", subtype:"success", is_error:false, result:"duplicate"}) + "\n");
+});
+`.replace(/^\+/gm, ""), "utf-8");
	return scriptPath;
}

async function runFake(dir: string, stepIndex: number, prompt: string, adapter: typeof CODEBUDDY_ADAPTER_ID | typeof CODEBUDDY_WRITER_ADAPTER_ID = CODEBUDDY_ADAPTER_ID) {
	const scriptPath = fakeCodeBuddyScript(dir);
	const launch = resolveCodeBuddyLaunch({ adapter, command: process.execPath, commandPrefixArgs: [scriptPath] });
	const result = await runExternalCli({ ...launch, cwd: dir, prompt, asyncDir: dir, stepIndex });
	return { launch, result };
}

describe("CodeBuddy adapter", () => {
	it("owns no-tools argv, stdin delivery, launch preflight, and terminal result proof", async () => {
		const dir = tempDir();
		const { launch, result } = await runFake(dir, 0, "review $HOME; echo nope");
		assert.deepEqual(launch.args.slice(1), [
			"-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan",
			"--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--no-session-persistence",
		]);
		assert.equal(launch.args.some((arg) => /dangerously|bypassPermissions|acceptEdits|--bare|--resume|--continue|--no-chrome|--disable-slash-commands/.test(arg)), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(result.preflight?.version, "2.161.0");
	});

	it("passes the local identity and temporary-directory keys required by CLI login", () => {
		assert.equal(CODEBUDDY_ENV_ALLOWLIST.includes("USER"), true);
		assert.equal(CODEBUDDY_ENV_ALLOWLIST.includes("LOGNAME"), true);
		assert.equal(CODEBUDDY_ENV_ALLOWLIST.includes("TMPDIR"), true);
		assert.equal(CODEBUDDY_ENV_ALLOWLIST.includes("HOME"), true);
	});

	it("owns explicit file writer argv without permission bypass or MCP", async () => {
		const dir = tempDir();
		const { launch, result } = await runFake(dir, 9, "write the requested file", CODEBUDDY_WRITER_ADAPTER_ID);
		assert.deepEqual(launch.args.slice(1), [
			"-p", "--input-format", "text", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
			"--tools", CODEBUDDY_WRITER_TOOLS, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--no-session-persistence",
		]);
		assert.equal(launch.args.some((arg) => /dangerously|bypassPermissions|--bare|--resume|--continue|\bBash\b|--no-chrome|--disable-slash-commands/.test(arg)), false);
		assert.equal(result.exitCode, 0);
		assert.equal(result.output, "trusted final result");
	});

	it("fails closed on malformed, oversized, auth, limit, EOF, missing-text, and duplicate terminal output", async () => {
		const dir = tempDir();
		for (const [index, prompt, pattern] of [
			[1, "malformed", /malformed JSONL/],
			[2, "oversized", /line exceeded/],
			[3, "auth-error", /authentication required/],
			[4, "max-turns", /partial/],
			[5, "budget", /partial/],
			[6, "missing-terminal", /did not produce a terminal state/],
			[7, "missing-text", /terminal result success/],
			[8, "duplicate-terminal", /duplicate terminal result/],
		] as const) {
			const { result } = await runFake(dir, index, prompt);
			assert.equal(result.exitCode, 1, prompt);
			assert.match(result.error ?? "", pattern, prompt);
		}
	});

	it("rejects unsupported version and incomplete help during launch preflight", () => {
		const launch = resolveCodeBuddyLaunch({ adapter: CODEBUDDY_ADAPTER_ID, command: "codebuddy" });
		const help = "CodeBuddy Code - starts an interactive session --print --input-format stream-json --verbose --permission-mode plan --tools --strict-mcp-config --mcp-config --setting-sources --no-session-persistence";
		const evidence = { binaryPath: "/tmp/codebuddy", binaryMtimeMs: 1, version: "2.161.0", help, cacheHit: false };
		assert.doesNotThrow(() => launch.preflight.validate?.({ ...evidence, version: "2.161.0-beta.1" }));
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "CodeBuddy 2.161.0" }), /Unsupported CodeBuddy version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, version: "2.161" }), /Unsupported CodeBuddy version response/);
		assert.throws(() => launch.preflight.validate?.({ ...evidence, help: "CodeBuddy Code - starts an interactive session --print" }), /does not document required option/);
	});

	it("accepts non-terminal trailers including a trailing duplicate init but rejects duplicate result events", () => {
		const parser = createCodeBuddyJsonlParser();
		parser.parseLine('{"type":"result","subtype":"success","is_error":false,"result":"done"}');
		assert.doesNotThrow(() => parser.parseLine('{"type":"system","subtype":"init"}'));
		assert.doesNotThrow(() => parser.parseLine('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"trailer"}]}}'));
		assert.throws(() => parser.parseLine('{"type":"result","subtype":"success","is_error":false,"result":"again"}'), /duplicate terminal result/);
	});

	it("publishes compact CodeBuddy safety receipt metadata", () => {
		const runner = resolveExternalCliRunnerStatus({ adapter: "codebuddy", command: "codebuddy" });
		const metadata = externalCliReceiptMetadata({ runner, externalProcess: { startedAt: 1, stdoutPath: "/tmp/stdout", stderrPath: "/tmp/stderr" } });
		const receipt = buildWorkflowReceipt({
			workflowRunId: "codebuddy-workflow",
			state: "complete",
			children: [{ key: "codebuddy", ok: true, output: "done", resumability: { state: "not-resumable", reason: metadata.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: metadata, results: [], artifactPaths: [] }],
		});
		const root = tempDir();
		const runDir = path.join(root, receipt.workflowRunId);
		fs.mkdirSync(runDir);
		writeWorkflowReceipt(runDir, receipt);
		const persisted = readWorkflowReceipt(root, receipt.workflowRunId);
		assert.equal(persisted.entries.codebuddy?.externalAdapter?.adapter.id, "codebuddy");
		assert.deepEqual(persisted.entries.codebuddy?.externalAdapter?.safety, { access: "read-only", authentication: "existing-cli-required", permissionMode: "plan", tools: "none", mcp: "empty-strict", settingSources: "user", userSettingsTrust: "required", sessionPersistence: false });
		assert.doesNotMatch(JSON.stringify(receipt), /trusted final result|session_id|rawOutput/);
	});

	it("publishes strict writer safety metadata and reads persisted writer receipts", () => {
		const writer = externalCliReceiptMetadata({ runner: resolveExternalCliRunnerStatus({ adapter: "codebuddy-writer", command: "codebuddy" }) });
		assert.deepEqual(writer.safety, { access: "workspace-write", authentication: "existing-cli-required", permissionMode: "acceptEdits", tools: CODEBUDDY_WRITER_TOOLS, mcp: "empty-strict", settingSources: "user", userSettingsTrust: "required", sessionPersistence: false });

		const root = tempDir();
		const writerDir = path.join(root, "writer");
		fs.mkdirSync(writerDir);
		const writerReceipt = buildWorkflowReceipt({
			workflowRunId: "writer",
			state: "complete",
			children: [{ key: "codebuddy", ok: true, output: "done", resumability: { state: "not-resumable", reason: writer.nonResumableReason }, continuation: { runIds: [] }, externalAdapter: writer, results: [], artifactPaths: [] }],
		});
		writeWorkflowReceipt(writerDir, writerReceipt);
		assert.deepEqual(readWorkflowReceipt(root, "writer").entries.codebuddy?.externalAdapter?.safety, writer.safety);
		fs.writeFileSync(path.join(writerDir, "workflow-receipt.json"), JSON.stringify(writerReceipt, (key, value) => key === "tools" ? "Bash" : value), "utf-8");
		assert.throws(() => readWorkflowReceipt(root, "writer"), /externalAdapter\.safety is invalid/);
	});

	it("discovers the built-in profile without probing CodeBuddy", () => {
		const agents = discoverAgentsAll(tempDir()).builtin;
		assert.deepEqual(agents.find((candidate) => candidate.name === "codebuddy")?.runner, { type: "external-cli", adapter: "codebuddy", command: "codebuddy", promptDelivery: "stdin" });
		assert.deepEqual(agents.find((candidate) => candidate.name === "codebuddy-writer")?.runner, { type: "external-cli", adapter: "codebuddy-writer", command: "codebuddy", promptDelivery: "stdin" });
	});

	it("rejects user and project shadows that widen the read-only profile", () => {
		const project = tempDir();
		const userRoot = tempDir();
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const definition = `---\nname: codebuddy\ndescription: Unsafe CodeBuddy shadow\nrunner:\n  type: external-cli\n  adapter: codebuddy-writer\n  command: codebuddy\n---\nWrite.\n`;
		try {
			process.env.PI_CODING_AGENT_DIR = userRoot;
			fs.mkdirSync(path.join(userRoot, "agents"), { recursive: true });
			fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
			fs.writeFileSync(path.join(userRoot, "agents", "codebuddy.md"), definition, "utf-8");
			fs.writeFileSync(path.join(project, ".pi", "agents", "codebuddy.md"), definition, "utf-8");

			const discovered = discoverAgentsAll(project);
			assert.equal(discovered.user.some((candidate) => candidate.name === "codebuddy"), false);
			assert.equal(discovered.project.some((candidate) => candidate.name === "codebuddy"), false);
			for (const source of ["user", "project"] as const) {
				assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.source === source && diagnostic.name === "codebuddy")?.error ?? "", /reserved for the read-only 'codebuddy' adapter/);
			}
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});

	it("keeps disabled read-only selection reserved across local names and aliases", () => {
		const project = tempDir();
		const userRoot = tempDir();
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const packageRoot = path.join(project, ".pi", "npm", "node_modules", "unsafe-codebuddy-package");
		try {
			process.env.PI_CODING_AGENT_DIR = userRoot;
			fs.mkdirSync(path.join(userRoot, "agents"), { recursive: true });
			fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
			fs.mkdirSync(path.join(packageRoot, "agents"), { recursive: true });
			fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ subagents: { agentOverrides: { "codebuddy": { disabled: true } } } }), "utf-8");
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "unsafe-codebuddy-package", "pi-subagents": { agents: ["./agents"] } }), "utf-8");
			fs.writeFileSync(path.join(packageRoot, "agents", "codebuddy.md"), `---\nname: codebuddy\npackage: unsafe-mode\ndescription: Unsafe package local name\nrunner:\n  type: external-cli\n  adapter: codebuddy-writer\n  command: codebuddy\n---\nWrite.\n`, "utf-8");
			fs.writeFileSync(path.join(project, ".pi", "agents", "project-writer.md"), `---\nname: project-writer\naliases: codebuddy\ndescription: Unsafe project alias\nrunner:\n  type: external-cli\n  adapter: codebuddy-writer\n  command: codebuddy\n---\nWrite.\n`, "utf-8");
			fs.writeFileSync(path.join(userRoot, "agents", "user-writer.md"), `---\nname: user-writer\naliases: codebuddy\ndescription: Unsafe user alias\nrunner:\n  type: external-cli\n  adapter: codebuddy-writer\n  command: codebuddy\n---\nWrite.\n`, "utf-8");

			const all = discoverAgentsAll(project);
			for (const [source, name] of [["package", "codebuddy"], ["project", "project-writer"], ["user", "user-writer"]] as const) {
				assert.match(all.agentDiagnostics?.find((diagnostic) => diagnostic.source === source && diagnostic.name === name)?.error ?? "", /Selection name 'codebuddy' is reserved/);
			}
			const effective = discoverAgents(project, "both").agents;
			assert.equal(resolveAgentName("codebuddy", effective).agent, undefined);
			const writer = resolveAgentName("codebuddy-writer", effective).agent;
			assert.equal(writer?.runner?.type === "external-cli" ? writer.runner.adapter : undefined, "codebuddy-writer");
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		}
	});

	it("rejects frontmatter argv that would widen the packaged adapter", () => {
		const dir = tempDir();
		const agentsDir = path.join(dir, ".pi", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, "unsafe.md"), `---\nname: unsafe\ndescription: Unsafe override\nrunner:\n  type: external-cli\n  adapter: codebuddy\n  command: codebuddy\n  args: ["--dangerously-skip-permissions"]\n---\nReview.\n`, "utf-8");
		fs.writeFileSync(path.join(agentsDir, "unsafe-writer.md"), `---\nname: unsafe-writer\ndescription: Unsafe writer override\nrunner:\n  type: external-cli\n  adapter: codebuddy-writer\n  command: codebuddy\n  args: ["--tools", "Bash"]\n---\nWrite.\n`, "utf-8");
		const discovered = discoverAgentsAll(dir);
		assert.equal(discovered.project.some((candidate) => candidate.name === "unsafe"), false);
		assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "unsafe")?.error ?? "", /codebuddy adapter owns its argv/);
		assert.equal(discovered.project.some((candidate) => candidate.name === "unsafe-writer"), false);
		assert.match(discovered.agentDiagnostics?.find((diagnostic) => diagnostic.name === "unsafe-writer")?.error ?? "", /codebuddy-writer adapter owns its argv/);
	});

	it("rejects CodeBuddy runners bound to a Herdr machine before dispatch", () => {
		const machine = { provider: "herdr" as const, id: "m1", target: "ssh m1", cwd: "/tmp" };
		const status = resolveExternalCliRunnerStatus({ adapter: "codebuddy", command: "codebuddy", machine });
		assert.equal(status.adapter.id, "codebuddy");
		assert.equal(status.adapter.executionMode, "one-shot-stdin");
		const message = formatHerdrMachineRunnerUnsupported({ machine: "m1", agentName: "codebuddy", runnerType: "external-cli", adapter: "codebuddy" });
		assert.match(message ?? "", /CodeBuddy runs on this machine only/);
	});
});
