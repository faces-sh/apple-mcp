import { runAppleScript } from "run-applescript";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import {
	ToolFailure,
	grantSentence,
	isPermissionDenial,
	throwAppleFailure,
	escapeAppleScriptString,
	escapeSqlString,
} from "./native";
import { rawBody } from "./failure";
import { handleCandidates } from "./phone";

// Run sqlite3 via execFile (argv vector, NO shell) so the chat.db path and the SQL text are never
// re-parsed by a shell — closes the shell-injection surface that string-built `sqlite3 "..."`
// commands have. SQL string literals are still escaped with escapeSqlString.
const execFileAsync = promisify(execFile);
const CHAT_DB = `${process.env.HOME}/Library/Messages/chat.db`;

// The one sentence each outcome puts on line 1 of the envelope. It says WHAT DID NOT HAPPEN, and for
// a denial it also NAMES the permission that is missing and the app to enable it for.
//
// Naming it is not inventing a remedy. Only this server can tell a denied Automation grant from a
// denied Contacts one, so nothing upstream could reconstruct that sentence, and dropping it deletes it
// rather than moving it somewhere better. What stays out is anything we would be guessing: no "then
// try again", no theory about why the grant is missing.
export const MESSAGES_SEND_SUMMARIES = {
	denied:
		"Could not send the message: macOS denied control of Messages. " +
		grantSentence("Automation > Messages"),
	notRunning: "Could not send the message: the Messages app could not be reached.",
	timedOut: "Could not send the message: Messages did not answer in time.",
	failed: "Could not send the message.",
};
// Reading chat.db is the ONE thing here that needs Full Disk Access rather than Automation, and this
// server is the only place that knows it. Say which.
export const MESSAGES_READ_DENIED =
	"Could not read your message history: macOS denied access to the Messages database. " +
	grantSentence("Full Disk Access");
const MESSAGES_READ_FAILED = "Could not read your message history.";

// Configuration
const CONFIG = {
	// Maximum messages to process (to avoid performance issues)
	MAX_MESSAGES: 50,
	// Maximum content length for previews
	MAX_CONTENT_PREVIEW: 300,
	// Timeout for operations
	TIMEOUT_MS: 8000,
};

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOperation<T>(
	operation: () => Promise<T>,
	retries = MAX_RETRIES,
	delay = RETRY_DELAY,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (retries > 0) {
			console.error(
				`Operation failed, retrying... (${retries} attempts remaining)`,
			);
			await sleep(delay);
			return retryOperation(operation, retries - 1, delay);
		}
		throw error;
	}
}

/** Clamp a caller-supplied limit to a sane positive integer (guards a negative/huge/NaN value from
 *  reaching the sqlite `LIMIT` clause, where e.g. a negative means "no limit"). */
function clampLimit(limit: number): number {
	const n = Math.floor(Number(limit));
	if (!Number.isFinite(n) || n <= 0) return 10;
	return Math.min(n, CONFIG.MAX_MESSAGES);
}

async function sendMessage(phoneNumber: string, message: string) {
	const buddy = escapeAppleScriptString(phoneNumber);
	const body = escapeAppleScriptString(message);
	try {
		return await runAppleScript(`
tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${buddy}"
    send "${body}" to targetBuddy
end tell`);
	} catch (error) {
		throwAppleFailure(error, MESSAGES_SEND_SUMMARIES);
	}
}

interface Message {
	content: string;
	date: string;
	sender: string;
	is_from_me: boolean;
	attachments?: string[];
	url?: string;
}

/**
 * Turn a failure out of sqlite3 (or out of `access`) into a typed `ToolFailure`.
 *
 * The distinction this draws is the whole point of the exercise. A denied Full Disk Access, a chat.db
 * that does not exist, a chat.db that is corrupt, and a missing `sqlite3` binary are four different
 * situations with four different answers, and the old code collapsed all four into `return false` and
 * then reported every one of them as "grant Full Disk Access". Worse, sqlite3's own words, the only
 * thing that could have told them apart, were written to stderr and dropped. Now the code says which
 * of the four it was and the body carries what sqlite3 actually said, uninterpreted.
 */
