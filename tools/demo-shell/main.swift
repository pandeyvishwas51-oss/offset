// A plain window that shows the running OFFSET app with no browser chrome, for recording the demo.
// Usage: OffsetDemo.app/Contents/MacOS/OffsetDemo [--windowed] [url] [page zoom]
import Cocoa
import WebKit

// A borderless window refuses clicks and keys unless it says it can take them.
final class DemoWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!

  func applicationDidFinishLaunching(_ notification: Notification) {
    let args = CommandLine.arguments.dropFirst().filter { $0 != "--windowed" }
    let windowed = CommandLine.arguments.contains("--windowed")
    let url = URL(string: args.first ?? "http://localhost:8787")!

    if windowed {
      window = DemoWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
      window.title = "OFFSET"
      window.center()
    } else {
      // Covers the whole screen, menu bar included, so a screen recording shows only the page. Quit with Cmd+Q.
      window = DemoWindow(contentRect: NSScreen.main!.frame, styleMask: [.borderless], backing: .buffered, defer: false)
      window.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1)
    }
    let web = WKWebView(frame: window.contentLayoutRect)
    web.autoresizingMask = [.width, .height]
    // Slightly zoomed out so the graph and the agents panel fit on one screen without scrolling.
    web.pageZoom = args.count > 1 ? CGFloat(Double(args[args.index(after: args.startIndex)]) ?? 0.85) : 0.85
    web.load(URLRequest(url: url))
    window.contentView = web
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    let menu = NSMenu()
    let appItem = NSMenuItem()
    appItem.submenu = NSMenu()
    appItem.submenu!.addItem(withTitle: "Quit OFFSET Demo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(appItem)
    NSApp.mainMenu = menu
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
