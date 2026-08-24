/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";

import {
	ToolFailure,
	envelope,
	failureResult,
	failureResultFrom,
	rawBody,
	redactSecrets,
	truncateBody,
} from "../utils/failure";
import {
	classifyAppleError,
	grantSentence,
	hostAppName,
	throwAppleFailure,
} from "../utils/native";

// Set BEFORE any util module is imported: each builds its permission sentences at module load, and
// every import of one below happens inside a test body. This is what Maestro passes in for real.
process.env.APPLE_MCP_APP_NAME = "Maestro";

// These tests exercise the failure envelope on paths that need NO Apple app and NO permission grant,
// so they are the same on a developer's Mac, on a locked-down Mac and in CI. The JXA boundary is
// mocked where a test needs to reach code that lives on the far side of it.

// The envelope's own shape is asserted against a literal string rather than a regex, because the
// leading `[<code>] ` is the part Maestro parses and a regex that "still matches" is how a broken
// contract passes its own test.
describe("the envelope shape", () => {
	test("code, sentence, then the body verbatim on the following lines", () => {
		const text = envelope(
			"permission_denied",
			"Could not read your contacts: macOS denied access to Contacts.",
			'execution error: Not authorized to send Apple events to Contacts. (-1743)',
		);
		expect(text).toBe(
			"[permission_denied] Could not read your contacts: macOS denied access to Contacts.\n" +
				"execution error: Not authorized to send Apple events to Contacts. (-1743)",
		);
	});

	test("no body means no trailing blank line", () => {
		expect(envelope("not_found", "Nothing matched.")).toBe(
			"[not_found] Nothing matched.",
		);
	});

	test("there is never an HTTP status line: nothing here speaks HTTP", () => {
		const text = envelope("applescript_error", "Could not read your calendar.", "boom");
		expect(text).not.toContain("HTTP");
	});

	test("isError is set on the result, and the code leads the text", () => {
		const result = failureResult("app_disabled", 'The "notes" app is not enabled on this server.');
		expect(result.isError).toBe(true);
		expect(result.content[0].text.startsWith("[app_disabled] ")).toBe(true);
	});

	test("the body is capped and the cut is marked", () => {
		const long = "x".repeat(5000);
		const capped = truncateBody(long);
		expect(capped.length).toBe(4000 + " ...[truncated]".length);
		expect(capped.endsWith(" ...[truncated]")).toBe(true);
	});

	test("credentials are stripped, the rest of the body is untouched", () => {
		const body =
			'Authorization: Bearer sk-live-abcdef\n{"access_token":"ya29.secret","scope":"contacts"}';
		const redacted = redactSecrets(body);
		expect(redacted).not.toContain("sk-live-abcdef");
		expect(redacted).not.toContain("ya29.secret");
		expect(redacted).toContain("Authorization: <redacted>");
		expect(redacted).toContain('"access_token":"<redacted>"');
		// Everything that was not a secret survives byte for byte.
		expect(redacted).toContain('"scope":"contacts"');
	});
});

