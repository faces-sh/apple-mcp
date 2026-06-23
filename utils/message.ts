import { runAppleScript } from "run-applescript";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import {
	PermissionError,
	rethrowIfPermissionDenied,
	escapeAppleScriptString,
	escapeSqlString,
} from "./native";
import { handleCandidates } from "./phone";

// Run sqlite3 via execFile (argv vector, NO shell) so the chat.db path and the SQL text are never
// re-parsed by a shell — closes the shell-injection surface that string-built `sqlite3 "..."`
// commands have. SQL string literals are still escaped with escapeSqlString.
const execFileAsync = promisify(execFile);
const CHAT_DB = `${process.env.HOME}/Library/Messages/chat.db`;

const MESSAGES_DB_DENIED =
	"Messages access is not granted. Reading message history needs Full Disk Access: in System " +
	"Settings ▸ Privacy & Security ▸ Full Disk Access, enable Faced, then try again.";
const MESSAGES_SEND_DENIED =
	"Messages access is not granted. In System Settings ▸ Privacy & Security ▸ Automation, allow " +
	"Faced to control Messages, then try again.";

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
		rethrowIfPermissionDenied(error, MESSAGES_SEND_DENIED);
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

async function checkMessagesDBAccess(): Promise<boolean> {
	try {
		await access(CHAT_DB);
		// Confirm we can actually read it (Full Disk Access), not just that the file exists.
		await execFileAsync("sqlite3", [CHAT_DB, "SELECT 1;"]);
		return true;
	} catch (error) {
		console.error(
			`Cannot read the Messages database (${CHAT_DB}): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return false;
	}
}

/**
 * Verify Messages history is readable; throws PermissionError (never returns empty) when it is not,
 * so a denied Full Disk Access is surfaced rather than masquerading as "no messages".
 */
async function ensureMessagesDBAccess(): Promise<void> {
	if (await checkMessagesDBAccess()) return;
	throw new PermissionError(MESSAGES_DB_DENIED);
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
	if (!Number.isInteger(messageId)) return [];
	try {
		const query = `
            SELECT filename
            FROM attachment
            INNER JOIN message_attachment_join
            ON attachment.ROWID = message_attachment_join.attachment_id
            WHERE message_attachment_join.message_id = ${messageId}
        `;

		const { stdout } = await execFileAsync("sqlite3", ["-json", CHAT_DB, query]);

		if (!stdout.trim()) {
			return [];
		}

		const attachments = JSON.parse(stdout) as { filename: string }[];
		return attachments.map((a) => a.filename).filter(Boolean);
	} catch (error) {
		console.error("Error getting attachments:", error);
		return [];
	}
}

async function readMessages(phoneNumber: string, limit = 10): Promise<Message[]> {
	try {
		const maxLimit = clampLimit(limit);

		await ensureMessagesDBAccess(); // throws PermissionError when FDA is not granted

		// All handle forms (E.164 / national digits / email) to match chat.db's handle.id
		const phoneFormats = handleCandidates(phoneNumber);
		if (phoneFormats.length === 0) return [];
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
		if (error instanceof PermissionError) throw error;
		// A sqlite/parse failure is a real fault — surface it, never pretend "no messages".
		console.error("Error reading messages:", error);
		rethrowIfPermissionDenied(error, MESSAGES_DB_DENIED);
	}
}

async function getUnreadMessages(limit = 10): Promise<Message[]> {
	try {
		const maxLimit = clampLimit(limit);

		await ensureMessagesDBAccess(); // throws PermissionError when FDA is not granted

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
		if (error instanceof PermissionError) throw error;
		console.error("Error reading unread messages:", error);
		rethrowIfPermissionDenied(error, MESSAGES_DB_DENIED);
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
		throw new Error("Cannot schedule message in the past");
	}

	// Schedule the message
	const timeoutId = setTimeout(async () => {
		try {
			await sendMessage(phoneNumber, message);
		} catch (error) {
			console.error("Failed to send scheduled message:", error);
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
