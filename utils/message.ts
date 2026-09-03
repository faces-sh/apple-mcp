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
import { looksLikeHandle } from "./recipient";
import { typedstreamText } from "./typedstream";
import { matchesQuery, queryTerms } from "./query";
import { conversationsForHandle, conversationsNamed, listConversations, readConversation } from "./conversation";
import contacts from "./contacts";
import { resolveRecipient, type Resolution } from "./recipient";

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

/**
 * Send one message. THE TARGET MUST BE AN ADDRESS.
 *
 * `buddy "Hamilton"` is accepted by Messages and quietly does nothing: no error is raised, so this
 * returned its canned "Message sent to Hamilton" and the caller believed it. A false success on the one
 * act that cannot be taken back is the worst failure this file can produce, and it is worse than a
 * refusal by a wide margin: somebody who is told it failed will send it another way, and somebody who
 * is told it worked will not.
 *
 * Verified on a real Mac: the call reported success and chat.db recorded no outgoing message at all.
 *
 * A NAME IS REFUSED RATHER THAN RESOLVED, deliberately. Reading picks the most recent thread when a
 * name is ambiguous, because a read is reversible; a send is not, and the wrong Caroline gets a message
 * meant for somebody else. So the caller is told where to get a handle instead.
 */
/**
 * Send into one existing conversation, addressed by its chat guid.
 *
 * THE ONLY WAY TO REPLY TO A GROUP. `buddy` addresses a person, and a group is not a person, so before
 * this there was no way to answer three people at once in the thread they were talking in.
 */
/**
 * Did the message actually LEAVE? AppleScript will not say.
 *
 * `send` returns the moment Messages accepts the text, which is long before the network has an opinion,
 * so "Message sent to Linda Therrien" was printed over a message that never went. In chat.db it sat with
 * `is_sent = 0` and `error = 22`, and on screen it was red and said "Not Delivered". The person was told
 * it worked, and the one thing they needed to know was that it had not.
 *
 * So the row is read back. A short poll, because delivery is asynchronous: what is being waited for is
 * the send LEAVING, not the recipient receiving, which can take much longer and is not ours to promise.
 * Silence after the wait is reported as sent, deliberately: a slow network must not be called a failure,
 * and `error` is what distinguishes the two.
 */
async function sendFailure(handle: string, sentAfter: number): Promise<string | null> {
	const since = Math.floor(sentAfter / 1000) - 978307200 - 2;
	for (let attempt = 0; attempt < 8; attempt++) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			const { stdout } = await execFileAsync("sqlite3", ["-json", CHAT_DB, `
				SELECT m.error AS err, m.is_sent AS sent
				FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
				WHERE m.is_from_me = 1 AND m.date/1000000000 + 978307200 > ${since}
				ORDER BY m.date DESC LIMIT 1`]);
			const row = (JSON.parse(stdout || "[]") as { err: number; sent: number }[])[0];
			if (!row) continue;
			if (row.err && row.err !== 0) {
				return `The message was NOT delivered to ${handle} (Messages reported error ${row.err}). `
					+ "It may not be reachable at that number on iMessage. Check the number, or send to "
					+ "the one they have actually been messaging from.";
			}
			if (row.sent) return null;
		} catch {
			return null;   // cannot read the store: do not invent a failure
		}
	}
	return null;
}

async function sendToConversation(guid: string, message: string) {
	const body = escapeAppleScriptString(message);
	const chat = escapeAppleScriptString(guid);
	const started = Date.now();
	try {
		const out = await runAppleScript(`
tell application "Messages"
    send "${body}" to chat id "${chat}"
end tell`);
		const failed = await sendFailure(guid, started);
		if (failed) throw new ToolFailure("message_not_sent", failed);
		return out;
	} catch (error) {
		if (error instanceof ToolFailure) throw error;
		throwAppleFailure(error, MESSAGES_SEND_SUMMARIES);
	}
}

