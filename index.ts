#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import tools from "./tools";
import { isRecurrence, type Recurrence } from "./utils/eventkit";

// Per-app filtering. A host application exposes only the Apple apps the user has toggled
// on by passing APPLE_MCP_ENABLED_APPS as a comma-separated list of tool names. Tool names map 1:1
// to apps (contacts, notes, messages, reminders, calendar). Unset => every tool is exposed; an empty
// value => nothing is exposed. This gates BOTH the advertised tool list and the dispatch switch, so
// a disabled app is invisible and uncallable rather than merely hidden.
const ENABLED_APPS: ReadonlySet<string> | null = (() => {
	const raw = process.env.APPLE_MCP_ENABLED_APPS;
	if (raw === undefined) return null; // no filtering
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
})();

function isAppEnabled(toolName: string): boolean {
	return ENABLED_APPS === null || ENABLED_APPS.has(toolName.toLowerCase());
}

// Safe mode implementation - lazy loading of modules
let useEagerLoading = true;
let loadingTimeout: ReturnType<typeof setTimeout> | null = null;
let safeModeFallback = false;

console.error("Starting apple-mcp server...");

// Placeholders for modules - will either be loaded eagerly or lazily
let contacts: typeof import("./utils/contacts").default | null = null;
let notes: typeof import("./utils/notes").default | null = null;
let message: typeof import("./utils/message").default | null = null;
let reminders: typeof import("./utils/reminders").default | null = null;

let calendar: typeof import("./utils/calendar").default | null = null;

// Type map for module names to their types
type ModuleMap = {
	contacts: typeof import("./utils/contacts").default;
	notes: typeof import("./utils/notes").default;
	message: typeof import("./utils/message").default;
	reminders: typeof import("./utils/reminders").default;
	calendar: typeof import("./utils/calendar").default;
};

// Helper function for lazy module loading
async function loadModule<
	T extends
		| "contacts"
		| "notes"
		| "message"
		| "reminders"
		| "calendar"
>(moduleName: T): Promise<ModuleMap[T]> {
	if (safeModeFallback) {
		console.error(`Loading ${moduleName} module on demand (safe mode)...`);
	}

	try {
		switch (moduleName) {
			case "contacts":
				if (!contacts) contacts = (await import("./utils/contacts")).default;
				return contacts as ModuleMap[T];
			case "notes":
				if (!notes) notes = (await import("./utils/notes")).default;
				return notes as ModuleMap[T];
			case "message":
				if (!message) message = (await import("./utils/message")).default;
				return message as ModuleMap[T];
			case "reminders":
				if (!reminders) reminders = (await import("./utils/reminders")).default;
				return reminders as ModuleMap[T];
			case "calendar":
				if (!calendar) calendar = (await import("./utils/calendar")).default;
				return calendar as ModuleMap[T];
			default:
				throw new Error(`Unknown module: ${moduleName}`);
		}
	} catch (e) {
		console.error(`Error loading module ${moduleName}:`, e);
		throw e;
	}
}

// Set a timeout to switch to safe mode if initialization takes too long
loadingTimeout = setTimeout(() => {
	console.error(
		"Loading timeout reached. Switching to safe mode (lazy loading...)",
	);
	useEagerLoading = false;
	safeModeFallback = true;

	// Clear the references to any modules that might be in a bad state
	contacts = null;
	notes = null;
	message = null;
	reminders = null;
	calendar = null;

	// Proceed with server setup
	initServer();
}, 5000); // 5 second timeout

// Eager loading attempt
async function attemptEagerLoading() {
	try {
		console.error("Attempting to eagerly load modules...");

		// Try to import all modules
		contacts = (await import("./utils/contacts")).default;
		console.error("- Contacts module loaded successfully");

		notes = (await import("./utils/notes")).default;
		console.error("- Notes module loaded successfully");

		message = (await import("./utils/message")).default;
		console.error("- Message module loaded successfully");


		reminders = (await import("./utils/reminders")).default;
		console.error("- Reminders module loaded successfully");


		calendar = (await import("./utils/calendar")).default;
		console.error("- Calendar module loaded successfully");


		// If we get here, clear the timeout and proceed with eager loading
		if (loadingTimeout) {
			clearTimeout(loadingTimeout);
			loadingTimeout = null;
		}

		console.error("All modules loaded successfully, using eager loading mode");
		initServer();
	} catch (error) {
		console.error("Error during eager loading:", error);
		console.error("Switching to safe mode (lazy loading)...");

		// Clear any timeout if it exists
		if (loadingTimeout) {
			clearTimeout(loadingTimeout);
			loadingTimeout = null;
		}

		// Switch to safe mode
		useEagerLoading = false;
		safeModeFallback = true;

		// Clear the references to any modules that might be in a bad state
		contacts = null;
		notes = null;
		message = null;
		reminders = null;
			calendar = null;

		// Initialize the server in safe mode
		initServer();
	}
}

