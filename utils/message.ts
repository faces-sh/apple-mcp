import { runAppleScript } from "run-applescript";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import {
	APP_NAME,
	PermissionError,
	rethrowIfPermissionDenied,
	escapeAppleScriptString,
	escapeSqlString,
} from "./native";
import { handleCandidates } from "./phone";

// Apple Messages (iMessage) control. Two distinct surfaces, each with its own permission + transport:
//
//   READ  (fetch / conversations)  → SQLite over ~/Library/Messages/chat.db, needs FULL DISK ACCESS.
//   WRITE (send / schedule)        → AppleScript "tell Messages … send", needs AUTOMATION.
//
// Reads run sqlite3 via execFile (an argv vector, NO shell) so the chat.db path and the SQL text are
// never re-parsed by a shell — this closes the shell-injection surface that string-built
// `sqlite3 "…"` commands have. SQL string literals are still escaped with escapeSqlString. Every
// read is ONE query that filters server-side and is LIMIT-clamped — we never scan the store reading a
// property per row.
//
// chat.db handle_id quirk (load-bearing): a message you SENT in a 1:1 has handle_id = 0 (no handle
// row); only RECEIVED messages carry the sender's handle. Therefore every read LEFT JOINs handle (an
// INNER JOIN would silently drop all of your own sent messages), and scoping a person's thread is done
// by CHAT MEMBERSHIP (chat_handle_join), never by the message's own handle_id (which would exclude
// your replies). Sent rows surface a null sender, rendered "(me)".
//
// CRUD reality on this platform (see the notPossible list in the tool spec): iMessage exposes
//   Create = send (+ schedule, a local deferred send),
//   Read   = fetch / conversations,
//   Update = NONE  (editing/unsending a sent message is UI-only / private; no scripting API),
//   Delete = NONE  (deleting a message or thread is UI-only / private; no scripting API).
// Marking a message read programmatically is likewise not reliably possible. We do NOT fake any of
// these — attempting them would require synthetic UI events we refuse to ship.

const execFileAsync = promisify(execFile);
const CHAT_DB = `${process.env.HOME}/Library/Messages/chat.db`;

const MESSAGES_DB_DENIED =
	"Messages access is not granted. Reading message history needs Full Disk Access: in System " +
	`Settings ▸ Privacy & Security ▸ Full Disk Access, enable ${APP_NAME}, then try again.`;
const MESSAGES_SEND_DENIED =
	`Messages access is not granted. In System Settings ▸ Privacy & Security ▸ Automation, allow ${APP_NAME} ` +
	"to control Messages, then try again.";

// Configuration
const CONFIG = {
	// Hard ceiling on rows pulled from chat.db in any single read (perf guard).
	MAX_MESSAGES: 50,
	// Hard ceiling on distinct threads returned by `fetchConversations`.
	MAX_CONVERSATIONS: 50,
	// Timeout (ms) for each sqlite3 invocation — a hung store fails fast instead of blocking forever.
	SQLITE_TIMEOUT_MS: 8000,
};

// setTimeout silently clamps delays larger than this (~24.8 days) and fires almost immediately; we
// refuse to schedule beyond it rather than send NOW by surprise.
const MAX_TIMEOUT_MS = 2_147_483_647;

// Retry only the sqlite reads, and only for transient faults (a locked DB while Messages writes).
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

/** Run a read-only query against chat.db with a bounded timeout, returning parsed JSON rows.
 *  Wrapped in retryOperation because a concurrent Messages write can briefly lock the DB. */
async function queryChatDB<T>(sql: string): Promise<T[]> {
	const { stdout } = await retryOperation(() =>
		execFileAsync("sqlite3", ["-json", "-readonly", CHAT_DB, sql], {
			timeout: CONFIG.SQLITE_TIMEOUT_MS,
			maxBuffer: 1024 * 1024 * 16,
		}),
	);
	if (!stdout.trim()) return [];
	return JSON.parse(stdout) as T[];
}

/** Clamp a caller-supplied limit to a sane positive integer (guards a negative/huge/NaN value from
 *  reaching the sqlite `LIMIT` clause, where e.g. a negative means "no limit"). */
function clampLimit(limit: number | undefined, max: number, fallback = 10): number {
	const n = Math.floor(Number(limit));
	if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, max);
	return Math.min(n, max);
}