function throwMessagesDbFailure(error: unknown, summary: string): never {
	if (error instanceof ToolFailure) throw error;
	const body = rawBody(error);
	const text = body.toLowerCase();
	const code = (error as { code?: unknown } | null)?.code;

	// The Full Disk Access shape: the file is there, sqlite3 is refused when it opens it.
	if (
		isPermissionDenial(error) ||
		code === "EACCES" ||
		code === "EPERM" ||
		text.includes("unable to open database file") ||
		text.includes("authorization denied") ||
		text.includes("operation not permitted")
	) {
		throw new ToolFailure("permission_denied", MESSAGES_READ_DENIED, body);
	}
	// No chat.db at all: Messages has never stored anything on this Mac.
	if (code === "ENOENT" && !text.includes("sqlite3")) {
		throw new ToolFailure(
			"not_found",
			`Could not read your message history: there is no Messages database at ${CHAT_DB}.`,
			body,
		);
	}
	throw new ToolFailure("database_error", summary, body);
}

/**
 * Verify Messages history is readable. Throws (never returns empty) when it is not, so a denied Full
 * Disk Access is surfaced rather than masquerading as "no messages".
 */
async function ensureMessagesDBAccess(): Promise<void> {
	try {
		await access(CHAT_DB);
	} catch (error) {
		throwMessagesDbFailure(error, MESSAGES_READ_FAILED);
	}
	try {
		// Confirm we can actually read it (Full Disk Access), not just that the file exists.
		await execFileAsync("sqlite3", [CHAT_DB, "SELECT 1;"]);
	} catch (error) {
		throwMessagesDbFailure(error, MESSAGES_READ_FAILED);
	}
}

function decodeAttributedBody(hexString: string): { text: string; url?: string } {
	try {
		// Convert hex to buffer
		const buffer = Buffer.from(hexString, "hex");
		const content = buffer.toString();

		// Common patterns in attributedBody
		const patterns = [
			/NSString">(.*?)</, // Basic NSString pattern
			/NSString">([^<]+)/, // NSString without closing tag
			/NSNumber">\d+<.*?NSString">(.*?)</, // NSNumber followed by NSString
			/NSArray">.*?NSString">(.*?)</, // NSString within NSArray
			/"string":\s*"([^"]+)"/, // JSON-style string
			/text[^>]*>(.*?)</, // Generic XML-style text
			/message>(.*?)</, // Generic message content
		];

		// Try each pattern
		let text = "";
		for (const pattern of patterns) {
			const match = content.match(pattern);
			if (match?.[1]) {
				text = match[1];
				if (text.length > 5) {
					// Only use if we got something substantial
					break;
				}
			}
		}

		// Look for URLs
		const urlPatterns = [
			/(https?:\/\/[^\s<"]+)/, // Standard URLs
			/NSString">(https?:\/\/[^\s<"]+)/, // URLs in NSString
			/"url":\s*"(https?:\/\/[^"]+)"/, // URLs in JSON format
			/link[^>]*>(https?:\/\/[^<]+)/, // URLs in XML-style tags
		];

		let url: string | undefined;
		for (const pattern of urlPatterns) {
			const match = content.match(pattern);
			if (match?.[1]) {
				url = match[1];
				break;
			}
		}

		if (!text && !url) {
			// Try to extract any readable text content
			const readableText = content
				.replace(/streamtyped.*?NSString/g, "") // Remove streamtyped header
				.replace(/NSAttributedString.*?NSString/g, "") // Remove attributed string metadata
				.replace(/NSDictionary.*?$/g, "") // Remove dictionary metadata
				.replace(/\+[A-Za-z]+\s/g, "") // Remove +[identifier] patterns
				.replace(/NSNumber.*?NSValue.*?\*/g, "") // Remove number/value metadata
				.replace(/[^\x20-\x7E]/g, " ") // Replace non-printable chars with space
				.replace(/\s+/g, " ") // Normalize whitespace
				.trim();

			if (readableText.length > 5) {
				// Only use if we got something substantial
				text = readableText;
			} else {
				return { text: "[Message content not readable]" };
			}
		}

		// Clean up the found text
		if (text) {
			text = text
				.replace(/^[+\s]+/, "") // Remove leading + and spaces
				.replace(/\s*iI\s*[A-Z]\s*$/, "") // Remove iI K pattern at end
				.replace(/\s+/g, " ") // Normalize whitespace
				.trim();
		}

		return { text: text || url || "", url };
	} catch (error) {
		console.error("Error decoding attributedBody:", error);
		return { text: "[Message content not readable]" };
	}
}

