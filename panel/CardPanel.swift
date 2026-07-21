// CardPanel: a small always-on-top window that shows the copilot's cards.
//
// Native shell, HTML content: the panel floats over fullscreen Zoom (which a
// browser window cannot), while the card UI stays plain HTML/JS so interactivity
// (upvote, dismiss, whatever comes next) is easy to extend.
//
// Non-activating: clicking a button does not steal focus from the meeting app.
//
// Never call NSApp.activate(ignoringOtherApps:) to show this. Activating the app
// while Chrome/Zoom is in fullscreen yanks the user out of the meeting's Space.
// Show it with orderFrontRegardless(), and keep it alive across fullscreen
// transitions rather than creating it after one.
//
// It is NOT hidden from screen capture. sharingType = .none stopped working for
// that on macOS 15.4+ (no public API prevents capture). A "Chrome tab" share does
// not capture it, because tab capture reads the tab's own frames; an "Entire
// Screen" share does.
//
// Usage: CardPanel [url]        default http://127.0.0.1:8787

import AppKit
import WebKit

let url = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "http://127.0.0.1:8787"

// A transparent strip that moves the window on drag and snaps to the top-right
// corner on double-click. Non-activating, so grabbing it never pulls focus off
// the meeting.
final class DragBar: NSView {
    override var mouseDownCanMoveWindow: Bool { false }   // we drive the drag ourselves
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2, let win = window, let vf = win.screen?.visibleFrame {
            win.setFrameOrigin(NSPoint(x: vf.maxX - win.frame.width - 20,
                                       y: vf.maxY - win.frame.height - 12))
            return
        }
        window?.performDrag(with: event)
    }
    // A faint grab affordance so the strip reads as draggable.
    override func draw(_ dirtyRect: NSRect) {
        NSColor(white: 1, alpha: 0.14).setFill()
        let dot: CGFloat = 3, gap: CGFloat = 6, n = 3
        let totalW = CGFloat(n) * dot + CGFloat(n - 1) * gap
        var x = bounds.midX - totalW / 2
        let y = bounds.midY - dot / 2
        for _ in 0..<n {
            NSBezierPath(ovalIn: NSRect(x: x, y: y, width: dot, height: dot)).fill()
            x += dot + gap
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var panel: NSPanel!
    var web: WKWebView!

    func applicationDidFinishLaunching(_: Notification) {
        let w: CGFloat = 380, h: CGFloat = 440
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: w, height: h),
            // .nonactivatingPanel: clicks don't pull focus off the meeting window.
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false)

        panel.title = "copilot"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isMovableByWindowBackground = true
        // Adaptive: the page's CSS palette follows the system appearance, so the
        // backdrop (visible only before the page paints) must follow it too.
        panel.backgroundColor = .windowBackgroundColor
        panel.hasShadow = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true           // clicking a button never steals focus
        panel.level = .floating                       // above normal windows
        // The two flags do different jobs, and you need both to float over a
        // meeting in fullscreen: .fullScreenAuxiliary lets the panel coexist on a
        // fullscreen Space instead of forcing a Space switch; .canJoinAllSpaces
        // carries it into *another app's* fullscreen Space (Chrome's, Zoom's).
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: panel.contentView!.bounds, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        // Keep the webview OPAQUE. It was transparent (drawsBackground=false) so
        // the panel bg showed through pre-paint, but transparent WKWebViews have
        // partial-repaint artifacts on macOS: a hover-triggered repaint (e.g. a
        // link's :hover color) can blank the region to the backdrop — cards
        // visibly "disappear" on hover. The page paints its own opaque themed
        // background now, so transparency buys nothing and costs redraws.
        panel.contentView!.addSubview(web)

        // The WKWebView fills the window and eats mouse events, so
        // isMovableByWindowBackground can't find a bare spot to drag by, and the
        // HTML header's -webkit-app-region:drag does nothing in a WKWebView. Lay a
        // thin transparent strip across the very top (over the status header, below
        // the 👍/👎 buttons) that drags the window natively. Double-click it to
        // snap back to the top-right corner.
        let bar = DragBar(frame: NSRect(x: 0, y: h - 22, width: w, height: 22))
        bar.autoresizingMask = [.width, .minYMargin]
        panel.contentView!.addSubview(bar, positioned: .above, relativeTo: web)

        load()

        // Right edge, full working height (menu bar to Dock, small margins):
        // the feed gets room and the telemetry strips never crowd the cards.
        if let screen = NSScreen.main?.visibleFrame {
            let ph = screen.height - 24
            panel.setFrame(NSRect(x: screen.maxX - w - 20, y: screen.minY + 12, width: w, height: ph), display: true)
        }
        panel.orderFrontRegardless()
        // A brief, non-focus-stealing nudge so the eye catches the new window,
        // then settle back to floating (never activate — that yanks the meeting).
        panel.level = .statusBar
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.panel.level = .floating
        }
    }

    func load() { web.load(URLRequest(url: URL(string: url)!)) }

    // The panel usually starts before the server is listening; retry until it answers.
    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError _: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.load() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
// .accessory: no Dock icon, no menu bar takeover — it's a HUD, not an app.
app.setActivationPolicy(.accessory)
// A minimal Edit menu (never visible for an accessory app) so cmd-C / cmd-A
// route to copy:/selectAll: on the webview. Without a main menu those key
// equivalents have no route and fall through to window handling — cmd-C was
// CLOSING the panel instead of copying the selection.
let mainMenu = NSMenu()
let editHolder = NSMenuItem()
mainMenu.addItem(editHolder)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editHolder.submenu = editMenu
app.mainMenu = mainMenu
let delegate = AppDelegate()
app.delegate = delegate
app.run()
