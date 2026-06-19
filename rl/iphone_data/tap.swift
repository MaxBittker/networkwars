// CGEvent left click at global screen point. Args: <x> <y>
import CoreGraphics
import Foundation
let a = CommandLine.arguments
guard a.count >= 3, let x = Double(a[1]), let y = Double(a[2]) else { print("usage: tap X Y"); exit(1) }
let pt = CGPoint(x: x, y: y)
let src = CGEventSource(stateID: .hidSystemState)
CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(60000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(60000)
CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