// ─── CREATE ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Send an iMessage to a single handle (phone number or iMessage email). Drives Messages over
 * AppleScript; the handle and body are escaped into the source as double-quoted string literals
 * (escapeAppleScriptString) — no shell is involved and the values are never concatenated into a
 * shell command. A TCC Automation denial surfaces as a PermissionError (never a silent no-op).
 *
 * NOTE: we do NOT read the message back after sending (a property read on a just-sent message forces
 * a multi-second store round-trip). The send itself is the confirmation; we return the handle/body
 * we sent.
 */
async function sendMessage(
	handle: string,
	message: string,
): Promise<{ handle: string; message: string }> {
	const to = (handle ?? "").trim();
	if (!to) throw new Error("A recipient handle (phone number or email) is required to send.");
	if (typeof message !== "string" || message.length === 0) {
		throw new Error("A non-empty message body is required to send.");
	}
	const buddy = escapeAppleScriptString(to);
	const body = escapeAppleScriptString(message);
	try {
		// `buddy "…" of targetService` (NOT a bare app-level `buddy`) is the reliable reference: an
		// app-level lookup spans services and commonly fails with "Can't get buddy …".
		await runAppleScript(`
tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${buddy}" of targetService
    send "${body}" to targetBuddy
end tell`);
		return { handle: to, message };
	} catch (error) {
		rethrowIfPermissionDenied(error, MESSAGES_SEND_DENIED);
	}
}

/**
 * Schedule an iMessage to be sent at a future time. This is a LOCAL deferred send: it lives in this
 * process's event loop (setTimeout) and is lost if the process exits before `scheduledTime`. It is
 * NOT persisted to Messages (the app has no scripting API for scheduled sends). Throws if the time is
 * in the past, too far out (beyond the setTimeout safe ceiling — we refuse rather than fire early), or
 * the inputs are invalid; the eventual send still surfaces its own send errors via log.
 */
async function scheduleMessage(
	handle: string,
	message: string,
	scheduledTime: Date,
): Promise<{ id: NodeJS.Timeout; scheduledTime: Date; message: string; handle: string }> {
	const to = (handle ?? "").trim();
	if (!to) throw new Error("A recipient handle (phone number or email) is required to schedule.");
	if (typeof message !== "string" || message.length === 0) {
		throw new Error("A non-empty message body is required to schedule.");
	}
	if (!(scheduledTime instanceof Date) || Number.isNaN(scheduledTime.getTime())) {
		throw new Error("A valid scheduledTime (ISO timestamp) is required to schedule.");
	}

	const delay = scheduledTime.getTime() - Date.now();
	if (delay < 0) {
		throw new Error("Cannot schedule message in the past");
	}
	if (delay > MAX_TIMEOUT_MS) {
		// Refuse rather than let setTimeout clamp and fire almost immediately (a silent wrong send).
		throw new Error(
			"Cannot schedule a message more than ~24 days out (local deferred sends are not persisted).",
		);
	}

	const timeoutId = setTimeout(async () => {
		try {
			await sendMessage(to, message);
		} catch (error) {
			console.error("Failed to send scheduled message:", error);
		}
	}, delay);

	return { id: timeoutId, scheduledTime, message, handle: to };
}

// ─── READ ────────────────────────────────────────────────────────────────────────────────────────

interface Message {
	content: string;
	date: string;
	sender: string;
	is_from_me: boolean;
	is_read?: boolean;
	attachments?: string[];
	url?: string;
}

interface Conversation {
	chat_identifier: string; // the handle (1:1) or group identifier of the thread
	display_name: string | null; // a group chat's name, if any (null for 1:1)
	is_group: boolean; // true for a group thread (chat.style 43), false for 1:1 (style 45)
	last_message: Message; // preview of the most recent message in the thread
}

// Shape of a chat.db message row as selected by the read queries below.
type MessageRow = {
	message_id: number;
	content: string | null;
	date: string;
	sender: string | null;
	is_from_me: number;
	is_read: number;
	cache_has_attachments: number;
	subject: string | null;
	content_type: number; // 0 = plain text, 1 = hex(attributedBody), 2 = none (attachment-only)
};

async function checkMessagesDBAccess(): Promise<boolean> {
	try {
		await access(CHAT_DB);
		// Confirm we can actually read it (Full Disk Access), not just that the file exists.
		await execFileAsync("sqlite3", ["-readonly", CHAT_DB, "SELECT 1;"], {
			timeout: CONFIG.SQLITE_TIMEOUT_MS,
		});
		return true;
	} catch (error) {
		// A missing sqlite3 binary (ENOENT) is an environment fault, NOT a permission denial — surface
		// it loudly rather than mislabelling it as "grant Full Disk Access".
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" && /sqlite3/.test(String((error as Error)?.message))) {
			throw new Error(
				"The `sqlite3` binary was not found; cannot read the Messages database.",
			);
		}
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
		const rows = await queryChatDB<{ filename: string }>(query);
		return rows.map((a) => a.filename).filter(Boolean);
	} catch (error) {
		console.error("Error getting attachments:", error);
		return [];
	}
}

