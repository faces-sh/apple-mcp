import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as nodePath from "node:path";
import { PermissionError } from "./native";

// The one seam to the compiled EventKit helper (dist/eventkit-helper), which owns ALL reminders
// and calendar access. Scripting those apps over Apple Events costs ~5 seconds PER LIST per query
// (a 50-list reminders store made every search blow its budget and read as "no matches");
// EventKit runs one indexed query over the whole store in well under a second, and supports what
// scripting cannot: recurrence rules. The helper lives next to the bundled dist/index.js; dates
// cross as epoch ms IN, local-time ISO strings OUT.
//
// A permission denial comes back as {error, denied:true} and is thrown as a typed PermissionError
// (denied != empty != broke); every other helper failure throws a plain Error with the helper's
// own message. There is deliberately NO fallback path: two implementations of the same contract
// is how silent divergence happens.

const HELPER_PATH = nodePath.join(
	nodePath.dirname(fileURLToPath(import.meta.url)),
	"eventkit-helper",
);

/** A simple repeat rule, e.g. {frequency:"daily"} or {frequency:"weekly", interval:2}. */
export interface Recurrence {
	frequency: "daily" | "weekly" | "monthly" | "yearly";
	interval?: number;
}

export function isRecurrence(value: unknown): value is Recurrence {
	if (typeof value !== "object" || value === null) return false;
	const v = value as { frequency?: unknown; interval?: unknown };
	return (
		typeof v.frequency === "string" &&
		["daily", "weekly", "monthly", "yearly"].includes(v.frequency) &&
		(v.interval === undefined || typeof v.interval === "number")
	);
}

export function runEventKit<T>(
	domain: "reminders" | "calendar",
	op: string,
	payload?: Record<string, unknown>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const argv = [domain, op];
		if (payload !== undefined) argv.push(JSON.stringify(payload));
		execFile(
			HELPER_PATH,
			argv,
			{ timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
			(err, stdout) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(stdout);
				} catch (_unparseable) {
					reject(
						new Error(
							`eventkit-helper ${domain} ${op} failed: ${err ? err.message : "unparseable output"}`,
						),
					);
					return;
				}
				if (parsed && typeof parsed === "object" && "error" in parsed) {
					const failure = parsed as { error: unknown; denied?: unknown };
					if (failure.denied === true) {
						reject(new PermissionError(String(failure.error)));
					} else {
						reject(new Error(String(failure.error)));
					}
					return;
				}
				resolve(parsed as T);
			},
		);
	});
}
