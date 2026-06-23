// Prints "id x y w h" (points, top-left origin) for the iPhone Mirroring GAME window
// (title exactly "iPhone Mirroring"; falls back to any window with that owner).
import CoreGraphics
import Foundation
let wl = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as! [[String: Any]]
func bounds(_ w: [String:Any]) -> (Int,Int,Int,Int)? {
  guard let b = w[kCGWindowBounds as String] as? [String:Any],
        let x=b["X"] as? Double,let y=b["Y"] as? Double,
        let ww=b["Width"] as? Double,let h=b["Height"] as? Double else { return nil }
  return (Int(x),Int(y),Int(ww),Int(h))
}
var exact: [String:Any]? = nil
for w in wl {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let name  = w[kCGWindowName as String] as? String ?? ""
  if owner.contains("iPhone Mirroring") && name == "iPhone Mirroring" { exact = w; break }
}
if exact == nil {
  for w in wl {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    guard owner.contains("iPhone Mirroring"), let b = bounds(w) else { continue }
    if b.2 == 318 && b.3 == 701 { exact = w; break }
  }
}
if exact == nil {
  for w in wl {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    guard owner.contains("iPhone Mirroring"), let b = bounds(w) else { continue }
    if b.2 > 200 && b.3 > 400 { exact = w; break }
  }
}
if let w = exact, let n = w[kCGWindowNumber as String] as? Int, let b = bounds(w) {
  print("\(n) \(b.0) \(b.1) \(b.2) \(b.3)")
}