async function getAttachmentPaths(messageId: number): Promise<string[]> {
	// messageId originates from the DB as a number; guard anyway before interpolation.
	if (!Number.isInteger(messageId)) {
		throw new ToolFailure(
			"internal_error",
			"Could not read the message attachments: the message id was not a number.",
			String(messageId),
		);
	}
	const query = `
            SELECT filename
            FROM attachment
            INNER JOIN message_attachment_join
            ON attachment.ROWID = message_attachment_join.attachment_id
            WHERE message_attachment_join.message_id = ${messageId}
        `;

	let stdout: string;
	try {
		// A failure here USED TO return an empty array, which meant a message with attachments came
		// back saying it had none: a broken query reported as a fact about the conversation. It throws
		// now, with sqlite3's own complaint as the body.
		({ stdout } = await execFileAsync("sqlite3", ["-json", CHAT_DB, query]));
	} catch (error) {
		throwMessagesDbFailure(
			error,
			"Could not read the message attachments.",
		);
	}

	// Genuinely no attachment rows. sqlite3 prints nothing for an empty result set.
	if (!stdout.trim()) return [];

	try {
		const attachments = JSON.parse(stdout) as { filename: string }[];
		return attachments.map((a) => a.filename).filter(Boolean);
	} catch (error) {
		throw new ToolFailure(
			"database_error",
			"Could not read the message attachments: sqlite3 returned something that is not JSON.",
			rawBody(error),
		);
	}
}

async function readMessages(phoneNumber: string, limit = 10): Promise<Message[]> {
	try {
		const maxLimit = clampLimit(limit);

		await ensureMessagesDBAccess(); // throws ToolFailure when the store is unreadable

		// All handle forms (E.164 / national digits / email) to match chat.db's handle.id
		const phoneFormats = handleCandidates(phoneNumber);
		if (phoneFormats.length === 0) {
			// Nothing to look up. Returning [] here said "no messages with that person", which is a
			// claim about the conversation; the truth is that the handle was never usable.
			throw new ToolFailure(
				"bad_request",
				`Could not read your messages: "${phoneNumber}" is not a usable phone number or email address.`,
			);
		}
		console.error("Trying handle formats:", phoneFormats);

		// Create SQL IN clause with all handle formats (each literal SQL-escaped)
		const phoneList = phoneFormats
			.map((p) => `'${escapeSqlString(p)}'`)
			.join(",");

		const query = `
            SELECT
                m.ROWID as message_id,
                CASE
                    WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
                    WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
                    ELSE NULL
                END as content,
                datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
                h.id as sender,
                m.is_from_me,
                m.is_audio_message,
                m.cache_has_attachments,
                m.subject,
                CASE
                    WHEN m.text IS NOT NULL AND m.text != '' THEN 0
                    WHEN m.attributedBody IS NOT NULL THEN 1
                    ELSE 2
                END as content_type
            FROM message m
            INNER JOIN handle h ON h.ROWID = m.handle_id
            WHERE h.id IN (${phoneList})
                AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
                AND m.is_from_me IS NOT NULL  -- Ensure it's a real message
                AND m.item_type = 0  -- Regular messages only
                AND m.is_audio_message = 0  -- Skip audio messages
            ORDER BY m.date DESC
            LIMIT ${maxLimit}
        `;

		// Execute query with retries
		const { stdout } = await retryOperation(() =>
			execFileAsync("sqlite3", ["-json", CHAT_DB, query]),
		);

		if (!stdout.trim()) {
			console.error("No messages found in database for the given phone number");
			return [];
		}

		const messages = JSON.parse(stdout) as (Message & {
			message_id: number;
			is_audio_message: number;
			cache_has_attachments: number;
			subject: string | null;
			content_type: number;
		})[];

		return await formatMessages(messages);
	} catch (error) {
		// A sqlite/parse failure is a real fault: surface it, never pretend "no messages".
		throwMessagesDbFailure(error, "Could not read your messages.");
	}
}