// Attempt eager loading first
attemptEagerLoading();

// Main server object
let server: Server;

// Initialize the server and set up handlers
function initServer() {
	console.error(
		`Initializing server in ${safeModeFallback ? "safe" : "standard"} mode...`,
	);

	server = new Server(
		{
			name: "Apple MCP tools",
			version: "1.0.0",
		},
		{
			capabilities: {
				tools: {},
			},
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.filter((tool) => isAppEnabled(tool.name)),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		try {
			const { name, arguments: args } = request.params;

			if (!args) {
				throw new Error("No arguments provided");
			}

			if (!isAppEnabled(name)) {
				return {
					content: [
						{
							type: "text",
							text: `The "${name}" app is disabled. Enable it via the APPLE_MCP_ENABLED_APPS environment variable to use this tool.`,
						},
					],
					isError: true,
				};
			}

			switch (name) {
				case "contacts": {
					if (!isContactsArgs(args)) {
						throw new Error("Invalid arguments for contacts tool");
					}

					try {
						const contactsModule = await loadModule("contacts");
						// Default: search when a name is given, otherwise list everything.
						const operation = args.operation ?? (args.name ? "search" : "list");

						switch (operation) {
							case "list": {
								const allNumbers = await contactsModule.getAllNumbers();
								const contactCount = Object.keys(allNumbers).length;
								if (contactCount === 0) {
									return {
										content: [
											{
												type: "text",
												text: "No contacts with phone numbers found in the address book.",
											},
										],
										isError: false,
									};
								}
								const formatted = Object.entries(allNumbers)
									.filter(([, phones]) => phones.length > 0)
									.map(([name, phones]) => `${name}: ${phones.join(", ")}`);
								return {
									content: [
										{
											type: "text",
											text: `Found ${contactCount} contacts:\n\n${formatted.join("\n")}`,
										},
									],
									isError: false,
								};
							}

							case "search": {
								if (!args.name) {
									throw new Error("A name is required for the search operation.");
								}
								const matches = await contactsModule.searchContacts(args.name);
								if (matches.length === 0) {
									return {
										content: [
											{
												type: "text",
												text: `No contact found matching "${args.name}".`,
											},
										],
										isError: false,
									};
								}
								const text = matches
									.map((c) => {
										const lines = [c.name];
										if (c.phones.length) lines.push(`  phones: ${c.phones.join(", ")}`);
										if (c.emails.length) lines.push(`  emails: ${c.emails.join(", ")}`);
										return lines.join("\n");
									})
									.join("\n\n");
								return {
									content: [
										{
											type: "text",
											text: `Found ${matches.length} contact(s):\n\n${text}`,
										},
									],
									isError: false,
								};
							}

							case "create": {
								const created = await contactsModule.createContact({
									firstName: args.firstName,
									lastName: args.lastName,
									organization: args.organization,
									phones: args.phones,
									emails: args.emails,
									phoneLabel: args.phoneLabel,
									emailLabel: args.emailLabel,
								});
								const detail: string[] = [];
								if (created.phones.length) detail.push(`phones: ${created.phones.join(", ")}`);
								if (created.emails.length) detail.push(`emails: ${created.emails.join(", ")}`);
								return {
									content: [
										{
											type: "text",
											text: `Created contact "${created.name}"${detail.length ? ` (${detail.join("; ")})` : ""}.`,
										},
									],
									isError: false,
								};
							}

							case "update": {
								if (!args.name) {
									throw new Error("The 'name' of an existing contact is required to update it.");
								}
								const res = await contactsModule.updateContact({
									name: args.name,
									firstName: args.firstName,
									lastName: args.lastName,
									organization: args.organization,
									addPhones: args.addPhones,
									addEmails: args.addEmails,
									removePhones: args.removePhones,
									removeEmails: args.removeEmails,
									phoneLabel: args.phoneLabel,
									emailLabel: args.emailLabel,
								});
								return {
									content: [
										{
											type: "text",
											text: res.updated
												? `Updated contact "${res.name ?? args.name}".`
												: `No contact found matching "${args.name}" to update.`,
										},
									],
									isError: !res.updated,
								};
							}

							case "delete": {
								if (!args.name) {
									throw new Error("The 'name' of an existing contact is required to delete it.");
								}
								const res = await contactsModule.deleteContact(args.name);
								return {
									content: [
										{
											type: "text",
											text: res.deleted
												? `Deleted contact "${res.name ?? args.name}".`
												: `No contact found matching "${args.name}" to delete.`,
										},
									],
									isError: !res.deleted,
								};
							}

							default:
								throw new Error(`Unknown contacts operation: ${operation}`);
						}
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text",
									text: errorMessage.includes("access")
										? errorMessage
										: `Error accessing contacts: ${errorMessage}`,
								},
							],
							isError: true,
						};
					}
				}

				case "notes": {
					if (!isNotesArgs(args)) {
						throw new Error("Invalid arguments for notes tool");
					}

					try {
						const notesModule = await loadModule("notes");

						switch (args.operation) {
							case "search": {
								const hits = await notesModule.searchNotes(args.searchText as string);
								return {
									content: [
										{
											type: "text",
											text: hits.length
												? hits.map((h) => `${h.name}\n  id: ${h.id}`).join("\n\n")
												: `No notes found with a title matching "${args.searchText}".`,
										},
									],
									isError: false,
								};
							}

							case "list": {
								const result = await notesModule.listNotes({
									folderName: args.folderName,
									fromDate: args.fromDate,
									toDate: args.toDate,
									limit: args.limit,
								});
								if (!result.success) {
									return {
										content: [{ type: "text", text: result.message ?? "Folder not found." }],
										isError: true,
									};
								}
								const notes = result.notes ?? [];
								return {
									content: [
										{
											type: "text",
											text: notes.length
												? notes
														.map((n) => {
															const when = n.modificationDate
																? ` (modified ${n.modificationDate.toISOString()})`
																: "";
															const idLine = n.id ? `\n  id: ${n.id}` : "";
															return `${n.name}${when}${idLine}\n${n.content}`;
														})
														.join("\n\n")
												: args.folderName
													? `No notes in folder "${args.folderName}".`
													: "No notes exist.",
										},
									],
									isError: false,
								};
							}

							case "get": {
								const note = await notesModule.getNote({
									title: args.title,
									noteId: args.noteId,
								});
								if (!note) {
									return {
										content: [
											{
												type: "text",
												text: `No note found for ${args.noteId ? `id "${args.noteId}"` : `title "${args.title}"`}.`,
											},
										],
										isError: true,
									};
								}
								const meta = [
									note.folderName ? `Folder: ${note.folderName}` : null,
									note.id ? `id: ${note.id}` : null,
									note.modificationDate ? `Modified: ${note.modificationDate.toISOString()}` : null,
								]
									.filter(Boolean)
									.join("\n");
								return {
									content: [{ type: "text", text: `${note.name}\n${meta}\n\n${note.content}` }],
									isError: false,
								};
							}

							case "create": {
								const result = await notesModule.createNote({
									title: args.title as string,
									body: args.body,
									format: args.format,
									folderName: args.folderName,
								});
								return {
									content: [
										{
											type: "text",
											text: result.success
												? `Created note "${args.title}" in folder "${result.folderName}"${result.createdFolder ? " (new folder created)" : ""}.`
												: `Failed to create note: ${result.message}`,
										},
									],
									isError: !result.success,
								};
							}

							case "update": {
								const result = await notesModule.updateNote({
									title: args.title,
									noteId: args.noteId,
									body: args.body as string,
									format: args.format,
									mode: args.mode,
								});
								return {
									content: [
										{
											type: "text",
											text: result.success
												? `${args.mode === "append" ? "Appended to" : "Updated"} note "${result.name ?? args.title ?? result.id}".`
												: `Failed to update note: ${result.message}`,
										},
									],
									isError: !result.success,
								};
							}

							case "delete": {
								const result = await notesModule.deleteNote({
									title: args.title,
									noteId: args.noteId,
								});
								return {
									content: [
										{
											type: "text",
											text: result.success
												? `Deleted note "${result.name ?? args.title ?? result.id}".`
												: `Failed to delete note: ${result.message}`,
										},
									],
									isError: !result.success,
								};
							}

							case "listFolders": {
								const folders = await notesModule.listFolders();
								return {
									content: [
										{
											type: "text",
											text: folders.length
												? folders
														.map((f) => `${f.name}${f.count != null ? ` (${f.count} notes)` : ""}`)
														.join("\n")
												: "No folders exist.",
										},
									],
									isError: false,
								};
							}

							case "createFolder": {
								const result = await notesModule.createFolder(args.folderName as string);
								return {
									content: [
										{
											type: "text",
											text: result.success
												? result.created
													? `Created folder "${result.name}".`
													: `Folder "${result.name}" already exists.`
												: `Failed to create folder: ${result.message}`,
										},
									],
									isError: !result.success,
								};
							}

							default:
								throw new Error(`Unknown operation: ${args.operation}`);
						}
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						// A PermissionError's message contains "access is not granted" → surfaced verbatim.
						return {
							content: [
								{
									type: "text",
									text: errorMessage.includes("access")
										? errorMessage
										: `Error accessing notes: ${errorMessage}`,
								},
							],
							isError: true,
						};
					}
				}

				case "messages": {
					if (!isMessagesArgs(args)) {
						throw new Error("Invalid arguments for messages tool");
					}

					try {
						const messageModule = await loadModule("message");

						switch (args.operation) {
							case "fetch": {
								// Who to fetch: a contact name → all their handles (one cheap lookup), or an
								// explicit phoneNumber/handle. Omitted → recent messages across everyone.
								let handles: string[] | undefined;
								let known: string | undefined; // a name we already know → skip per-message lookups
								if (args.contactName) {
									const contactsModule = await loadModule("contacts");
									handles = await contactsModule.findHandles(args.contactName);
									if (handles.length === 0) {
										return {
											content: [{ type: "text", text: `No contact found matching "${args.contactName}".` }],
											isError: false,
										};
									}
									known = args.contactName;
								} else if (args.phoneNumber) {
									handles = [args.phoneNumber];
								}

								const messages = await messageModule.fetchMessages({
									handles,
									limit: args.limit,
									status: args.status,
									from: args.from,
								});
								if (messages.length === 0) {
									return { content: [{ type: "text", text: "No messages found." }], isError: false };
								}

								// Resolve sender display names. If we already know the person, reuse it; otherwise
								// resolve the DISTINCT senders once (findContactByPhone shares one cached scan).
								const nameByHandle = new Map<string, string>();
								if (!known) {
									const contactsModule = await loadModule("contacts");
									const senders = Array.from(
										new Set(messages.filter((m) => !m.is_from_me).map((m) => m.sender)),
									);
									for (const s of senders) {
										const n = await contactsModule.findContactByPhone(s);
										if (n) nameByHandle.set(s, n);
									}
								}

								const lines = messages.map((m) => {
									const when = new Date(m.date).toLocaleString();
									const who = m.is_from_me ? "Me" : known ?? nameByHandle.get(m.sender) ?? m.sender;
									const tag = m.is_from_me ? "" : m.is_read ? " (read)" : " (unread)";
									return `[${when}] ${who}${tag}: ${m.content}`;
								});

								return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
							}

							case "conversations": {
								const conversations = await messageModule.fetchConversations({ limit: args.limit });
								if (conversations.length === 0) {
									return { content: [{ type: "text", text: "No conversations found." }], isError: false };
								}

								// Title each 1:1 thread with the contact's display name where we can resolve it; group
								// threads use their display_name (or the chat identifier as a fallback).
								const contactsModule = await loadModule("contacts");
								const lines: string[] = [];
								for (const c of conversations) {
									let title: string;
									if (c.is_group) {
										title = c.display_name || `Group (${c.chat_identifier})`;
									} else {
										const name = await contactsModule.findContactByPhone(c.chat_identifier);
										title = name ?? c.chat_identifier;
									}
									const m = c.last_message;
									const when = new Date(m.date).toLocaleString();
									const who = m.is_from_me ? "Me" : title;
									const tag = m.is_from_me ? "" : m.is_read ? " (read)" : " (unread)";
									lines.push(`[${when}] ${title} — ${who}${tag}: ${m.content}`);
								}

								return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
							}

							case "send": {
								if (!args.phoneNumber || !args.message) {
									throw new Error("phoneNumber and message are required for send");
								}
								const sent = await messageModule.sendMessage(args.phoneNumber, args.message);
								return {
									content: [{ type: "text", text: `Message sent to ${sent.handle}` }],
									isError: false,
								};
							}

							case "schedule": {
								if (!args.phoneNumber || !args.message || !args.scheduledTime) {
									throw new Error("phoneNumber, message, and scheduledTime are required for schedule");
								}
								const scheduledMsg = await messageModule.scheduleMessage(
									args.phoneNumber,
									args.message,
									new Date(args.scheduledTime),
								);
								return {
									content: [{ type: "text", text: `Message scheduled for ${scheduledMsg.handle} at ${scheduledMsg.scheduledTime}` }],
									isError: false,
								};
							}

							default:
								throw new Error(`Unknown operation: ${args.operation}`);
						}
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						return {
							content: [{ type: "text", text: errorMessage.includes("access") ? errorMessage : `Error with messages operation: ${errorMessage}` }],
							isError: true,
						};
					}
				}

				case "reminders": {
					if (!isRemindersArgs(args)) {
						throw new Error("Invalid arguments for reminders tool");
					}

					try {
						const remindersModule = await loadModule("reminders");
						const { operation } = args;

						if (operation === "list") {
							const lists = await remindersModule.getAllLists();
							const allReminders = await remindersModule.getAllReminders();
							return {
								content: [
									{
										type: "text",
										text: `Found ${lists.length} lists and ${allReminders.length} reminders.`,
									},
								],
								lists,
								reminders: allReminders,
								isError: false,
							};
						} else if (operation === "search") {
							const { searchText } = args;
							const results = await remindersModule.searchReminders(searchText!);
							// The ITEMS go in the text: MCP clients show content text only, and a bare
							// "Found 4" left the caller knowing nothing it could act on. The native
							// search covers every list, so there is no partial-coverage caveat.
							const lines = results.map(
								(r) =>
									`- ${r.name}${r.dueDate ? ` (due ${r.dueDate})` : ""}${r.recurrence ? ` (repeats ${r.recurrence})` : ""}${r.completed ? " [completed]" : ""} [list: ${r.listName}]${r.id ? ` [id: ${r.id}]` : ""}`,
							);
							return {
								content: [
									{
										type: "text",
										text:
											results.length > 0
												? `Found ${results.length} reminders matching "${searchText}":\n${lines.join("\n")}`
												: `No reminders found matching "${searchText}".`,
									},
								],
								reminders: results,
								isError: false,
							};
						} else if (operation === "get") {
							const { searchText } = args;
							const reminder = await remindersModule.getReminderByName(searchText!);
							return {
								content: [
									{
										type: "text",
										text: reminder
											? `Found reminder "${reminder.name}".`
											: `No reminder found matching "${searchText}".`,
									},
								],
								reminder: reminder ?? undefined,
								isError: false,
							};
						} else if (operation === "open") {
							const { searchText } = args;
							const result = await remindersModule.openReminder(searchText!);
							return {
								content: [
									{
										type: "text",
										text: result.success
											? `Opened Reminders app. Found reminder: ${result.reminder?.name}`
											: result.message,
									},
								],
								...result,
								isError: !result.success,
							};
						} else if (operation === "create") {
							const { name, listName, notes, dueDate, recurrence } = args;
							const result = await remindersModule.createReminder(
								name!,
								listName,
								notes,
								dueDate,
								recurrence,
							);
							return {
								content: [
									{
										type: "text",
										text: `Created reminder "${result.name}"${listName ? ` in list "${listName}"` : ""}${result.recurrence ? `, repeating ${result.recurrence}` : ""}.`,
									},
								],
								success: true,
								reminder: result,
								isError: false,
							};
						} else if (operation === "update") {
							const { searchText, name, notes, dueDate, completed, recurrence } = args;
							const result = await remindersModule.updateReminder({
								searchText: searchText!,
								name,
								notes,
								dueDate,
								completed,
								recurrence,
							});
							return {
								content: [
									{
										type: "text",
										text: result.updated
											? `Updated reminder "${result.name}"${result.recurrence ? `, repeating ${result.recurrence}` : ""}.`
											: `No reminder found matching "${searchText}" to update.`,
									},
								],
								success: result.updated,
								isError: false,
							};
						} else if (operation === "complete" || operation === "uncomplete") {
							const { searchText } = args;
							const completed = operation === "complete";
							const result = await remindersModule.setReminderCompleted(
								searchText!,
								completed,
							);
							return {
								content: [
									{
										type: "text",
										text: result.updated
											? `Marked reminder "${result.name}" ${completed ? "completed" : "not completed"}.`
											: `No reminder found matching "${searchText}".`,
									},
								],
								success: result.updated,
								isError: false,
							};
						} else if (operation === "delete") {
							const { searchText } = args;
							const result = await remindersModule.deleteReminder(searchText!);
							return {
								content: [
									{
										type: "text",
										text: result.deleted
											? `Deleted reminder "${result.name}".`
											: `No reminder found matching "${searchText}" to delete.`,
									},
								],
								success: result.deleted,
								isError: false,
							};
						} else if (operation === "listById") {
							const { listId, props } = args;
							const results = await remindersModule.getRemindersFromListById(
								listId!,
								props,
							);
							return {
								content: [
									{
										type: "text",
										text:
											results.length > 0
												? `Found ${results.length} reminders in list with ID "${listId}".`
												: `No reminders found in list with ID "${listId}".`,
									},
								],
								reminders: results,
								isError: false,
							};
						}

						return {
							content: [{ type: "text", text: "Unknown operation" }],
							isError: true,
						};
					} catch (error) {
						console.error("Error in reminders tool:", error);
						const errorMessage = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text",
									text: errorMessage.includes("access")
										? errorMessage
										: `Error in reminders tool: ${errorMessage}`,
								},
							],
							isError: true,
						};
					}
				}

				case "calendar": {
					if (!isCalendarArgs(args)) {
						throw new Error("Invalid arguments for calendar tool");
					}

					try {
						const calendarModule = await loadModule("calendar");
						const { operation } = args;

						switch (operation) {
							case "search": {
								const { searchText, limit, fromDate, toDate } = args;
								const events = await calendarModule.searchEvents(
									searchText!,
									limit,
									fromDate,
									toDate,
								);

								return {
									content: [
										{
											type: "text",
											text:
												events.length > 0
													? `Found ${events.length} events matching "${searchText}":\n\n${events
															.map(
																(event) =>
																	`${event.title} (${new Date(event.startDate!).toLocaleString()} - ${new Date(event.endDate!).toLocaleString()})\n` +
																	`Location: ${event.location || "Not specified"}\n` +
																	`Calendar: ${event.calendarName}\n` +
																	`ID: ${event.id}\n` +
																	`${event.notes ? `Notes: ${event.notes}\n` : ""}`,
															)
															.join("\n\n")}`
													: `No events found matching "${searchText}".`,
										},
									],
									isError: false,
								};
							}

							case "open": {
								const { eventId } = args;
								const result = await calendarModule.openEvent(eventId!);

								return {
									content: [
										{
											type: "text",
											text: result.success
												? result.message
												: `Error opening event: ${result.message}`,
										},
									],
									isError: !result.success,
								};
							}

							case "list": {
								const { limit, fromDate, toDate } = args;
								const events = await calendarModule.getEvents(limit, fromDate, toDate);

								const startDateText = fromDate
									? new Date(fromDate).toLocaleDateString()
									: "today";
								const endDateText = toDate
									? new Date(toDate).toLocaleDateString()
									: "next 7 days";

								return {
									content: [
										{
											type: "text",
											text:
												events.length > 0
													? `Found ${events.length} events from ${startDateText} to ${endDateText}:\n\n${events
															.map(
																(event) =>
																	`${event.title} (${new Date(event.startDate!).toLocaleString()} - ${new Date(event.endDate!).toLocaleString()})\n` +
																	`Location: ${event.location || "Not specified"}\n` +
																	`Calendar: ${event.calendarName}\n` +
																	`ID: ${event.id}`,
															)
															.join("\n\n")}`
													: `No events found from ${startDateText} to ${endDateText}.`,
										},
									],
									isError: false,
								};
							}

							case "create": {
								const {
									title,
									startDate,
									endDate,
									location,
									notes,
									isAllDay,
									calendarName,
									recurrence,
								} = args;
								const result = await calendarModule.createEvent(
									title!,
									startDate!,
									endDate!,
									location,
									notes,
									isAllDay,
									calendarName,
									recurrence,
								);
								return {
									content: [
										{
											type: "text",
											text: result.success
												? `${result.message} Event scheduled from ${new Date(startDate!).toLocaleString()} to ${new Date(endDate!).toLocaleString()}${result.eventId ? `\nEvent ID: ${result.eventId}` : ""}`
												: `Error creating event: ${result.message}`,
										},
									],
									isError: !result.success,
								};
							}

							case "update": {
								const {
									eventId,
									title,
									fromDate,
									toDate,
									newTitle,
									newStartDate,
									newEndDate,
									newLocation,
									newNotes,
									recurrence,
								} = args;
								const result = await calendarModule.updateEvent(
									{ eventId, title, fromDate, toDate },
									{ newTitle, newStartDate, newEndDate, newLocation, newNotes, recurrence },
								);

								let text: string;
								if (result.success) {
									text = `${result.message}${result.eventId ? `\nEvent ID: ${result.eventId}` : ""}`;
								} else if (result.candidates && result.candidates.length > 0) {
									text =
										`${result.message}\n\n${result.candidates
											.map(
												(c) =>
													`${c.title} (${c.start ? new Date(c.start).toLocaleString() : "no start"})\nID: ${c.id}`,
											)
											.join("\n\n")}`;
								} else {
									text = `Error updating event: ${result.message}`;
								}

								return {
									content: [{ type: "text", text }],
									isError: !result.success,
								};
							}

							case "delete": {
								const { eventId, title, fromDate, toDate } = args;
								const result = await calendarModule.deleteEvent({
									eventId,
									title,
									fromDate,
									toDate,
								});

								let text: string;
								if (result.success) {
									text = result.message;
								} else if (result.candidates && result.candidates.length > 0) {
									text =
										`${result.message}\n\n${result.candidates
											.map(
												(c) =>
													`${c.title} (${c.start ? new Date(c.start).toLocaleString() : "no start"})\nID: ${c.id}`,
											)
											.join("\n\n")}`;
								} else {
									text = `Error deleting event: ${result.message}`;
								}

								return {
									content: [{ type: "text", text }],
									isError: !result.success,
								};
							}

							default:
								throw new Error(`Unknown calendar operation: ${operation}`);
						}
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						return {
							content: [
								{
									type: "text",
									text: errorMessage.includes("access")
										? errorMessage
										: `Error in calendar tool: ${errorMessage}`,
								},
							],
							isError: true,
						};
					}
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown tool: ${name}` }],
						isError: true,
					};
			}
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `Error: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			};
		}
	});

	// Start the server transport
	console.error("Setting up MCP server transport...");

	(async () => {
		try {
			console.error("Initializing transport...");
			const transport = new StdioServerTransport();

			// Ensure stdout is only used for JSON messages
			console.error("Setting up stdout filter...");
			const originalStdoutWrite = process.stdout.write.bind(process.stdout);
			process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
				// Only allow JSON messages to pass through
				if (typeof chunk === "string" && !chunk.startsWith("{")) {
					console.error("Filtering non-JSON stdout message");
					return true; // Silently skip non-JSON messages
				}
				return originalStdoutWrite(chunk, encoding, callback);
			};

			console.error("Connecting transport to server...");
			await server.connect(transport);
			console.error("Server connected successfully!");
		} catch (error) {
			console.error("Failed to initialize MCP server:", error);
			process.exit(1);
		}
	})();
}