async function sendMessage(phoneNumber: string, message: string) {
	if (!looksLikeHandle(phoneNumber)) {
		throw new ToolFailure(
			"bad_request",
			`Nothing was sent: "${phoneNumber}" is a name, and a message needs a phone number or email `
			+ "address. Read their conversation to get it, or look the name up in Contacts.",
		);
	}
	const buddy = escapeAppleScriptString(phoneNumber);
	const body = escapeAppleScriptString(message);
	const started = Date.now();
	try {
		const out = await runAppleScript(`
tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${buddy}"
    send "${body}" to targetBuddy
end tell`);
		const failed = await sendFailure(phoneNumber, started);
		if (failed) throw new ToolFailure("message_not_sent", failed);
		return out;
	} catch (error) {
		if (error instanceof ToolFailure) throw error;
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
	/** Which conversation this came out of, when the query knows. Search sets it so a hit is a place
	 *  the caller can go, rather than a quotation with no thread attached. */
	chatId?: number;
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

export function decodeAttributedBody(hexString: string): { text: string; url?: string } {
	// READ, NOT GUESSED AT. What was here took the hex, ran `Buffer.toString()` over it as UTF-8, and
	// regex-matched XML patterns (`/NSString">(.*?)</`) that a typedstream does not contain. What came
	// back was the binary reinterpreted as text: on a real machine a message read
	// `https://s.sumup.com/77ojrn_q<ef><bf><bd>iI/<ef><bf><bd>`. It knew that artefact well enough to
	// carry a cleanup rule for it, `.replace(/\s*iI\s*[A-Z]\s*$/, "")`, which is the tell: it was
	// deleting the evidence of its own misreading rather than reading the format. Accents did not
	// survive it either, which for a French conversation is most of the message.
	const blob = Buffer.from(hexString, "hex");
	const text = typedstreamText(blob) ?? "";
	// The URL is taken from the DECODED text, not from a second pass over the binary: a link a person
	// sent is in what they wrote, and looking for it in the framing is how the framing got into the text.
	const url = text.match(/(https?:\/\/[^\s<"]+)/)?.[1];
	return { text, url };
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

/** What counts as this conversation, written ONCE so the page and the total are about the same set. */
function conversationWhere(phoneList: string): string {
	return `WHERE h.id IN (${phoneList})
                AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
                AND m.is_from_me IS NOT NULL  -- Ensure it's a real message
                AND m.item_type = 0  -- Regular messages only
                AND m.is_audio_message = 0  -- Skip audio messages`;
}

/** How many messages this conversation holds in total, so a page of it can say what it is a page OF.
 *
 *  `read` returned the last 10 of a long thread and rendered them as the whole conversation, which is
 *  the same fault `unread` had (10 of 70, silently) and the same one notes and contacts and mail search
 *  each had this week. Returns 0 rather than throwing: a total we could not get must not sink messages
 *  we did get, and `showing` degrades to the plain form on 0. */
async function countMessagesWith(phoneNumber: string): Promise<number> {
	try {
		const phoneFormats = handleCandidates(phoneNumber);
		if (phoneFormats.length === 0) return 0;
		const phoneList = phoneFormats.map((p) => `'${escapeSqlString(p)}'`).join(",");
		const { stdout } = await retryOperation(() =>
			execFileAsync("sqlite3", ["-json", CHAT_DB,
				`SELECT count(*) as n FROM message m INNER JOIN handle h ON h.ROWID = m.handle_id `
				+ conversationWhere(phoneList)]),
		);
		const rows = JSON.parse(stdout || "[]") as { n: number }[];
		return rows[0]?.n ?? 0;
	} catch {
		return 0;
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
            ${conversationWhere(phoneList)}
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

/** What counts as unread, written ONCE. The page and the total must be about the same set, and two
 *  copies of a WHERE clause stop being the same set the first time somebody edits one. */
const UNREAD_WHERE = `
            WHERE m.is_from_me = 0  -- Only messages from others
                AND m.is_read = 0   -- Only unread messages
                AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL OR m.cache_has_attachments = 1)
                AND m.is_audio_message = 0  -- Skip audio messages
                AND m.item_type = 0  -- Regular messages only`;

/** How many messages are unread in total, so a page of them can say what it is a page OF.
 *
 *  A count over the same join is a few milliseconds on an indexed sqlite table, which is what makes the
 *  honest answer affordable: `unread` said "Found 10 unread message(s)" on a Mac holding 70, with no
 *  hint that it had stopped. Returns 0 rather than throwing, because a total we could not get must not
 *  sink a page of messages we did get. */
async function countUnreadMessages(): Promise<number> {
	try {
		const { stdout } = await retryOperation(() =>
			execFileAsync("sqlite3", ["-json", CHAT_DB,
				`SELECT count(*) as n FROM message m INNER JOIN handle h ON h.ROWID = m.handle_id ${UNREAD_WHERE}`]),
		);
		const rows = JSON.parse(stdout || "[]") as { n: number }[];
		return rows[0]?.n ?? 0;
	} catch {
		return 0;
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
            ${UNREAD_WHERE}
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

/** A conversation, as somebody would pick one out of a list: who, when, and what was last said. */
export interface Conversation {
	handle: string;          // the phone number or email the thread is with
	name?: string;           // their name, when Contacts knows it
	lastMessage: string;
	date: string;
	fromMe: boolean;
}

/**
 * The most recent conversations, newest first, whether or not anything in them is unread.
 *
 * THE VERB THAT WAS MISSING, and its absence is what made the integration unusable. Asked "list the last
 * five messages I received", the only listing verb was `unread`, which answers a different question: on a
 * real Mac it returned 5 of 71 unread, all marketing from ten days earlier (SumUp, SFR, BIZAY), while the
 * message the person actually meant had arrived that afternoon and been read. There was no way to ask
 * "who has been talking to me lately", which is how anybody finds a thread.
 *
 * ONE ROW PER CONVERSATION, not per message. Ten messages from one person is one thing you are looking
 * for, and a list of the last twenty messages is one busy thread and nothing else.
 */
async function recentConversations(
	limit = 10,
	// HANDED IN, so a test can supply one without replacing the contacts MODULE for the whole run. The
	// first version mocked `../utils/contacts` and the suite that tests real Contacts batching went red
	// in the same run, five tests that had nothing to do with this change.
	resolveNames: (handles: string[]) => Promise<Map<string, string>> = contacts.namesForHandles,
): Promise<Conversation[]> {
	await ensureMessagesDBAccess();
	const capped = clampLimit(limit);
	try {
		const { stdout } = await retryOperation(() =>
			execFileAsync("sqlite3", ["-json", CHAT_DB, `
				SELECT
					h.id AS handle,
					CASE
						WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
						WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
						ELSE ''
					END AS body,
					CASE WHEN m.text IS NOT NULL AND m.text != '' THEN 0 ELSE 1 END AS is_hex,
					m.is_from_me AS from_me,
					datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS date
				FROM message m
				JOIN handle h ON h.ROWID = m.handle_id
				JOIN (
					SELECT handle_id, MAX(date) AS latest
					FROM message
					WHERE handle_id IS NOT NULL AND item_type = 0
					GROUP BY handle_id
				) last ON last.handle_id = m.handle_id AND last.latest = m.date
				WHERE m.item_type = 0
				ORDER BY m.date DESC
				LIMIT ${capped}`]),
		);
		const rows = JSON.parse(stdout || "[]") as {
			handle: string; body: string; is_hex: number; from_me: number; date: string;
		}[];
		// ONE CONTACTS LOOKUP FOR THE WHOLE PAGE, not one per row: `namesForHandles` is the batch form
		// and exists for exactly this. A name is a nicety here, so a Contacts denial must not sink the
		// list: the handles are still the answer.
		let names = new Map<string, string>();
		try {
			names = await resolveNames(rows.map((r) => r.handle));
		} catch { /* no Contacts: the numbers stand on their own */ }
		return rows.map((r) => {
			const text = r.is_hex ? decodeAttributedBody(r.body).text : r.body;
			return {
				handle: r.handle,
				name: names.get(r.handle),
				lastMessage: text || "[no text]",
				date: r.date,
				fromMe: r.from_me === 1,
			};
		});
	} catch (error) {
		throwMessagesDbFailure(error, "Could not read your conversations.");
	}
}

/**
 * Messages whose text contains `query`, newest first, across every conversation.
 *
 * SEARCHING WAS SIMPLY REFUSED before this: `search_messages` answered
 * "[not_supported] iMessage cannot do that, so nothing was searched", so a person who could not name the
 * exact handle had no route at all. Between that and `unread`, finding a message you had already read was
 * impossible.
 *
 * THE BODY IS ALMOST NEVER IN `text`, which decides the whole shape of this. Measured on a real Mac:
 * of 44,758 messages, SIXTY-THREE had `text` populated and 44,688 were `attributedBody` only. So there is
 * no useful `text LIKE` prefilter to push into SQL and no way around decoding; the rows come back and are
 * matched here.
 *
 * BOUNDED, AND IT SAYS SO. `scan` is how far back it looks, newest first, because a search must not walk
 * a 45,000-message history on every call. At roughly a kilobyte of hex per row that is also what keeps
 * the answer inside the child process's output buffer, which is the concrete thing that broke first: at
 * 3,000 rows the query came back as a bare "could not search", three retries deep, with the real cause
 * (a 2.9MB read into a 1MB default) nowhere in the message.
 */
/** What a search actually covered, so the answer can say it rather than imply "everything". */
export interface SearchCoverage {
	/** How many messages were decoded and looked at. */
	scanned: number;
	/** Whether the scan stopped at its ceiling, leaving older messages unread. */
	bounded: boolean;
	/** The oldest message the scan reached, for a sentence a person can act on. */
	oldest?: string;
}

/**
 * Every message, not the recent ones.
 *
 * THE CEILING WAS A GUESS AND THE MEASUREMENT REFUTED IT. This scanned the most recent 1,200 messages
 * and then said "No messages found matching X", which is a false statement about somebody's messages.
 * Caught on a real Mac, by a person, when a run searched for "meeting" and was told there were none:
 *
 *     scan     rows     hits for "meeting"   sql     decode
 *     1,200    1,200      0                   29ms     7ms
 *     5,000    5,000     27                   30ms    12ms
 *     all     30,132    232                  120ms    77ms
 *
 * 232 matches hidden to save 160 milliseconds. The whole history is a fifth of a second, so the ceiling
 * exists only to stop an unbounded buffer, not to save time, and it is set where the buffer is the
 * constraint rather than where a guess about "recent enough" put it.
 *
 * AND WHEN IT IS HIT, THE ANSWER SAYS SO. That is the half that matters: a bound nobody is told about
 * turns into "you have no such messages", which is exactly the quietly-partial answer the charter is
 * about. `notes` already reads its whole store and reports truncation; this is the same rule.
 */
async function searchMessages(
	query: string,
	limit = 10,
	scan = 50_000,
): Promise<{ messages: Message[]; coverage: SearchCoverage }> {
	await ensureMessagesDBAccess();
	const capped = clampLimit(limit);
	// AND OVER THE WORDS, not one literal string: see `queryTerms`. "Shivani Hamilton" used to mean
	// those two words adjacent and in that order, which matched nothing in a thread full of both.
	const terms = queryTerms(query);
	if (!terms.length) return { messages: [], coverage: { scanned: 0, bounded: false } };
	try {
		const { stdout } = await retryOperation(() =>
			// A ROOM BIG ENOUGH FOR WHAT WE ASKED FOR. Every other query here returns tens of rows of
			// plain text; this one returns up to `scan` rows of hex, which is a different order of size.
			execFileAsync("sqlite3", ["-json", CHAT_DB, `
				SELECT
					h.id AS sender,
					cmj.chat_id AS chat_id,
					CASE
						WHEN m.text IS NOT NULL AND m.text != '' THEN m.text
						WHEN m.attributedBody IS NOT NULL THEN hex(m.attributedBody)
						ELSE ''
					END AS body,
					CASE WHEN m.text IS NOT NULL AND m.text != '' THEN 0 ELSE 1 END AS is_hex,
					m.is_from_me AS from_me,
					datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS date
				FROM message m
				JOIN handle h ON h.ROWID = m.handle_id
				LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
				WHERE m.item_type = 0
					AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
				ORDER BY m.date DESC
				LIMIT ${Math.max(capped, scan)}`],
				// ~1KB of hex per row measured, so 50,000 rows is ~48MB at the worst and the room is
				// sized for it with headroom. Too small a buffer fails as a bare "could not search",
				// which is how the first attempt died three retries deep.
				{ maxBuffer: 256 * 1024 * 1024 }),
		);
		const rows = JSON.parse(stdout || "[]") as {
			sender: string; chat_id: number | null; body: string; is_hex: number;
			from_me: number; date: string;
		}[];
		const hits: Message[] = [];
		// EVERY ROW IS LOOKED AT even once enough hits are in hand, because the coverage sentence has to
		// be true: stopping early and then saying "searched 50,000" would be its own quiet lie. The
		// decode is 77ms for the whole history, so there is nothing to save by stopping.
		for (const r of rows) {
			const text = (r.is_hex ? decodeAttributedBody(r.body).text : r.body) ?? "";
			if (!matchesQuery(text, terms)) continue;
			if (hits.length >= capped) continue;
			// THE THREAD IT CAME FROM, so a hit is somewhere to go rather than a dead end. A search
			// found the right message ("Nice to see you today Shivani") and the caller then had no way
			// to open the conversation it was sitting in.
			hits.push({ content: text, date: r.date, sender: r.sender, is_from_me: r.from_me === 1,
				chatId: r.chat_id ?? undefined });
		}
		return {
			messages: hits,
			coverage: {
				scanned: rows.length,
				bounded: rows.length >= Math.max(capped, scan),
				oldest: rows.length ? rows[rows.length - 1]!.date : undefined,
			},
		};
	} catch (error) {
		throwMessagesDbFailure(error, "Could not search your messages.");
	}
}

/** When each handle was last in touch, for deciding between two people with the same name. */
async function lastSeenByHandle(): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	try {
		const { stdout } = await retryOperation(() =>
			execFileAsync("sqlite3", ["-json", CHAT_DB, `
				SELECT h.id AS handle,
					datetime(MAX(m.date)/1000000000 + 978307200, 'unixepoch', 'localtime') AS date
				FROM message m JOIN handle h ON h.ROWID = m.handle_id
				WHERE m.item_type = 0
				GROUP BY h.id`]),
		);
		for (const r of JSON.parse(stdout || "[]") as { handle: string; date: string }[]) {
			out.set(r.handle, r.date);
		}
	} catch { /* no history readable: every candidate is simply "never in touch" */ }
	return out;
}

/**
 * Who a name means, resolved against Contacts and who has actually been in touch.
 *
 * Returns the resolution rather than a thread, because two of the three answers are not a thread: several
 * people can share a name, and Contacts may know nobody by it at all. The caller decides what to say, and
 * the one thing it must never say for `unknown` is "there are no messages from them" — see `recipient.ts`.
 */
async function whoIsMeant(
	name: string,
	findCards: (q: string) => Promise<{ name: string; phones: string[]; emails: string[] }[]> =
		contacts.findContacts,
): Promise<Resolution> {
	let cards: { name: string; phones: string[]; emails: string[] }[] = [];
	try {
		cards = await findCards(name);
	} catch {
		// Contacts denied or unreadable. NOT "nobody is called that": nothing was read, so nothing is
		// known either way, and saying otherwise states a fact about a book never opened.
		return { kind: "cannot-ask" };
	}
	return resolveRecipient(cards, await lastSeenByHandle());
}

export default {
	/** The hard ceiling on one read, so a caller can say "50 is the most" instead of
	 *  advising somebody to ask for a hundred and hand them fifty again. */
	maxMessages: () => CONFIG.MAX_MESSAGES,
	countUnreadMessages,
	countMessagesWith,
	sendMessage,
	// THE CONVERSATION LAYER, reached through the same module the tool already loads, so index.ts does
	// not grow a second way of getting at messages.
	conversationsNamed,
	conversationsForHandle,
	sendToConversation,
	whoIsMeant,
	listConversations,
	readConversation,
	readMessages,
	scheduleMessage,
	getUnreadMessages,
	recentConversations,
	searchMessages,
	lastSeenByHandle,
};
