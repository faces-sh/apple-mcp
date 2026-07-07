// eventkit-helper: native EventKit access to Reminders and Calendar, replacing Apple Events
// scripting. Scripting costs ~5 seconds PER LIST per query (a 50-list reminders store made every
// search blow its budget and read as "no matches"); EventKit runs one indexed query over the whole
// store in well under a second, and it can do what scripting cannot: recurrence rules.
//
//   eventkit-helper <domain> <op> [json-payload]
//
//   reminders lists                                          -> [{id,name}]
//   reminders list    {listId?}                              -> [Reminder]
//   reminders search  {text}                                 -> [Reminder]
//   reminders create  {name, listName?, notes?, dueMs?, recurrence?}
//   reminders update  {id? | search, name?, notes?, dueMs?, completed?, recurrence?}
//   reminders delete  {id? | search}
//   calendar  list    {fromMs, toMs, limit?}                 -> [Event]
//   calendar  search  {text, fromMs, toMs, limit?}           -> [Event]
//   calendar  get     {eventId}                              -> Event
//   calendar  create  {title, startMs, endMs, isAllDay?, calendarName?, location?, notes?, recurrence?}
//   calendar  update  {eventId? | title, fromMs, toMs, newTitle?, newStartMs?, newEndMs?,
//                      newLocation?, newNotes?, recurrence?}
//   calendar  delete  {eventId? | title, fromMs, toMs}
//
// All dates cross the boundary as epoch milliseconds IN, local-time ISO-8601 strings OUT (an
// agent reading UTC parrots UTC at the user). recurrence is {frequency: daily|weekly|monthly|
// yearly, interval?}. Output is one JSON value on stdout; any failure prints
// {"error": message, "denied": bool} and exits 2 so the caller can fail honestly (denied != empty
// != broke). Locating a calendar event by title that matches MORE THAN ONE event returns
// {"error":"ambiguous","candidates":[...]} rather than guessing which one to mutate.
//
// TCC responsibility walks up to the app that spawned us (Maestro), whose Info.plist carries the
// Reminders and Calendars usage strings.
import EventKit
import Foundation

// MARK: - Plumbing

let MAX_ITEMS = 1000

let localISO: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone.current
    return f
}()

func emit(_ value: Any) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else {
        FileHandle.standardOutput.write(Data("{\"error\":\"could not encode results\"}".utf8))
        exit(2)
    }
    FileHandle.standardOutput.write(data)
    exit(0)
}

func fail(_ message: String, denied: Bool = false) -> Never {
    let obj: [String: Any] = ["error": message, "denied": denied]
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardOutput.write(data)
    }
    exit(2)
}

func date(fromMs value: Any?) -> Date? {
    guard let ms = value as? Double else {
        if let ms = value as? Int { return Date(timeIntervalSince1970: Double(ms) / 1000) }
        return nil
    }
    return Date(timeIntervalSince1970: ms / 1000)
}

func recurrenceRule(from payload: Any?) -> EKRecurrenceRule? {
    guard let dict = payload as? [String: Any],
          let frequency = dict["frequency"] as? String else { return nil }
    let freq: EKRecurrenceFrequency
    switch frequency {
    case "daily": freq = .daily
    case "weekly": freq = .weekly
    case "monthly": freq = .monthly
    case "yearly": freq = .yearly
    default: fail("Unknown recurrence frequency \"\(frequency)\". Use daily, weekly, monthly, or yearly.")
    }
    let interval = max(1, (dict["interval"] as? Int) ?? 1)
    return EKRecurrenceRule(recurrenceWith: freq, interval: interval, end: nil)
}

func replaceRecurrence(on item: EKCalendarItem, with rule: EKRecurrenceRule) {
    for existing in item.recurrenceRules ?? [] { item.removeRecurrenceRule(existing) }
    item.addRecurrenceRule(rule)
}

/// One human-readable word for an item's recurrence, or nil ("daily", "every 2 weeks").
func describeRecurrence(_ item: EKCalendarItem) -> String? {
    guard let rule = item.recurrenceRules?.first else { return nil }
    let unit: String
    switch rule.frequency {
    case .daily: unit = "day"
    case .weekly: unit = "week"
    case .monthly: unit = "month"
    case .yearly: unit = "year"
    @unknown default: unit = "period"
    }
    return rule.interval == 1 ? "every \(unit)" : "every \(rule.interval) \(unit)s"
}

// MARK: - Access

let args = CommandLine.arguments
guard args.count >= 3 else {
    fail("usage: eventkit-helper <reminders|calendar> <op> [json]")
}
let domain = args[1]
let op = args[2]
let payload: [String: Any] = {
    guard args.count >= 4, let data = args[3].data(using: .utf8) else { return [:] }
    guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail("payload is not a JSON object")
    }
    return parsed
}()