// Helper functions for argument type checking
function isContactsArgs(args: unknown): args is {
	operation?: "list" | "search" | "create" | "update" | "delete";
	name?: string;
	firstName?: string;
	lastName?: string;
	organization?: string;
	phones?: string[];
	emails?: string[];
	addPhones?: string[];
	addEmails?: string[];
	removePhones?: string[];
	removeEmails?: string[];
	phoneLabel?: string;
	emailLabel?: string;
} {
	if (typeof args !== "object" || args === null) return false;
	const a = args as Record<string, unknown>;
	const isStr = (v: unknown) => v === undefined || typeof v === "string";
	const isStrArr = (v: unknown) =>
		v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));
	if (
		a.operation !== undefined &&
		!["list", "search", "create", "update", "delete"].includes(a.operation as string)
	)
		return false;
	return (
		isStr(a.name) &&
		isStr(a.firstName) &&
		isStr(a.lastName) &&
		isStr(a.organization) &&
		isStr(a.phoneLabel) &&
		isStr(a.emailLabel) &&
		isStrArr(a.phones) &&
		isStrArr(a.emails) &&
		isStrArr(a.addPhones) &&
		isStrArr(a.addEmails) &&
		isStrArr(a.removePhones) &&
		isStrArr(a.removeEmails)
	);
}