// The SELECT column list shared by every message read, so fetch and conversations decode identically.
// Aliased to the MessageRow shape; `mAlias` lets a caller join under a different table alias.
function messageColumns(mAlias = "m", hAlias = "h"): string {
	return `
                ${mAlias}.ROWID as message_id,
                CASE
                    WHEN ${mAlias}.text IS NOT NULL AND ${mAlias}.text != '' THEN ${mAlias}.text
                    WHEN ${mAlias}.attributedBody IS NOT NULL THEN hex(${mAlias}.attributedBody)
                    ELSE NULL
                END as content,
                datetime(${mAlias}.date/1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
                ${hAlias}.id as sender,
                ${mAlias}.is_from_me,
                ${mAlias}.is_read,
                ${mAlias}.cache_has_attachments,
                ${mAlias}.subject,
                CASE
                    WHEN ${mAlias}.text IS NOT NULL AND ${mAlias}.text != '' THEN 0
                    WHEN ${mAlias}.attributedBody IS NOT NULL THEN 1
                    ELSE 2
                END as content_type`;
}

/**
 * Fetch the most recent messages, newest first. Optionally scope to one person's WHOLE thread (pass
 * ALL of a contact's numbers/emails — we match by chat membership so BOTH directions are captured),
 * filter by read state, or by direction. ONE sqlite query, no per-message contact scan. Returns [] for
 * a genuinely empty result; a denied Full Disk Access throws PermissionError.
 */
async function fetchMessages(opts: {
	handles?: string[];
	limit?: number;
	status?: "read" | "unread";
	from?: "them" | "me";
}): Promise<Message[]> {
	try {
		const maxLimit = clampLimit(opts.limit, CONFIG.MAX_MESSAGES);
		await ensureMessagesDBAccess(); // throws PermissionError when FDA is not granted

		const where: string[] = [
			"(m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)",
			"m.item_type = 0",
			"m.is_audio_message = 0",
		];

		// Scope to a person's WHOLE thread (both directions). We must match by CHAT MEMBERSHIP, not by
		// the message's own handle_id: a message you SENT in a 1:1 has handle_id 0 (no handle row), so
		// filtering on m.handle_id would silently drop every reply you sent. Instead we keep messages
		// belonging to any chat the person participates in (chat_handle_join → handle.id).
		if (opts.handles && opts.handles.length > 0) {
			const candidates = Array.from(new Set(opts.handles.flatMap(handleCandidates)));
			if (candidates.length === 0) return [];
			const list = candidates.map((p) => `'${escapeSqlString(p)}'`).join(",");
			where.push(`m.ROWID IN (
                SELECT cmj.message_id
                FROM chat_message_join cmj
                WHERE cmj.chat_id IN (
                    SELECT chj.chat_id
                    FROM chat_handle_join chj
                    INNER JOIN handle ph ON ph.ROWID = chj.handle_id
                    WHERE ph.id IN (${list})
                )
            )`);
		}

		if (opts.from === "them") where.push("m.is_from_me = 0");
		else if (opts.from === "me") where.push("m.is_from_me = 1");

		if (opts.status === "unread") where.push("m.is_from_me = 0 AND m.is_read = 0");
		else if (opts.status === "read") where.push("m.is_from_me = 0 AND m.is_read = 1");

		// LEFT JOIN (NOT inner): a sent message has handle_id 0 and therefore no handle row; an INNER
		// JOIN would drop every sent message — returning a received-only, wrong-but-quiet view and
		// making from:"me" always empty. A null sender on a sent row is rendered "(me)" downstream.
		const query = `
            SELECT ${messageColumns("m", "h")}
            FROM message m
            LEFT JOIN handle h ON h.ROWID = m.handle_id
            WHERE ${where.join("\n                AND ")}
            ORDER BY m.date DESC
            LIMIT ${maxLimit}
        `;

		const rows = await queryChatDB<MessageRow>(query);
		return await formatMessages(rows);
	} catch (error) {
		if (error instanceof PermissionError) throw error;
		// A sqlite/parse failure is a real fault — surface it, never pretend "no messages".
		console.error("Error fetching messages:", error);
		rethrowIfPermissionDenied(error, MESSAGES_DB_DENIED);
	}
}