let store = EKEventStore()
let entity: EKEntityType = domain == "reminders" ? .reminder : .event
let accessSemaphore = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
    let handler: EKEventStoreRequestAccessCompletionHandler = { ok, _ in granted = ok; accessSemaphore.signal() }
    if entity == .reminder {
        store.requestFullAccessToReminders(completion: handler)
    } else {
        store.requestFullAccessToEvents(completion: handler)
    }
} else {
    store.requestAccess(to: entity) { ok, _ in granted = ok; accessSemaphore.signal() }
}
_ = accessSemaphore.wait(timeout: .now() + 60)
if !granted {
    let name = domain == "reminders" ? "Reminders" : "Calendars"
    fail("\(name) access is not granted. In System Settings > Privacy & Security > \(name), enable access, then try again.", denied: true)
}

// MARK: - Reminders

func reminderJSON(_ r: EKReminder) -> [String: Any] {
    var due: Any = NSNull()
    if let comps = r.dueDateComponents, let date = Calendar.current.date(from: comps) {
        due = localISO.string(from: date)
    }
    var obj: [String: Any] = [
        "name": r.title ?? "",
        "id": r.calendarItemIdentifier,
        "body": r.notes ?? "",
        "completed": r.isCompleted,
        "dueDate": due,
        "listName": r.calendar?.title ?? "",
    ]
    if let recurrence = describeRecurrence(r) { obj["recurrence"] = recurrence }
    return obj
}

/// Every reminder in the store (or one list), fetched with a single indexed query.
func fetchReminders(in calendars: [EKCalendar]?) -> [EKReminder] {
    var result: [EKReminder] = []
    let done = DispatchSemaphore(value: 0)
    store.fetchReminders(matching: store.predicateForReminders(in: calendars)) { reminders in
        result = reminders ?? []
        done.signal()
    }
    _ = done.wait(timeout: .now() + 55)
    return result
}

func reminderList(byId id: String) -> EKCalendar? {
    store.calendars(for: .reminder).first { $0.calendarIdentifier == id }
}

/// First reminder matching an explicit id, else the first whose name contains `search` (the
/// long-standing locate contract of the reminders tool).
func locateReminder() -> EKReminder? {
    if let id = payload["id"] as? String, !id.isEmpty {
        return store.calendarItem(withIdentifier: id) as? EKReminder
    }
    guard let search = payload["search"] as? String, !search.isEmpty else {
        fail("Provide an id or search text to locate the reminder.")
    }
    let needle = search.lowercased()
    return fetchReminders(in: nil).first { ($0.title ?? "").lowercased().contains(needle) }
}

