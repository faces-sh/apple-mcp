// Shared helpers for driving the native macOS apps these tools control.
//
// Two jobs, defined once and reused by every util module:
//   1. Honest failures. macOS TCC can deny Automation / Contacts / Full Disk Access, and an Apple app
//      can simply not be running. Neither may EVER be returned as an empty result, because that masks
//      a fixable problem as "you have no data" (Faces charter #2: surface errors loudly; denied is not
//      empty). We classify what Apple Events said and raise a typed `ToolFailure` carrying the code,
//      the sentence a person reads, and osascript's own output verbatim.
//   2. Safe interpolation. Any user-controlled value embedded in an AppleScript source string must
//      be escaped. Prefer @jxa/run with *passed arguments* (no source interpolation at all); use the
//      escape helper only where an AppleScript string literal is unavoidable.

import { PermissionError, ToolFailure, rawBody } from "./failure";

export { PermissionError, ToolFailure };

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
		msg.includes("-1743") || // errAEEventNotPermitted - Automation denied / never prompted
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
 * Does this error mean the Apple app is not running (or could not be reached)? Distinct from a denial:
 * the grant is fine, there is simply nothing on the other end of the Apple Event. Apple reports it as
 * procNotFound (-600) or connectionInvalid (-609), or in words on newer systems.
 */
export function isAppNotRunning(error: unknown): boolean {
	const msg = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	return (
		msg.includes("-600") || // procNotFound
		msg.includes("-609") || // connectionInvalid
		msg.includes("isn't running") ||
		msg.includes("is not running") ||
		msg.includes("can't be launched") ||
		msg.includes("cannot be launched")
	);
}

/**
 * Did the Apple app take the event and then never answer? Apple reports it as errAETimeout (-1712).
 * Its own case because it is the one failure here where trying again could work: nothing is wrong
 * with the request, the grant, or the app, it was just busy.
 */
export function isAppleEventTimeout(error: unknown): boolean {
	const msg = (
		error instanceof Error ? error.message : String(error)
	).toLowerCase();
	return msg.includes("-1712") || msg.includes("appleevent timed out");
}

/**
 * Classify an error out of Apple Events into the code that belongs on its envelope. Fails towards
 * `applescript_error`: a WRONG code is worse than a vague one, because a code drives what the caller
 * does next.
 */
export function classifyAppleError(
	error: unknown,
): "permission_denied" | "app_not_running" | "timeout" | "applescript_error" {
	if (isPermissionDenial(error)) return "permission_denied";
	if (isAppNotRunning(error)) return "app_not_running";
	if (isAppleEventTimeout(error)) return "timeout";
	return "applescript_error";
}

/**
 * Re-throw an Apple Events failure as a typed `ToolFailure`, with osascript's own output kept verbatim
 * as the body. `summaries` supplies the one plain sentence for each outcome; the caller writes those
 * because only the caller knows which operation did not happen.
 *
 * A `ToolFailure` already raised further down (a denial detected inside a nested scan, say) passes
 * through unchanged: it was classified where it was raised, which is the only place that knew.
 */
export function throwAppleFailure(
	error: unknown,
	summaries: {
		denied: string;
		notRunning: string;
		timedOut: string;
		failed: string;
	},
): never {
	if (error instanceof ToolFailure) throw error;
	const code = classifyAppleError(error);
	const summary =
		code === "permission_denied"
			? summaries.denied
			: code === "app_not_running"
				? summaries.notRunning
				: code === "timeout"
					? summaries.timedOut
					: summaries.failed;
	throw new ToolFailure(code, summary, rawBody(error));
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
