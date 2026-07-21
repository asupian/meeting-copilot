// screentap: periodic on-device OCR of the MEETING WINDOW for the copilot.
//
// Every few seconds, find the meeting window (Google Meet tab, Zoom, Webex),
// capture JUST that window (ScreenCaptureKit), OCR it with Apple's Vision
// framework, and append a JSONL line when the visible text changes materially
// (a slide flip, a new doc). Scoping to the meeting window is what keeps the
// feed honest: shared slides and participant tiles render inside it; the rest
// of the desktop (calendar, Slack, editors, the clock) does not — capturing
// the whole display read all of that back as phantom "meeting" content.
// When no meeting window exists, emit {"off":true} once so the panel can say
// "no presentation detected".
//
// Privacy: OCR is on-device and only extracted text flows onward — with ONE
// exception: the latest frame is saved as frame.png beside the feed, and
// live.mjs's chart-vision pass (disable with --no-vision there) sends that
// image through claude, the same trust boundary the transcript text crosses.
//
// Also matches OCR text against a roster of known names (people index +
// attendees): the names visible on participant tiles are a strong "who is in
// the room" signal, and they fix ASR-garbled spellings. If Meet captions are
// on, the caption line ("Name: what they said") is picked up as screen text
// automatically — that is the reliable per-line speaker path.
//
// Output line: {"t":"<iso ms>","text":"<ocr text>","names":["Jordan L..."]}
//
// Usage:
//   screentap --out <file> [--roster names.txt] [--interval 4]
//   screentap --file <image.png> [--roster names.txt]     # offline OCR test, no permissions
//
// TCC: live capture needs the Screen Recording permission, attributed to this
// app's own bundle identity (io.meetingcopilot.screentap) — launch via `open`, same
// pattern as meetingtap. The CardPanel window is excluded from capture so the
// copilot never OCRs its own cards back into context.

import Foundation
import AppKit
import ScreenCaptureKit
import Vision
import CoreGraphics
import ImageIO

// ---------- args ----------
let args = CommandLine.arguments
func val(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}
let outPath = val("--out")
let rosterPath = val("--roster")
let filePath = val("--file")
let intervalSec = Double(val("--interval") ?? "4") ?? 4

// ---------- helpers ----------
let isoFmt: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
    f.timeZone = TimeZone(identifier: "UTC")
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

let roster: [String] = {
    guard let p = rosterPath, let text = try? String(contentsOfFile: p, encoding: .utf8) else { return [] }
    return text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { $0.count >= 5 && $0.contains(" ") }   // full names only
}()

var outHandle: FileHandle? = {
    guard let p = outPath else { return nil }
    if !FileManager.default.fileExists(atPath: p) { FileManager.default.createFile(atPath: p, contents: nil) }
    let h = FileHandle(forWritingAtPath: p)
    h?.seekToEndOfFile()
    return h
}()

func emit(text: String, names: [String], title: String = "", tiles: [[String: Any]] = []) {
    var obj: [String: Any] = ["t": isoFmt.string(from: Date()), "text": text, "names": names]
    if !title.isEmpty { obj["title"] = title }   // so downstream can drop title echoes
    if !tiles.isEmpty { obj["tiles"] = tiles }   // standalone-name candidates + text height
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    if let h = outHandle { h.write((line + "\n").data(using: .utf8)!) }
    else { print(line) }
}

// Standalone-name observations = tile labels. A speaker tile's label renders
// LARGER than filmstrip labels, and a name inside slide prose ("DRI: Parker")
// is embedded in a longer line, so "line that is ONLY a 1-3 word capitalized
// name" + its text height is enough for downstream to pick the active speaker.
// 2-3 words required: single capitalized words are UI buttons ("Transcript",
// "Share"), not people.
let nameLineRe = try! NSRegularExpression(pattern: "^[A-Z][A-Za-z'’.\\-]+( [A-Z][A-Za-z'’.\\-]+){1,2}$")
func tileCandidates(_ obs: [VNRecognizedTextObservation]) -> [[String: Any]] {
    var out: [[String: Any]] = []
    for o in obs {
        guard let s = o.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces),
              s.count <= 32,
              nameLineRe.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
        else { continue }
        out.append(["t": s, "h": Double(round(o.boundingBox.height * 10000) / 10000)])
    }
    out.sort { (a, b) in (a["h"] as! Double) > (b["h"] as! Double) }
    return Array(out.prefix(8))
}

// OCR a CGImage into reading-ordered observations (top-to-bottom, left-to-right).
// cropTop drops observations in the window's top ~12% — in a browser meeting
// window that strip is chrome (tabs, URL bar, Drive/Meet headers), never the
// shared content, and it is where the phantom "title as content" came from.
func ocrObs(_ image: CGImage, cropTop: Bool = false) -> [VNRecognizedTextObservation] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([req])
    return (req.results ?? [])
        .filter { !cropTop || $0.boundingBox.midY < 0.88 }   // bottom-left origin: top of image ~ 1.0
        .sorted { a, b in
        // Vision bboxes have a bottom-left origin: higher midY = higher on screen.
        if abs(a.boundingBox.midY - b.boundingBox.midY) > 0.015 { return a.boundingBox.midY > b.boundingBox.midY }
        return a.boundingBox.minX < b.boundingBox.minX
    }
}

func ocrText(_ obs: [VNRecognizedTextObservation]) -> String {
    var text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    if text.count > 6000 { text = String(text.prefix(6000)) }
    return text
}

func visibleNames(in text: String) -> [String] {
    let hay = text.lowercased()
    return roster.filter { hay.contains($0.lowercased()) }
}