func runReminders() -> Never {
    switch op {
    case "lists":
        emit(store.calendars(for: .reminder).map { ["id": $0.calendarIdentifier, "name": $0.title] })

    case "list":
        var calendars: [EKCalendar]? = nil
        if let listId = payload["listId"] as? String, !listId.isEmpty {
            guard let list = reminderList(byId: listId) else { fail("No reminder list found with id \"\(listId)\".") }
            calendars = [list]
        }
        emit(Array(fetchReminders(in: calendars).prefix(MAX_ITEMS)).map(reminderJSON))

    case "search":
        guard let text = payload["text"] as? String, !text.isEmpty else { fail("search requires text") }
        let needle = text.lowercased()
        let matches = fetchReminders(in: nil).filter {
            (($0.title ?? "") + " " + ($0.notes ?? "")).lowercased().contains(needle)
        }
        emit(Array(matches.prefix(MAX_ITEMS)).map(reminderJSON))

    case "create":
        guard let name = payload["name"] as? String, !name.isEmpty else { fail("create requires a name") }
        // Duplicate seatbelt: "change that reminder" mis-sent as a create would silently leave the user
        // with two. An existing open reminder with the SAME name makes create fail loud, naming it and
        // pointing at update; allowDuplicate is the explicit escape hatch when two are truly wanted.
        if (payload["allowDuplicate"] as? Bool) != true {
            let existing = fetchReminders(in: nil).first {
                !$0.isCompleted && ($0.title ?? "").lowercased() == name.lowercased()
            }
            if let existing {
                var due = ""
                if let comps = existing.dueDateComponents, let d = Calendar.current.date(from: comps) {
                    due = ", due \(localISO.string(from: d))"
                }
                fail("A reminder named \"\(existing.title ?? name)\"\(due) already exists in list \"\(existing.calendar?.title ?? "?")\". To change it, use the update operation (it edits in place). Pass allowDuplicate=true only if a second reminder with this name is truly wanted.")
            }
        }
        let reminder = EKReminder(eventStore: store)
        reminder.title = name
        if let notes = payload["notes"] as? String, !notes.isEmpty { reminder.notes = notes }

        if let listName = payload["listName"] as? String, !listName.isEmpty {
            if let existing = store.calendars(for: .reminder).first(where: { $0.title == listName }) {
                reminder.calendar = existing
            } else {
                let list = EKCalendar(for: .reminder, eventStore: store)
                list.title = listName
                guard let source = store.defaultCalendarForNewReminders()?.source
                    ?? store.sources.first(where: { source in
                        store.calendars(for: .reminder).contains { $0.source == source }
                    })
                else { fail("No reminders account is available to create the list \"\(listName)\" in.") }
                list.source = source
                do { try store.saveCalendar(list, commit: true) } catch { fail("Could not create list \"\(listName)\": \(error.localizedDescription)") }
                reminder.calendar = list
            }
        } else {
            guard let defaultList = store.defaultCalendarForNewReminders() else { fail("No default reminders list is available.") }
            reminder.calendar = defaultList
        }

        if let due = date(fromMs: payload["dueMs"]) {
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second], from: due)
        }
        if let rule = recurrenceRule(from: payload["recurrence"]) {
            guard reminder.dueDateComponents != nil else { fail("A repeating reminder needs a due date.") }
            reminder.addRecurrenceRule(rule)
        }
        do { try store.save(reminder, commit: true) } catch { fail("Could not create the reminder: \(error.localizedDescription)") }
        emit(reminderJSON(reminder))

    case "update":
        guard let reminder = locateReminder() else { emit(["updated": false]) }
        if let name = payload["name"] as? String, !name.isEmpty { reminder.title = name }
        if let notes = payload["notes"] as? String { reminder.notes = notes }
        if let due = date(fromMs: payload["dueMs"]) {
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second], from: due)
        }
        if let completed = payload["completed"] as? Bool { reminder.isCompleted = completed }
        if let rule = recurrenceRule(from: payload["recurrence"]) {
            guard reminder.dueDateComponents != nil else { fail("A repeating reminder needs a due date; set one first.") }
            replaceRecurrence(on: reminder, with: rule)
        }
        do { try store.save(reminder, commit: true) } catch { fail("Could not update the reminder: \(error.localizedDescription)") }
        emit(["updated": true, "reminder": reminderJSON(reminder)])

    case "delete":
        guard let reminder = locateReminder() else { emit(["deleted": false]) }
        let name = reminder.title ?? ""
        do { try store.remove(reminder, commit: true) } catch { fail("Could not delete the reminder: \(error.localizedDescription)") }
        emit(["deleted": true, "name": name])

    default:
        fail("Unknown reminders op \"\(op)\".")
    }
}

// MARK: - Calendar

func eventJSON(_ e: EKEvent) -> [String: Any] {
    var obj: [String: Any] = [
        "id": e.eventIdentifier ?? "",
        "title": e.title ?? "",
        "startDate": e.startDate.map { localISO.string(from: $0) } ?? "",
        "endDate": e.endDate.map { localISO.string(from: $0) } ?? "",
        "location": e.location ?? NSNull(),
        "calendarName": e.calendar?.title ?? "",
        "notes": e.notes ?? NSNull(),
    ]
    if let recurrence = describeRecurrence(e) { obj["recurrence"] = recurrence }
    return obj
}

func window() -> (Date, Date) {
    guard let from = date(fromMs: payload["fromMs"]), let to = date(fromMs: payload["toMs"]) else {
        fail("\(op) requires fromMs and toMs")
    }
    return (from, to)
}

func eventsInWindow(_ from: Date, _ to: Date) -> [EKEvent] {
    store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
        .sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
}

/// Locate exactly one event: by stable eventId, or by title-contains within the window. More than
/// one title match is an honest "ambiguous" (never guess which event to mutate or delete).
func locateEvent() -> EKEvent {
    if let id = payload["eventId"] as? String, !id.isEmpty {
        guard let event = store.event(withIdentifier: id) else {
            emit(["ok": false, "reason": "not_found"])
        }
        return event
    }
    guard let title = payload["title"] as? String, !title.isEmpty else {
        fail("Provide an eventId or a title to locate the event.")
    }
    let (from, to) = window()
    let needle = title.lowercased()
    let matches = eventsInWindow(from, to).filter { ($0.title ?? "").lowercased().contains(needle) }
    if matches.isEmpty { emit(["ok": false, "reason": "not_found"]) }
    if matches.count > 1 {
        emit([
            "ok": false,
            "reason": "ambiguous",
            "candidates": matches.prefix(10).map {
                ["id": $0.eventIdentifier ?? "", "title": $0.title ?? "",
                 "start": $0.startDate.map { d in localISO.string(from: d) } ?? ""]
            },
        ] as [String: Any])
    }
    return matches[0]
}