async function getUnreadMessages(limit = 10): Promise<Message[]> {
	try {
		const maxLimit = clampLimit(limit);

		await ensureMessagesDBAccess(); // throws ToolFailure when the store is unreadable

		const query = `
            SELECT
                m.ROWID as message_id,
                CASE
                    WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
                    WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
                    ELSE NULL
                END as content,
                datetime(m.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
                h.id as sender,
                m.is_from_me,
                m.is_audio_message,
                m.cache_has_attachments,
                m.subject,
                CASE
                    WHEN m.text IS NOT NULL AND m.text != '' THEN 0
                    WHEN m.attributedBody IS NOT NULL THEN 1
                    ELSE 2
                END as content_type
            FROM message m
            INNER JOIN handle h ON h.ROWID = m.handle_id
            WHERE m.is_from_me = 0  -- Only messages from others
                AND m.is_read = 0   -- Only unread messages
                AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
                AND m.is_audio_message = 0  -- Skip audio messages
                AND m.item_type = 0  -- Regular messages only
            ORDER BY m.date DESC
            LIMIT ${maxLimit}
        `;

		// Execute query with retries
		const { stdout } = await retryOperation(() =>
			execFileAsync("sqlite3", ["-json", CHAT_DB, query]),
		);

		if (!stdout.trim()) {
			console.error("No unread messages found");
			return [];
		}

		const messages = JSON.parse(stdout) as (Message & {
			message_id: number;
			is_audio_message: number;
			cache_has_attachments: number;
			subject: string | null;
			content_type: number;
		})[];

		return await formatMessages(messages);
	} catch (error) {
		throwMessagesDbFailure(error, "Could not read your unread messages.");
	}
}

/** Shared post-processing for chat.db rows: decode bodies, attach URLs/attachments, format. */
async function formatMessages(
	messages: (Message & {
		message_id: number;
		cache_has_attachments: number;
		subject: string | null;
		content_type: number;
	})[],
): Promise<Message[]> {
	return Promise.all(
		messages
			.filter((msg) => msg.content !== null || msg.cache_has_attachments === 1)
			.map(async (msg) => {
				let content = msg.content || "";
				let url: string | undefined;

				// If it's an attributedBody (content_type = 1), decode it
				if (msg.content_type === 1) {
					const decoded = decodeAttributedBody(content);
					content = decoded.text;
					url = decoded.url;
				} else {
					// Check for URLs in regular text messages
					const urlMatch = content.match(/(https?:\/\/[^\s]+)/);
					if (urlMatch) {
						url = urlMatch[1];
					}
				}

				// Get attachments if any
				let attachments: string[] = [];
				if (msg.cache_has_attachments) {
					attachments = await getAttachmentPaths(msg.message_id);
				}

				// Add subject if present
				if (msg.subject) {
					content = `Subject: ${msg.subject}\n${content}`;
				}

				// Format the message object
				const formattedMsg: Message = {
					content: content || "[No text content]",
					date: new Date(msg.date).toISOString(),
					sender: msg.sender,
					is_from_me: Boolean(msg.is_from_me),
				};

				// Add attachments if any
				if (attachments.length > 0) {
					formattedMsg.attachments = attachments;
					formattedMsg.content += `\n[Attachments: ${attachments.length}]`;
				}

				// Add URL if present
				if (url) {
					formattedMsg.url = url;
					formattedMsg.content += `\n[URL: ${url}]`;
				}

				return formattedMsg;
			}),
	);
}

async function scheduleMessage(
	phoneNumber: string,
	message: string,
	scheduledTime: Date,
) {
	// Calculate delay in milliseconds
	const delay = scheduledTime.getTime() - Date.now();

	if (delay < 0) {
		throw new ToolFailure(
			"bad_request",
			"Could not schedule the message: the time given is in the past.",
		);
	}

	// Schedule the message.
	//
	// KNOWN GAP, and it is a real one: the tool has already returned by the time this fires, so a send
	// that fails later has no envelope to travel on and nobody is listening for one. All this can do is
	// say so as loudly as a detached process can. Closing it properly means the schedule tool reporting
	// back out of band, which is a change to what the tool IS and not an error path, so it is written
	// down here rather than half-done.
	const timeoutId = setTimeout(async () => {
		try {
			await sendMessage(phoneNumber, message);
		} catch (error) {
			console.error(
				`[scheduled_send_failed] The scheduled message to ${phoneNumber} was not sent.\n${rawBody(error)}`,
			);
		}
	}, delay);

	return {
		id: timeoutId,
		scheduledTime,
		message,
		phoneNumber,
	};
}

export default {
	sendMessage,
	readMessages,
	scheduleMessage,
	getUnreadMessages,
};
