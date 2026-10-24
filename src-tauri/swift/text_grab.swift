// Text from the screen. Vision reads a screenshot and hands back its text and,
// when the picture holds a table, the table as rows of cells, so it pastes
// into Excel or Outlook as a table. macOS 26 reads documents (paragraphs and
// tables); older systems fall back to plain line-by-line recognition.

import CoreGraphics
import Foundation
import ImageIO
import Vision

private struct Grab: Encodable {
    var text = ""
    /// The biggest table, row by row, when there is one of 2 x 2 or more.
    var rows: [[String]]? = nil
}

private final class Box: @unchecked Sendable {
    var grab = Grab()
}

private func clean(_ s: String) -> String {
    s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
}

@available(macOS 26.0, *)
private func readDocument(_ url: URL) async -> Grab {
    var request = RecognizeDocumentsRequest()
    request.textRecognitionOptions.automaticallyDetectLanguage = true
    request.textRecognitionOptions.useLanguageCorrection = true
    guard let doc = try? await request.perform(on: url, orientation: nil).first?.document else {
        return Grab()
    }
    let text = doc.text.transcript.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
    var grab = Grab(text: text.trimmingCharacters(in: .whitespacesAndNewlines))
    var best: [[String]]? = nil
    for table in doc.tables {
        let cells = table.rows.flatMap { $0 }
        guard !cells.isEmpty else { continue }
        let height = (cells.map { $0.rowRange.upperBound }.max() ?? 0) + 1
        let width = (cells.map { $0.columnRange.upperBound }.max() ?? 0) + 1
        guard height >= 2, width >= 2, height * width <= 20_000 else { continue }
        var grid = Array(repeating: Array(repeating: "", count: width), count: height)
        for cell in cells {
            grid[cell.rowRange.lowerBound][cell.columnRange.lowerBound] = clean(cell.content.text.transcript)
        }
        // A real table is mostly filled in, in every column; a sidebar or a
        // form laid out in a grid is not.
        let filled = grid.joined().filter { !$0.isEmpty }.count
        let columnsFilled = (0..<width).allSatisfy { c in
            Double(grid.filter { !$0[c].isEmpty }.count) >= Double(height) * 0.5
        }
        guard Double(filled) >= Double(height * width) * 0.7, columnsFilled else { continue }
        if (best?.count ?? 0) * (best?.first?.count ?? 0) < height * width {
            best = grid
        }
    }
    grab.rows = best
    return grab
}

/// Line by line, top to bottom: for systems before macOS 26, or when the
/// document reader found nothing.
private func readLines(_ url: URL) -> String {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return "" }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    guard (try? handler.perform([request])) != nil, let found = request.results else { return "" }
    return found
        .sorted { $0.boundingBox.minY > $1.boundingBox.minY }
        .compactMap { $0.topCandidates(1).first?.string }
        .joined(separator: "\n")
}

/// JSON {"text": "...", "rows": [[...]] | null}; free it with gtext_free.
@_cdecl("gtext_recognize")
public func gtext_recognize(_ path: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    let url = URL(fileURLWithPath: String(cString: path))
    let box = Box()
    if #available(macOS 26.0, *) {
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            box.grab = await readDocument(url)
            done.signal()
        }
        done.wait()
    }
    if box.grab.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && box.grab.rows == nil {
        box.grab.text = readLines(url)
    }
    guard let data = try? JSONEncoder().encode(box.grab) else { return nil }
    return strdup(String(data: data, encoding: .utf8) ?? "{}")
}

@_cdecl("gtext_free")
public func gtext_free(_ p: UnsafeMutablePointer<CChar>?) {
    free(p)
}

// ---------- where a capture came from ----------

private struct Origin: Encodable {
    var app: String
    var window: String
}

/// The app and window under the pointer (or simply the front one), skipping
/// Ghostbar's own windows and the system's. After an area or window
/// screenshot the pointer is still over what was captured.
@_cdecl("gmeta_window")
public func gmeta_window(_ underPointer: Bool) -> UnsafeMutablePointer<CChar>? {
    let pointer = CGEvent(source: nil)?.location ?? .zero
    let me = getpid()
    let skip: Set<String> = ["Window Server", "Dock", "Control Centre", "Control Center", "SystemUIServer", "Notification Centre", "Notification Center", "screencaptureui", "Screenshot", "Spotlight"]
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for info in list {
        guard (info[kCGWindowLayer as String] as? Int) == 0,
              let pid = info[kCGWindowOwnerPID as String] as? Int32, pid != me,
              let owner = info[kCGWindowOwnerName as String] as? String, !skip.contains(owner),
              (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict),
              bounds.width > 80, bounds.height > 60 else { continue }
        if underPointer && !bounds.contains(pointer) { continue }
        let origin = Origin(app: owner, window: info[kCGWindowName as String] as? String ?? "")
        guard let data = try? JSONEncoder().encode(origin) else { return nil }
        return strdup(String(data: data, encoding: .utf8) ?? "{}")
    }
    return nil
}