function isNotesArgs(args: unknown): args is {
	operation:
		| "search"
		| "list"
		| "get"
		| "create"
		| "update"
		| "delete"
		| "listFolders"
		| "createFolder";
	searchText?: string;
	title?: string;
	noteId?: string;
	body?: string;
	format?: "markdown" | "html" | "plain";
	mode?: "replace" | "append";
	folderName?: string;
	fromDate?: string;
	toDate?: string;
	limit?: number;
} {
	if (typeof args !== "object" || args === null) return false;
	const a = args as Record<string, unknown>;

	const op = a.operation;
	if (typeof op !== "string") return false;
	if (
		![
			"search",
			"list",
			"get",
			"create",
			"update",
			"delete",
			"listFolders",
			"createFolder",
		].includes(op)
	) {
		return false;
	}

	// Optional string fields — if present, must be strings.
	for (const key of [
		"searchText",
		"title",
		"noteId",
		"body",
		"folderName",
		"fromDate",
		"toDate",
	]) {
		if (a[key] !== undefined && typeof a[key] !== "string") return false;
	}
	if (a.format !== undefined && !["markdown", "html", "plain"].includes(a.format as string)) {
		return false;
	}
	if (a.mode !== undefined && !["replace", "append"].includes(a.mode as string)) {
		return false;
	}
	if (a.limit !== undefined && typeof a.limit !== "number") return false;

	// Per-operation required fields.
	const hasTitle = typeof a.title === "string" && a.title.trim() !== "";
	const hasId = typeof a.noteId === "string" && a.noteId.trim() !== "";
	switch (op) {
		case "search":
			if (typeof a.searchText !== "string" || a.searchText.trim() === "") return false;
			break;
		case "get":
		case "delete":
			if (!hasTitle && !hasId) return false;
			break;
		case "create":
			if (!hasTitle) return false;
			break;
		case "update":
			if (!hasTitle && !hasId) return false;
			if (typeof a.body !== "string") return false;
			break;
		case "createFolder":
			if (typeof a.folderName !== "string" || a.folderName.trim() === "") return false;
			break;
	}

	return true;
}