func wordSet(_ s: String) -> Set<String> {
    Set(s.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { $0.count >= 3 })
}
func jaccard(_ a: Set<String>, _ b: Set<String>) -> Double {
    if a.isEmpty && b.isEmpty { return 1 }
    let inter = a.intersection(b).count
    let uni = a.union(b).count
    return uni == 0 ? 1 : Double(inter) / Double(uni)
}

// ---------- offline mode: OCR a single image, no permissions ----------
if let f = filePath {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: f) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        FileHandle.standardError.write("screentap: cannot read image \(f)\n".data(using: .utf8)!)
        exit(1)
    }
    let obs = ocrObs(img)
    let text = ocrText(obs)
    emit(text: text, names: visibleNames(in: text), tiles: tileCandidates(obs))
    exit(0)
}

guard outPath != nil else {
    FileHandle.standardError.write("usage: screentap --out <file> [--roster names.txt] [--interval 4] | --file <image>\n".data(using: .utf8)!)
    exit(2)
}

// ---------- live capture loop ----------
var prevWords = Set<String>()
var prevNames: [String] = []
var announcedOff = false

// The window the meeting lives in. Zoom's own app, or a browser window whose
// title says it's a Meet/Zoom/Webex/Teams call. Largest match wins (the main
// meeting window, not a popped-out chat).
let BROWSER_IDS: Set<String> = [
    "com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser",
    "com.brave.Browser", "com.microsoft.edgemac", "org.mozilla.firefox",
]
func findMeetingWindow(_ content: SCShareableContent) -> SCWindow? {
    var best: SCWindow? = nil
    for w in content.windows {
        guard w.isOnScreen, w.frame.width > 400, w.frame.height > 300 else { continue }
        let bid = w.owningApplication?.bundleIdentifier ?? ""
        let t = (w.title ?? "").lowercased()
        let isBrowser = BROWSER_IDS.contains(bid) || bid.hasPrefix("com.google.Chrome.app")  // incl. Meet PWA
        let isMeeting =
            (bid == "us.zoom.xos" && (t.contains("zoom") || t.contains("meeting"))) ||
            (isBrowser && (
                // "Meet – abc-defg-hij" AND "<meeting name> - Google Meet": word-boundary
                // so "meeting notes" in a doc title does not match.
                t.range(of: "\\bmeet\\b", options: .regularExpression) != nil ||
                t.contains("zoom") || t.contains("webex") || t.contains("teams meeting") ||
                // Drive playback of a meeting recording — the replay-test path.
                (t.contains("recording") && t.contains("drive"))))
        if isMeeting, (best == nil || w.frame.width * w.frame.height > best!.frame.width * best!.frame.height) {
            best = w
        }
    }
    return best
}

// Latest frame for the chart-vision pass: atomic write (tmp + rename) so a
// mid-write read never sees a torn PNG.
func saveFrame(_ image: CGImage) {
    guard let out = outPath else { return }
    let dir = (out as NSString).deletingLastPathComponent
    let path = dir + "/frame.png"
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else { return }
    let tmp = path + ".tmp"
    try? png.write(to: URL(fileURLWithPath: tmp))
    try? FileManager.default.removeItem(atPath: path)
    try? FileManager.default.moveItem(atPath: tmp, toPath: path)
}

func emitOff(reason: String? = nil) {
    var obj: [String: Any] = ["t": isoFmt.string(from: Date()), "off": true]
    if let r = reason { obj["reason"] = r }
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    if let h = outHandle { h.write((line + "\n").data(using: .utf8)!) } else { print(line) }
}

func captureOnce() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let win = findMeetingWindow(content) else {
            // No meeting window on screen: say so ONCE, reset change-detection
            // so the next meeting's first frame always emits.
            if !announcedOff { announcedOff = true; prevWords = []; prevNames = []; emitOff() }
            return
        }
        announcedOff = false
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let cfg = SCStreamConfiguration()
        cfg.width = Int(win.frame.width) * 2    // retina-scale for OCR accuracy
        cfg.height = Int(win.frame.height) * 2
        cfg.showsCursor = false
        let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        let obs = ocrObs(img, cropTop: true)
        let text = ocrText(obs)
        let words = wordSet(text)
        let names = visibleNames(in: text)
        // Emit on a real change: a slide flip / new doc / roster change, not
        // every cursor blink. 0.85 similarity ≈ same screen.
        if jaccard(words, prevWords) < 0.85 || names != prevNames {
            prevWords = words
            prevNames = names
            emit(text: text, names: names, title: win.title ?? "", tiles: tileCandidates(obs))
            saveFrame(img)   // for the chart-vision pass; overwritten per change
        }
    } catch {
        FileHandle.standardError.write("screentap: capture failed: \(error.localizedDescription)\n".data(using: .utf8)!)
        // Surface the failure INTO the feed (once) so the panel can say it —
        // a permission problem must never look like "no slides today".
        if !announcedOff {
            announcedOff = true
            prevWords = []; prevNames = []
            let denied = error.localizedDescription.lowercased().contains("declined") ||
                         error.localizedDescription.lowercased().contains("permission")
            emitOff(reason: denied ? "screen capture not permitted — grant Screen Recording to screentap" : "screen capture failing")
        }
    }
}

// SCContentFilter(desktopIndependentWindow:) asserts (SLSGetDisplaysWithRect ->
// CGS_REQUIRE_INIT -> abort) unless the process has a WindowServer connection.
// A bare Foundation binary never makes one; NSApplication.shared does. The
// display-based filter didn't need this; the window-based one does.
_ = NSApplication.shared

FileHandle.standardError.write("screentap: capturing every \(intervalSec)s -> \(outPath!) (roster: \(roster.count) names)\n".data(using: .utf8)!)
Task {
    while true {
        await captureOnce()
        try? await Task.sleep(nanoseconds: UInt64(intervalSec * 1_000_000_000))
    }
}
RunLoop.main.run()
