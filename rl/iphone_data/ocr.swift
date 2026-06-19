// Full-image Vision OCR. Arg: <image>. Prints "text\tcx\tcy" (top-left px) per string.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2,
      let img = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot load image\n".data(using: .utf8)!); exit(1)
}
let W = CGFloat(cg.width), H = CGFloat(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.minimumTextHeight = 0.0
req.recognitionLanguages = ["en-US"]
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([req])
for obs in (req.results ?? []) {
  guard let cand = obs.topCandidates(1).first else { continue }
  let bb = obs.boundingBox
  let cx = (bb.minX + bb.width/2) * W
  let cy = (1 - (bb.minY + bb.height/2)) * H
  print("\(cand.string)\t\(cx)\t\(cy)")
}
