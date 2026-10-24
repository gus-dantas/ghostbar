// Small Mac helpers that used to be separate apps: how long since Gus last
// touched the keyboard or mouse, and a one-pixel mouse nudge that counts as
// activity, so Teams stays "Available" while he is away from the desk.

import CoreGraphics
import Foundation

/// Seconds since the last keyboard, mouse or trackpad input.
@_cdecl("gtools_idle_seconds")
public func gtools_idle_seconds() -> Double {
    guard let any = CGEventType(rawValue: UInt32.max) else { return 0 }
    return CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any)
}

/// Moves the pointer one pixel and straight back: invisible, but it is input.
@_cdecl("gtools_nudge_mouse")
public func gtools_nudge_mouse() {
    guard let here = CGEvent(source: nil)?.location else { return }
    let source = CGEventSource(stateID: .hidSystemState)
    for point in [CGPoint(x: here.x + 1, y: here.y), here] {
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
            .post(tap: .cghidEventTap)
        usleep(20_000)
    }
}