// FAILURE 1 of 3: macOS TCC denies an Apple Event. This is the single most common way every tool in
// this server fails, and the one that used to come back as an empty result.
describe("a TCC permission denial", () => {
	const OSASCRIPT_DENIAL =
		"Error: Error: execution error: Not authorized to send Apple events to Contacts. (-1743)";

	test("is classified as permission_denied, not as a generic AppleScript fault", () => {
		expect(classifyAppleError(new Error(OSASCRIPT_DENIAL))).toBe("permission_denied");
	});

	test("renders as an envelope carrying osascript's own words verbatim", () => {
		let thrown: unknown;
		try {
			throwAppleFailure(new Error(OSASCRIPT_DENIAL), {
				denied: "Could not read your contacts: macOS denied access to Contacts.",
				notRunning: "Could not read your contacts: the Contacts app could not be reached.",
				timedOut: "Could not read your contacts: Contacts did not answer in time.",
				failed: "Could not read your contacts.",
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolFailure);
		const result = failureResultFrom(thrown, "internal_error", "Could not look up contacts.");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe(
			"[permission_denied] Could not read your contacts: macOS denied access to Contacts.\n" +
				OSASCRIPT_DENIAL,
		);
	});

	test("names the app AND the specific permission, because only this server knows which", async () => {
		const { CONTACTS_SUMMARIES } = await import("../utils/contacts");
		const text = failureResultFrom(
			new ToolFailure("permission_denied", CONTACTS_SUMMARIES.denied),
			"internal_error",
			"unused",
		).content[0].text;

		// The app: Maestro passes APPLE_MCP_APP_NAME in for this sentence and nothing else. It used to
		// be ignored, and the hardcoded name was "Faced", which is what the product was called BEFORE
		// the rename. Sending somebody to System Settings to look for a row that is not there is worse
		// than saying nothing.
		expect(text).toContain("Maestro");
		expect(text).not.toContain("Faced");
		// The permission: Contacts, not Automation, not Full Disk Access.
		expect(text).toContain("Contacts");
		expect(text).toContain("System Settings");
	});

	test("still guesses nothing: no try again, no reconnect", async () => {
		const { CONTACTS_SUMMARIES } = await import("../utils/contacts");
		for (const sentence of Object.values(CONTACTS_SUMMARIES)) {
			expect(sentence.toLowerCase()).not.toContain("try again");
			expect(sentence.toLowerCase()).not.toContain("reconnect");
			expect(sentence.toLowerCase()).not.toContain("later");
		}
	});

	// An invariant over EVERY denial sentence in the server, so a summaries object added later cannot
	// quietly ship without naming what is missing.
	test("EVERY denial sentence in the server names the app and a real macOS permission", async () => {
		const contacts = await import("../utils/contacts");
		const notes = await import("../utils/notes");
		const reminders = await import("../utils/reminders");
		const calendar = await import("../utils/calendar");
		const message = await import("../utils/message");

		const denials: Array<[string, string]> = [
			["contacts", contacts.CONTACTS_SUMMARIES.denied],
			["notes", notes.NOTES_SUMMARIES.denied],
			["notes create", notes.NOTES_CREATE_SUMMARIES.denied],
			["reminders", reminders.REMINDERS_SUMMARIES.denied],
			["reminders create", reminders.REMINDERS_CREATE_SUMMARIES.denied],
			["reminders open", reminders.REMINDERS_OPEN_SUMMARIES.denied],
			["calendar", calendar.CALENDAR_SUMMARIES.denied],
			["calendar open", calendar.CALENDAR_OPEN_SUMMARIES.denied],
			["calendar create", calendar.CALENDAR_CREATE_SUMMARIES.denied],
			["messages send", message.MESSAGES_SEND_SUMMARIES.denied],
			["messages read", message.MESSAGES_READ_DENIED],
		];

		// One of these is the row a person has to find in System Settings.
		const PERMISSIONS = [
			"Full Disk Access",
			"Automation",
			"Contacts",
			"Calendars",
			"Reminders",
		];

		expect(denials.length).toBe(11);
		for (const [what, sentence] of denials) {
			expect(`${what}: ${sentence}`).toContain("Maestro");
			expect(`${what}: ${sentence}`).toContain("System Settings");
			expect(
				`${what}: ${PERMISSIONS.some((p) => sentence.includes(p))}`,
			).toBe(`${what}: true`);
			// And it still says what did not happen FIRST, before any of that.
			expect(sentence.startsWith("Could not ")).toBe(true);
		}
	});

	test("reading Messages names Full Disk Access, which is the one that is NOT Automation", async () => {
		const { MESSAGES_READ_DENIED } = await import("../utils/message");
		expect(MESSAGES_READ_DENIED).toContain("Full Disk Access");
		expect(MESSAGES_READ_DENIED).not.toContain("Automation");
	});

	test("with no host app name the permission is still named, the app is just vague", () => {
		const saved = process.env.APPLE_MCP_APP_NAME;
		delete process.env.APPLE_MCP_APP_NAME;
		try {
			expect(hostAppName()).toBe("this app");
			expect(grantSentence("Full Disk Access")).toBe(
				"Enable this app under System Settings > Privacy & Security > Full Disk Access.",
			);
		} finally {
			process.env.APPLE_MCP_APP_NAME = saved;
		}
	});

	test("grantSentence names the host app and chains a second permission path", () => {
		expect(grantSentence("Contacts", "Automation > Contacts")).toBe(
			"Enable Maestro under System Settings > Privacy & Security > Contacts, " +
				"and under Automation > Contacts.",
		);
	});

	test("an app that is not running is a DIFFERENT code, because it wants a different answer", () => {
		expect(
			classifyAppleError(new Error("Application isn't running. (-600)")),
		).toBe("app_not_running");
	});

	test("an AppleEvent timeout is its own code, because another attempt could work", () => {
		// Seen live against a busy Reminders app while this change was being written, which is why it
		// is a code and not a footnote inside applescript_error.
		expect(
			classifyAppleError(
				new Error(
					"Command failed: /usr/bin/osascript -l JavaScript\nexecution error: Error: Error: AppleEvent timed out. (-1712)",
				),
			),
		).toBe("timeout");
	});
});

// FAILURE 2 of 3: a bad argument, caught before anything is touched. Runs the REAL createEvent and
// searchEvents paths end to end; neither reaches Calendar, so neither needs a grant.
describe("a bad argument", () => {
	test("createEvent rejects an unparseable start date as bad_request", async () => {
		const calendar = (await import("../utils/calendar")).default;
		let thrown: unknown;
		try {
			await calendar.createEvent("Standup", "not-a-date", "2026-06-21T10:00:00Z");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolFailure);
		expect((thrown as ToolFailure).code).toBe("bad_request");
		const text = failureResultFrom(thrown, "internal_error", "unused").content[0].text;
		expect(text.startsWith("[bad_request] ")).toBe(true);
		// The offending value is named, so nobody has to guess which field was wrong.
		expect(text).toContain('"not-a-date"');
	});

	test("an empty calendar search FAILS instead of reporting zero results", async () => {
		const calendar = (await import("../utils/calendar")).default;
		let thrown: unknown;
		try {
			await calendar.searchEvents("   ");
		} catch (error) {
			thrown = error;
		}

		// This used to `return []`, which told the caller the calendar held nothing matching a search
		// that was never made. Rule 6: never swallow a failure into a success.
		expect(thrown).toBeInstanceOf(ToolFailure);
		expect((thrown as ToolFailure).code).toBe("bad_request");
	});

	test("scheduling into the past is a bad_request, not a bare Error", async () => {
		const message = (await import("../utils/message")).default;
		let thrown: unknown;
		try {
			await message.scheduleMessage("+15551234567", "hi", new Date(Date.now() - 60_000));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolFailure);
		expect((thrown as ToolFailure).code).toBe("bad_request");
	});
});

// FAILURE 3 of 3: the swallowed one. Every calendar in the account throws while being enumerated, and
// the old code returned "no events" for it. This is the class that makes Maestro claim work was done
// that was not, so it gets a test that reaches across the JXA boundary with a mock.
describe("a scan where every container failed to read", () => {
	test("getEvents FAILS rather than reporting an empty diary", async () => {
		const CALENDAR_FAULT = "Error: Can't get object. (-1728)";

		mock.module("@jxa/run", () => ({
			run: async () => ({
				items: [],
				visited: 3,
				skippedCalendars: 3,
				firstError: CALENDAR_FAULT,
			}),
		}));

		const calendar = (await import("../utils/calendar")).default;
		let thrown: unknown;
		try {
			await calendar.getEvents(10, "2026-06-21T00:00:00Z", "2026-06-28T00:00:00Z");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolFailure);
		const failure = thrown as ToolFailure;
		expect(failure.code).toBe("applescript_error");
		expect(failure.summary).toContain("all 3 calendars failed to read");
		// And the reason Calendar gave is still there, uninterpreted.
		expect(failure.body).toContain(CALENDAR_FAULT);

		const result = failureResultFrom(thrown, "internal_error", "unused");
		expect(result.isError).toBe(true);
		expect(result.content[0].text.startsWith("[applescript_error] ")).toBe(true);
	});
});

describe("the verbatim body", () => {
	test("keeps a child process's stderr, which is where sqlite3 and osascript actually complain", () => {
		const execFileError = Object.assign(new Error("Command failed: sqlite3 chat.db"), {
			stderr: "Error: unable to open database file",
			code: 1,
		});
		const body = rawBody(execFileError);
		expect(body).toContain("Error: unable to open database file");
		expect(body).toContain("Command failed: sqlite3 chat.db");
	});
});