function isMessagesArgs(args: unknown): args is {
	operation: "fetch" | "conversations" | "send" | "schedule";
	contactName?: string;
	phoneNumber?: string;
	message?: string;
	limit?: number;
	scheduledTime?: string;
	status?: "read" | "unread";
	from?: "them" | "me";
} {
	if (typeof args !== "object" || args === null) return false;

	const { operation, contactName, phoneNumber, message, limit, scheduledTime, status, from } =
		args as any;

	if (!operation || !["fetch", "conversations", "send", "schedule"].includes(operation)) {
		return false;
	}

	// Optional-field type checks (reject wrong-typed values rather than letting them through).
	if (contactName !== undefined && typeof contactName !== "string") return false;
	if (phoneNumber !== undefined && typeof phoneNumber !== "string") return false;
	if (message !== undefined && typeof message !== "string") return false;
	if (scheduledTime !== undefined && typeof scheduledTime !== "string") return false;
	if (limit !== undefined && typeof limit !== "number") return false;
	if (status !== undefined && !["read", "unread"].includes(status)) return false;
	if (from !== undefined && !["them", "me"].includes(from)) return false;

	// Validate required fields based on operation.
	switch (operation) {
		case "send":
		case "schedule":
			if (!phoneNumber || !message) return false;
			if (operation === "schedule" && !scheduledTime) return false;
			break;
		case "fetch":
		case "conversations":
			// All filters optional (no contact → recent across everyone / all threads).
			break;
	}
	return true;
}

