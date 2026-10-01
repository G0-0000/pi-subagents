import { parseExternalCliJsonlEvent, type ExternalCliParser, type ExternalCliParserProgress, type ExternalCliParserTerminal } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";

const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_ERROR_LENGTH = 4_096;

export const CODEBUDDY_ADAPTER_ID = "codebuddy" as const;
export const CODEBUDDY_WRITER_ADAPTER_ID = "codebuddy-writer" as const;
export const CODEBUDDY_WRITER_TOOLS = "Read,Write,Edit,Glob,Grep" as const;
export const CODEBUDDY_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"CODEBUDDY_CONFIG_DIR",
	"CODEBUDDY_API_KEY",
	"CODEBUDDY_AUTH_TOKEN",
	"CODEBUDDY_BASE_URL",
	"CODEBUDDY_CN",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

function terminalError(event: Record<string, unknown>): string {
	for (const value of [event.error, event.result]) {
		if (typeof value === "string" && value.trim()) return value.trim().slice(0, MAX_ERROR_LENGTH);
	}
	if (Array.isArray(event.errors)) {
		const messages = event.errors.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
		if (messages.length > 0) return messages.join("; ").slice(0, MAX_ERROR_LENGTH);
	}
	const subtype = typeof event.subtype === "string" && event.subtype ? event.subtype : "unknown";
	return `CodeBuddy reported terminal result ${subtype}.`;
}

export function createCodeBuddyJsonlParser(): ExternalCliParser {
	let eventCount = 0;
	let terminal: ExternalCliParserTerminal | undefined;
	return {
		parseLine(line): ExternalCliParserProgress {
			const event = parseExternalCliJsonlEvent(line, "CodeBuddy", MAX_EVENT_TYPE_LENGTH);
			if (terminal && event.type === "result") throw new Error("CodeBuddy emitted a duplicate terminal result.");
			eventCount += 1;
			if (!terminal && event.type === "result") {
				if (event.subtype === "success" && event.is_error === false && typeof event.result === "string" && event.result.trim()) {
					terminal = { state: "completed", output: event.result.trim() };
				} else {
					terminal = { state: "failed", error: terminalError(event) };
				}
			}
			return { phase: terminal ? terminal.state : "streaming", eventCount };
		},
		finish(): ExternalCliParserTerminal | undefined {
			return terminal;
		},
	};
}

export function resolveCodeBuddyLaunch(input: {
	adapter: typeof CODEBUDDY_ADAPTER_ID | typeof CODEBUDDY_WRITER_ADAPTER_ID;
	command: string;
	/** Test-only executable prefix for a fake CodeBuddy process. */
	commandPrefixArgs?: readonly string[];
}): {
	command: string;
	args: string[];
	finalOutputPath?: undefined;
	promptFilePath?: undefined;
	temporaryDirectories?: undefined;
	environment: { allowlist: readonly string[] };
	preflight: ExternalCliPreflightSpec;
	parser: ExternalCliParser;
} {
	const writer = input.adapter === CODEBUDDY_WRITER_ADAPTER_ID;
	const prefix = [...(input.commandPrefixArgs ?? [])];
	const args = [
		...prefix,
		"-p",
		"--input-format", "text",
		"--output-format", "stream-json",
		"--verbose",
		"--permission-mode", writer ? "acceptEdits" : "plan",
		"--tools", writer ? CODEBUDDY_WRITER_TOOLS : "",
		"--strict-mcp-config",
		"--mcp-config", '{"mcpServers":{}}',
		"--setting-sources", "user",
		"--no-session-persistence",
	];
	return {
		command: input.command,
		args,
		environment: { allowlist: CODEBUDDY_ENV_ALLOWLIST },
		preflight: {
			id: input.adapter,
			versionArgs: [...prefix, "--version"],
			helpArgs: [...prefix, "--help"],
			validate(result) {
				// CodeBuddy publishes a bare semver version (`2.161.0`).
				if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(result.version)) throw new Error(`Unsupported CodeBuddy version response: ${JSON.stringify(result.version)}.`);
				for (const required of ["CodeBuddy Code - starts an interactive session", "--print", "--input-format", "stream-json", "--verbose", "--permission-mode", writer ? "acceptEdits" : "plan", "--tools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--no-session-persistence"]) {
					if (!result.help.includes(required)) throw new Error(`CodeBuddy help does not document required option ${JSON.stringify(required)}.`);
				}
			},
		},
		parser: createCodeBuddyJsonlParser(),
	};
}
