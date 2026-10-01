import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CODEBUDDY_WRITER_TOOLS, resolveCodeBuddyLaunch } from "../../src/runs/shared/codebuddy-adapter.ts";
import { runExternalCli } from "../../src/runs/shared/external-cli-runner.ts";

const enabled = process.env.PI_SUBAGENTS_CODEBUDDY_WRITER_SMOKE === "1";

test("maintainer CodeBuddy writer smoke", { skip: enabled ? undefined : "set PI_SUBAGENTS_CODEBUDDY_WRITER_SMOKE=1" }, async () => {
	// The test harness isolates HOME, which hides the operator's CodeBuddy login
	// state (~/.codebuddy). Restore the real login HOME for the spawned CLI so the
	// smoke exercises the authenticated binary; canary files still live under the
	// isolated temp cwd.
	const homeDir = process.env.HOME ?? os.homedir();
	if (!fs.existsSync(path.join(homeDir, ".codebuddy"))) {
		const realHome = os.userInfo().homedir;
		if (fs.existsSync(path.join(realHome, ".codebuddy"))) process.env.HOME = realHome;
	}
	const reportPath = process.env.PI_SUBAGENTS_CODEBUDDY_WRITER_SMOKE_REPORT;
	assert.ok(reportPath, "PI_SUBAGENTS_CODEBUDDY_WRITER_SMOKE_REPORT is required");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-codebuddy-writer-smoke-"));
	const canaryPath = path.join(dir, "write-canary.txt");
	try {
		const launch = resolveCodeBuddyLaunch({ adapter: "codebuddy-writer", command: "codebuddy" });
		const result = await runExternalCli({
			...launch,
			cwd: dir,
			prompt: `Use the Write tool to write exactly CANARY to ${canaryPath}. Then report completion.`,
			asyncDir: dir,
			stepIndex: 0,
		});
		const writeCanaryExists = fs.existsSync(canaryPath);
		const writeCanaryMatches = writeCanaryExists && fs.readFileSync(canaryPath, "utf-8").trim() === "CANARY";
		const report = {
			adapter: "codebuddy-writer",
			adapterVersion: 1,
			access: "workspace-write",
			authentication: "existing-cli-required",
			cliVersion: result.preflight?.version,
			cwd: dir,
			permissionMode: "acceptEdits",
			tools: CODEBUDDY_WRITER_TOOLS,
			mcp: "empty-strict",
			settingSources: "user",
			userSettingsTrust: "required",
			sessionPersistence: false,
			exitCode: result.exitCode,
			terminalState: result.parserTerminal?.state,
			writeCanaryExists,
			writeCanaryMatches,
			stdoutPath: result.externalProcess.stdoutPath,
			stderrPath: result.externalProcess.stderrPath,
			durationMs: result.externalProcess.durationMs,
		};
		fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.parserTerminal?.state, "completed");
		assert.equal(writeCanaryMatches, true, "CodeBuddy did not write the expected canary");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