function isRemindersArgs(args: unknown): args is {
	operation:
		| "list"
		| "search"
		| "get"
		| "open"
		| "create"
		| "update"
		| "complete"
		| "uncomplete"
		| "delete"
		| "listById";
	searchText?: string;
	name?: string;
	listName?: string;
	listId?: string;
	props?: string[];
	notes?: string;
	dueDate?: string;
	completed?: boolean;
	recurrence?: Recurrence;
} {
	if (typeof args !== "object" || args === null) {
		return false;
	}

	const a = args as any;
	const { operation } = a;
	if (typeof operation !== "string") {
		return false;
	}

	if (
		![
			"list",
			"search",
			"get",
			"open",
			"create",
			"update",
			"complete",
			"uncomplete",
			"delete",
			"listById",
		].includes(operation)
	) {
		return false;
	}

	// Operations that locate a reminder by name all require a non-empty searchText.
	if (
		[
			"search",
			"get",
			"open",
			"update",
			"complete",
			"uncomplete",
			"delete",
		].includes(operation) &&
		(typeof a.searchText !== "string" || a.searchText === "")
	) {
		return false;
	}

	// For create, name is required.
	if (
		operation === "create" &&
		(typeof a.name !== "string" || a.name === "")
	) {
		return false;
	}

	// For listById, listId is required.
	if (
		operation === "listById" &&
		(typeof a.listId !== "string" || a.listId === "")
	) {
		return false;
	}

	// A recurrence, when given, must be well-formed (a malformed repeat must never silently drop).
	if (a.recurrence !== undefined && !isRecurrence(a.recurrence)) {
		return false;
	}

	return true;
}

