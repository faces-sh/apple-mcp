// Shared helpers for driving the native macOS apps these tools control.
//
// Two jobs, defined once and reused by every util module:
//   1. Honest permission errors. macOS TCC can deny Automation / Contacts / Full Disk Access. A
//      denial must NEVER be returned as an empty result — that masks a fixable permission problem
//      as "you have no data" (Faces charter #2: surface errors loudly; denied ≠ empty). We model a
//      denial as a typed `PermissionError` that propagates to the MCP layer.
//   2. Safe interpolation. Any user-controlled value embedded in an AppleScript source string must
//      be escaped. Prefer @jxa/run with *passed arguments* (no source interpolation at all); use the
//      escape helper only where an AppleScript string literal is unavoidable.

/**
 * Raised when macOS TCC denies access (Automation, Contacts, or Full Disk Access). Distinct from a
 * genuinely empty result so the dispatch layer can surface an actionable "grant permission" message
 * with `isError: true`.
 */
export class PermissionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PermissionError";
	}
}

/**
 * Heuristic: does this error thrown by osascript / @jxa/run / run-applescript indicate a TCC
 * permission denial (as opposed to a transient or logic error)? AppleScript surfaces denials as
 * negative OSStatus codes; the strings vary by macOS version, so we match the stable codes plus the
 * common phrasings.
 */
export function isPermissionDenial(error: unknown): boolean {
	const msg = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	return (
		msg.includes("-1743") || // errAEEventNotPermitted — Automation denied / never prompted
		msg.includes("-1744") || // user consent required
		msg.includes("-10004") || // privilege violation
		msg.includes("not authorized") ||
		msg.includes("not allowed") ||
		msg.includes("not permitted") ||
		msg.includes("doesn't have permission") ||
		msg.includes("does not have permission") ||
		msg.includes("permission to") ||
		msg.includes("access denied")
	);
}

/**
 * Re-throw `error` as a `PermissionError` (with an actionable message) if it looks like a TCC denial;
 * otherwise re-throw it unchanged. Lets a util `catch` distinguish "denied" from a real fault while
 * never swallowing either into an empty result.
 */
export function rethrowIfPermissionDenied(
	error: unknown,
	deniedMessage: string,
): never {
	if (isPermissionDenial(error)) {
		throw new PermissionError(deniedMessage);
	}
	throw error instanceof Error ? error : new Error(String(error));
}

/**
 * Escape a string for safe interpolation inside an AppleScript double-quoted string literal. Escapes
 * backslashes first, then double quotes. (Where possible, pass values as @jxa/run arguments instead —
 * that avoids building a source string from user input entirely.)
 */
export function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape a string for safe interpolation inside a single-quoted SQL string literal (SQLite). */
export function escapeSqlString(value: string): string {
	return value.replace(/'/g, "''");
}

/** Reduce a phone number to its digits (E.164 minus the leading +). */
export function phoneDigits(value: string): string {
	return value.replace(/\D/g, "");
}

/**
 * Loose phone equality that survives country-code differences. Two numbers match if their digit
 * strings are equal, or one is a suffix of the other and the overlap is at least the length of a
 * national subscriber number (7 digits) — so "+39 333 1234567" matches a stored "3331234567" without
 * any US/`+1` assumption.
 */
export function phonesMatch(a: string, b: string): boolean {
	const da = phoneDigits(a);
	const db = phoneDigits(b);
	if (!da || !db) return false;
	if (da === db) return true;
	const [shorter, longer] = da.length <= db.length ? [da, db] : [db, da];
	return shorter.length >= 7 && longer.endsWith(shorter);
}