/**
 * List the most recently active distinct conversations (threads), newest first, each with a preview of
 * its latest message. ONE sqlite query using a window function to pick the newest message per chat —
 * no per-thread scan. Distinguishes 1:1 (chat.style 45) from group threads (style 43). Returns [] for
 * a genuinely empty store; a denied Full Disk Access throws PermissionError.
 */
async function fetchConversations(opts: { limit?: number }): Promise<Conversation[]> {
	try {
		const maxLimit = clampLimit(opts.limit, CONFIG.MAX_CONVERSATIONS);
		await ensureMessagesDBAccess(); // throws PermissionError when FDA is not granted

		// Rank messages within each chat by recency, then keep rank 1 (the latest) per chat. The
		// handle join is LEFT (a message I sent in a 1:1 has handle_id 0 → no handle row).
		const query = `
            WITH ranked AS (
                SELECT
                    c.ROWID as chat_id,
                    c.chat_identifier as chat_identifier,
                    c.display_name as display_name,
                    c.style as style,
                    m.date as raw_date,
                    ${messageColumns("m", "h")},
                    ROW_NUMBER() OVER (PARTITION BY c.ROWID ORDER BY m.date DESC, m.ROWID DESC) as rn
                FROM chat c
                INNER JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
                INNER JOIN message m ON m.ROWID = cmj.message_id
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                WHERE m.item_type = 0
                    AND m.is_audio_message = 0
                    AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
            )
            SELECT *
            FROM ranked
            WHERE rn = 1
            ORDER BY raw_date DESC
            LIMIT ${maxLimit}
        `;

		const rows = await queryChatDB<
			MessageRow & {
				chat_identifier: string;
				display_name: string | null;
				style: number;
			}
		>(query);

		return await Promise.all(
			rows.map(async (row) => {
				const last = await formatOneMessage({
					...row,
					// For a message I sent in a 1:1, the handle row is absent — fall back to the thread id.
					sender: row.sender ?? row.chat_identifier,
				});
				return {
					chat_identifier: row.chat_identifier,
					display_name: row.display_name,
					is_group: row.style === 43,
					last_message: last,
				};
			}),
		);
	} catch (error) {
		if (error instanceof PermissionError) throw error;
		console.error("Error fetching conversations:", error);
		rethrowIfPermissionDenied(error, MESSAGES_DB_DENIED);
	}
}

/** Decode + format ONE chat.db row into a Message (body decode, URL/attachment/subject decoration).
 *  Guarded so a single malformed row can't abort a whole batch. */
async function formatOneMessage(msg: MessageRow): Promise<Message> {
	try {
		let content = msg.content || "";
		let url: string | undefined;

		// content_type 1 → the body is hex(attributedBody); decode it. Otherwise it's plain text.
		if (msg.content_type === 1) {
			const decoded = decodeAttributedBody(content);
			content = decoded.text;
			url = decoded.url;
		} else {
			const urlMatch = content.match(/(https?:\/\/[^\s]+)/);
			if (urlMatch) url = urlMatch[1];
		}

		let attachments: string[] = [];
		if (msg.cache_has_attachments) {
			attachments = await getAttachmentPaths(msg.message_id);
		}

		if (msg.subject) {
			content = `Subject: ${msg.subject}\n${content}`;
		}

		const formatted: Message = {
			content: content || "[No text content]",
			date: new Date(msg.date).toISOString(),
			sender: msg.sender ?? "(me)",
			is_from_me: Boolean(msg.is_from_me),
			is_read: Boolean(msg.is_read),
		};

		if (attachments.length > 0) {
			formatted.attachments = attachments;
			formatted.content += `\n[Attachments: ${attachments.length}]`;
		}
		if (url) {
			formatted.url = url;
			formatted.content += `\n[URL: ${url}]`;
		}
		return formatted;
	} catch (error) {
		console.error("Error formatting a message row:", error);
		return {
			content: "[Message content not readable]",
			date: new Date(msg.date || Date.now()).toISOString(),
			sender: msg.sender ?? "(me)",
			is_from_me: Boolean(msg.is_from_me),
			is_read: Boolean(msg.is_read),
		};
	}
}

/** Shared post-processing for a batch of chat.db rows: decode bodies, attach URLs/attachments, format.
 *  Attachment-only rows (no decodable text) are kept; truly empty/null rows are dropped. */
async function formatMessages(messages: MessageRow[]): Promise<Message[]> {
	return Promise.all(
		messages
			.filter((msg) => msg.content !== null || msg.cache_has_attachments === 1)
			.map((msg) => formatOneMessage(msg)),
	);
}

export default {
	sendMessage,
	scheduleMessage,
	fetchMessages,
	fetchConversations,
};