function isCalendarArgs(args: unknown): args is {
	operation: "search" | "open" | "list" | "create" | "update" | "delete";
	searchText?: string;
	eventId?: string;
	limit?: number;
	fromDate?: string;
	toDate?: string;
	title?: string;
	startDate?: string;
	endDate?: string;
	location?: string;
	notes?: string;
	isAllDay?: boolean;
	calendarName?: string;
	newTitle?: string;
	newStartDate?: string;
	newEndDate?: string;
	newLocation?: string;
	newNotes?: string;
	recurrence?: Recurrence;
} {
	if (typeof args !== "object" || args === null) {
		return false;
	}

	const { operation } = args as { operation?: unknown };
	if (typeof operation !== "string") {
		return false;
	}

	if (
		!["search", "open", "list", "create", "update", "delete"].includes(operation)
	) {
		return false;
	}

	if (operation === "search") {
		const { searchText } = args as { searchText?: unknown };
		if (typeof searchText !== "string") {
			return false;
		}
	}

	if (operation === "open") {
		const { eventId } = args as { eventId?: unknown };
		if (typeof eventId !== "string") {
			return false;
		}
	}

	if (operation === "create") {
		const { title, startDate, endDate } = args as {
			title?: unknown;
			startDate?: unknown;
			endDate?: unknown;
		};
		if (
			typeof title !== "string" ||
			typeof startDate !== "string" ||
			typeof endDate !== "string"
		) {
			return false;
		}
	}

	// update + delete must carry at least one locator: a non-empty eventId OR a non-empty title.
	// (Field-level validation — "which fields to change", date validity, ambiguity — lives in the module.)
	if (operation === "update" || operation === "delete") {
		const { eventId, title } = args as { eventId?: unknown; title?: unknown };
		const hasId = typeof eventId === "string" && eventId.trim() !== "";
		const hasTitle = typeof title === "string" && title.trim() !== "";
		if (!hasId && !hasTitle) {
			return false;
		}
	}

	// A recurrence, when given, must be well-formed (a malformed repeat must never silently drop).
	const { recurrence } = args as { recurrence?: unknown };
	if (recurrence !== undefined && !isRecurrence(recurrence)) {
		return false;
	}

	return true;
}