func runCalendar() -> Never {
    switch op {
    case "list", "search":
        let (from, to) = window()
        let limit = max(1, (payload["limit"] as? Int) ?? 10)
        var events = eventsInWindow(from, to)
        if op == "search" {
            guard let text = payload["text"] as? String, !text.isEmpty else { fail("search requires text") }
            let needle = text.lowercased()
            events = events.filter {
                (($0.title ?? "") + " " + ($0.location ?? "") + " " + ($0.notes ?? "")).lowercased().contains(needle)
            }
        }
        emit(Array(events.prefix(limit)).map(eventJSON))

    case "get":
        guard let id = payload["eventId"] as? String, !id.isEmpty else { fail("get requires an eventId") }
        guard let event = store.event(withIdentifier: id) else {
            emit(["ok": false, "reason": "not_found"])
        }
        emit(eventJSON(event))

    case "create":
        guard let title = payload["title"] as? String, !title.isEmpty else { fail("create requires a title") }
        guard let start = date(fromMs: payload["startMs"]), let end = date(fromMs: payload["endMs"]) else {
            fail("create requires startMs and endMs")
        }
        // Duplicate seatbelt, same shape as reminders: "move that meeting" mis-sent as a create leaves
        // the user double-booked. An upcoming event with the SAME title makes create fail loud with the
        // existing event's id (update/delete take it directly); allowDuplicate is the escape hatch.
        if (payload["allowDuplicate"] as? Bool) != true {
            let horizon = Date(timeIntervalSinceNow: 365 * 24 * 3600)
            let existing = eventsInWindow(Date(), max(horizon, end)).first {
                ($0.title ?? "").lowercased() == title.lowercased()
            }
            if let existing {
                let when = existing.startDate.map { localISO.string(from: $0) } ?? "?"
                fail("An event titled \"\(existing.title ?? title)\" already exists at \(when) (id \(existing.eventIdentifier ?? "?")). To change it, use the update operation with that eventId (it edits in place); use delete to remove it. Pass allowDuplicate=true only if a second event with this title is truly wanted.")
            }
        }
        let event = EKEvent(eventStore: store)
        event.title = title
        event.startDate = start
        event.endDate = end
        event.isAllDay = (payload["isAllDay"] as? Bool) ?? false
        if let location = payload["location"] as? String, !location.isEmpty { event.location = location }
        if let notes = payload["notes"] as? String, !notes.isEmpty { event.notes = notes }
        if let name = payload["calendarName"] as? String, !name.isEmpty {
            guard let calendar = store.calendars(for: .event).first(where: { $0.title == name }) else {
                fail("Calendar \"\(name)\" was not found.")
            }
            event.calendar = calendar
        } else {
            guard let calendar = store.defaultCalendarForNewEvents else { fail("No default calendar is available.") }
            event.calendar = calendar
        }
        if let rule = recurrenceRule(from: payload["recurrence"]) { event.addRecurrenceRule(rule) }
        do { try store.save(event, span: .futureEvents, commit: true) } catch { fail("Could not create the event: \(error.localizedDescription)") }
        emit(eventJSON(event))

    case "update":
        let event = locateEvent()
        var changed: [String] = []
        if let title = payload["newTitle"] as? String, !title.isEmpty { event.title = title; changed.append("title") }
        if let start = date(fromMs: payload["newStartMs"]) { event.startDate = start; changed.append("start") }
        if let end = date(fromMs: payload["newEndMs"]) { event.endDate = end; changed.append("end") }
        if let location = payload["newLocation"] as? String {
            event.location = location.isEmpty ? nil : location
            changed.append("location")
        }
        if let notes = payload["newNotes"] as? String {
            event.notes = notes.isEmpty ? nil : notes
            changed.append("notes")
        }
        if let rule = recurrenceRule(from: payload["recurrence"]) {
            replaceRecurrence(on: event, with: rule)
            changed.append("recurrence")
        }
        // .futureEvents: editing a recurring event applies from this occurrence on, which is what
        // "move that meeting" means; for a one-off event it is identical to .thisEvent.
        do { try store.save(event, span: .futureEvents, commit: true) } catch { fail("Could not update the event: \(error.localizedDescription)") }
        emit(["ok": true, "changed": changed, "event": eventJSON(event)])

    case "delete":
        let event = locateEvent()
        let deletedJSON = eventJSON(event)
        do { try store.remove(event, span: .futureEvents, commit: true) } catch { fail("Could not delete the event: \(error.localizedDescription)") }
        emit(["ok": true, "event": deletedJSON])

    default:
        fail("Unknown calendar op \"\(op)\".")
    }
}

switch domain {
case "reminders": runReminders()
case "calendar": runCalendar()
default: fail("Unknown domain \"\(domain)\". Use reminders or calendar.")
}
