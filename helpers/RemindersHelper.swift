// reminders-helper: native EventKit access to Reminders, replacing per-list Apple Events scripting
// (which costs ~5s PER LIST; a 50-list store made every search read as "no matches" upstream).
// One indexed query over the whole store, milliseconds-to-a-second, full coverage.
//
//   reminders-helper search <text>   -> JSON array of matching reminders (name/body, case-blind)
//   reminders-helper list            -> JSON array of every reminder (bounded)
//
// Output is a JSON array on stdout; a denial or store error prints {"error": ...} and exits 2, so
// the caller can surface it honestly. TCC attributes to the responsible app (Maestro), whose
// Info.plist carries NSRemindersFullAccessUsageDescription.
import EventKit
import Foundation

let MAX_ITEMS = 1000

func fail(_ message: String) -> Never {
    let obj = ["error": message]
    if let data = try? JSONSerialization.data(withJSONObject: obj) {
        FileHandle.standardOutput.write(data)
    }
    exit(2)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: reminders-helper search <text> | list") }
let command = args[1]
let needle = args.count >= 3 ? args[2].lowercased() : ""
if command == "search" && needle.isEmpty { fail("search requires text") }

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { ok, _ in granted = ok; semaphore.signal() }
} else {
    store.requestAccess(to: .reminder) { ok, _ in granted = ok; semaphore.signal() }
}
_ = semaphore.wait(timeout: .now() + 30)
guard granted else { fail("Reminders access is not granted. Enable it in System Settings > Privacy & Security > Reminders.") }

let predicate = store.predicateForReminders(in: nil)   // every list, one indexed query
var out: [[String: Any]] = []
let fetchDone = DispatchSemaphore(value: 0)
store.fetchReminders(matching: predicate) { reminders in
    let iso = ISO8601DateFormatter()
    iso.timeZone = TimeZone.current   // local wall-clock with offset, so callers report the user's time
    for r in reminders ?? [] {
        if out.count >= MAX_ITEMS { break }
        let name = r.title ?? ""
        let body = r.notes ?? ""
        if command == "search" {
            let hay = (name + " " + body).lowercased()
            if !hay.contains(needle) { continue }
        }
        var due: String? = nil
        if let comps = r.dueDateComponents, let date = Calendar.current.date(from: comps) {
            due = iso.string(from: date)
        }
        out.append([
            "name": name,
            "id": r.calendarItemIdentifier,
            "body": body,
            "completed": r.isCompleted,
            "dueDate": due as Any,
            "listName": r.calendar?.title ?? "",
        ])
    }
    fetchDone.signal()
}
_ = fetchDone.wait(timeout: .now() + 25)

if let data = try? JSONSerialization.data(withJSONObject: out) {
    FileHandle.standardOutput.write(data)
} else {
    fail("could not encode results")
}
