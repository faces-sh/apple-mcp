// THE UNIFORM FAILURE ENVELOPE. One shape, every tool, every failure.
//
// Every failure this server returns is `isError: true` and its text is:
//
//     [<code>] <one plain sentence: what did not happen>
//     <the underlying error output, verbatim>
//
// Line 1 is for a person and for the model. Everything after it is the evidence, byte for byte, so the
// caller can tell an expired grant from a permission that never existed. This server decides WHAT
// failed; it never decides what that MEANS, because only the caller can act on the difference.
//
// NO `HTTP <status>` LINE, EVER. The envelope spec puts a literal status line between the sentence and
// the body for an HTTP failure, and says to omit it entirely when the failure was not HTTP rather than
// invent a status. Nothing here speaks HTTP: these tools drive local Apple apps over Apple Events (JXA)
// and read the Messages store with sqlite3. So the code is always lowercase snake_case, never
// `http_<status>`, and the body follows the sentence directly.

/**
 * What failed, as something a caller can branch on. Deliberately short: a code exists here only where
 * the difference changes what somebody would do about it.
 */
export type FailureCode =
	/** macOS TCC refused: Automation, Contacts, Calendars, Reminders, or Full Disk Access. */
	| "permission_denied"
	/** The Apple app is not running and could not be reached or launched. */
	| "app_not_running"
	/** The Apple app was reached but did not answer in time. Its own code, because unlike the others
	 *  it says nothing is wrong with the request or the grant, and another attempt could work. */
	| "timeout"
	/** The named thing does not exist: a calendar, a list, a folder, an event id. */
	| "not_found"
	/** Apple Events / JXA / osascript failed for any other reason. */
	| "applescript_error"
	/** The Messages store (chat.db) could not be opened or queried. */
	| "database_error"
	/** The caller's arguments cannot be acted on. */
	| "bad_request"
	/** The app is switched off for this server via APPLE_MCP_ENABLED_APPS. */
	| "app_disabled"
	/** No tool by that name is served here. */
	| "unknown_tool"
	/** Anything else that went wrong inside this server. */
	| "internal_error";

/** Cap on the echoed body, per the envelope spec. */
const MAX_BODY = 4000;

/**
 * Values that must never leave this process, even inside a verbatim body. The envelope spec keeps the
 * body byte for byte EXCEPT for these. Nothing here currently authenticates against anything, so this
 * is a floor under future error paths rather than a live concern.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: <redacted>"],
	[
		/("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]*(")/gi,
		"$1<redacted>$2",
	],
	[
		/\b(access_token|refresh_token|client_secret)=[^\s&"']+/gi,
		"$1=<redacted>",
	],
];

/** Strip credentials from a body that is otherwise echoed verbatim. */
export function redactSecrets(body: string): string {
	let out = body;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Cap a body at MAX_BODY characters, marking the cut so nobody reads a truncation as the whole story. */
export function truncateBody(body: string): string {
	if (body.length <= MAX_BODY) return body;
	return body.slice(0, MAX_BODY) + " ...[truncated]";
}

/**
 * The underlying error output, verbatim and uninterpreted.
 *
 * Prefers what the failing process actually wrote: `stderr` for a child process (sqlite3, osascript),
 * then the error's own message. Whatever comes back is echoed as-is apart from secret redaction and the
 * length cap; it is NOT summarised, translated or classified here.
 */
export function rawBody(error: unknown): string {
	if (error && typeof error === "object") {
		const e = error as { stderr?: unknown; message?: unknown };
		const stderr =
			typeof e.stderr === "string"
				? e.stderr
				: e.stderr instanceof Buffer
					? e.stderr.toString()
					: "";
		const message = typeof e.message === "string" ? e.message : "";
		// stderr and message often carry different halves of the story (execFile puts the command in
		// the message and the tool's complaint in stderr), so keep both when both exist.
		const parts = [stderr.trim(), message.trim()].filter(Boolean);
		if (parts.length > 0) return truncateBody(redactSecrets(parts.join("\n")));
	}
	const asString = String(error).trim();
	return asString ? truncateBody(redactSecrets(asString)) : "";
}

/**
 * A failure with an assigned code, the sentence a person reads, and the provider's own output.
 *
 * Thrown by the util modules, caught once at the MCP dispatch layer and rendered by `failureResult`.
 * Every field is set where the failure is RAISED, because that is the only place that knows.
 */
export class ToolFailure extends Error {
	readonly code: FailureCode;
	/** Line 1: what did not happen, in words a person reads. Never a stack trace, never a symbol. */
	readonly summary: string;
	/** The underlying error output, verbatim. Empty when the failure had no underlying output. */
	readonly body: string;

	constructor(code: FailureCode, summary: string, body = "") {
		super(summary);
		this.name = "ToolFailure";
		this.code = code;
		this.summary = summary;
		this.body = body;
	}
}

/**
 * Raised when macOS TCC denies access (Automation, Contacts, Calendars, Reminders, or Full Disk
 * Access). A denial must NEVER be returned as an empty result: that masks a fixable permission problem
 * as "you have no data". It is a `ToolFailure` with code `permission_denied` so the dispatch layer
 * needs no special case for it.
 */
export class PermissionError extends ToolFailure {
	constructor(summary: string, body = "") {
		super("permission_denied", summary, body);
		this.name = "PermissionError";
	}
}

/** Render the envelope text for a failure. */
export function envelope(
	code: FailureCode,
	summary: string,
	body = "",
): string {
	const evidence = truncateBody(redactSecrets(body)).trim();
	return evidence ? `[${code}] ${summary}\n${evidence}` : `[${code}] ${summary}`;
}

/** The MCP result for a failure. `isError: true` is the contract; the text is the backstop. */
export function failureResult(
	code: FailureCode,
	summary: string,
	body = "",
): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return {
		content: [{ type: "text", text: envelope(code, summary, body) }],
		isError: true,
	};
}

/**
 * The MCP result for a caught error. A `ToolFailure` already carries its own code, sentence and body
 * and is rendered as raised. Anything else is an unclassified fault: it keeps `fallbackSummary` as its
 * sentence and the thrown value as its verbatim body, so nothing is lost by not having been classified.
 */
export function failureResultFrom(
	error: unknown,
	fallbackCode: FailureCode,
	fallbackSummary: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
	if (error instanceof ToolFailure) {
		return failureResult(error.code, error.summary, error.body);
	}
	return failureResult(fallbackCode, fallbackSummary, rawBody(error));
}
