// Persistent Vision OCR: read image paths on stdin (one per line), print
// "text\tcx\tcy" lines per image followed by a "\u{1}" sentinel line. Keeps the
// Vision request warm across images so each call avoids cold-start init.
import Foundation
import Vision
import AppKit

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.minimumTextHeight = 0.0
req.recognitionLanguages = ["en-US"]
let out = FileHandle.standardOutput

func emit(_ s: String) { out.write(s.data(using: .utf8)!) }

while let path = readLine(strippingNewline: true) {
  if let img = NSImage(contentsOfFile: path),
     let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    let W = CGFloat(cg.width), H = CGFloat(cg.height)
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])
    for obs in (req.results ?? []) {
      guard let cand = obs.topCandidates(1).first else { continue }
      let bb = obs.boundingBox
      let cx = (bb.minX + bb.width/2) * W
      let cy = (1 - (bb.minY + bb.height/2)) * H
      emit("\(cand.string)\t\(cx)\t\(cy)\n")
    }
  }
  emit("\u{1}\n")   // end-of-image sentinel
}
