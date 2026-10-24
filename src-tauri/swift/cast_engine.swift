// Cast: Ghostbar's video recorder. The screen (or one window) and the
// camera are captured separately and composited here, frame by frame, so the
// face bubble, the 9:16 phone crop and its smooth moves land in the video
// exactly as the preview shows them, whatever is on screen.
//
// - Capture runs from `prepare` on (the preview needs it); writing only
//   between `record` and `stop`.
// - The view (9:16 crop centre and zoom) eases towards where Gus points it.
// - Pause drops frames and shifts later timestamps back, so the file has no gap.

import AVFoundation
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

private let fps: Int32 = 30
private let verticalSize = CGSize(width: 1080, height: 1920)

private struct Look {
    var vertical = false
    // 9:16 crop: centre as a share of the source (from the top left), zoom >= 1
    var cx = 0.5, cy = 0.5, zoom = 1.4
    // bubble: centre as a share of the output (from the top left), diameter as
    // a share of the output's shorter side
    var bx = 0.12, by = 0.8, size = 0.22, faceZoom = 1.0, show = true, camera = true
}

private final class Engine: NSObject, SCStreamOutput, SCStreamDelegate,
    AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate
{
    let lock = NSLock()
    var look = Look()
    var shown = Look()  // eased copy used for drawing

    var stream: SCStream?
    var camSession: AVCaptureSession?
    var micSession: AVCaptureSession?
    var screen: CIImage?
    var cam: CIImage?
    var lastOutput: CIImage?
    var failure: String?

    let ci = CIContext(options: [.cacheIntermediates: false, .workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB)!])
    let composeQueue = DispatchQueue(label: "gus.cast.compose")
    let captureQueue = DispatchQueue(label: "gus.cast.capture")
    let audioQueue = DispatchQueue(label: "gus.cast.audio")
    var timer: DispatchSourceTimer?

    // writing
    var writer: AVAssetWriter?
    var videoIn: AVAssetWriterInput?
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    var micIn: AVAssetWriterInput?
    var sysIn: AVAssetWriterInput?
    var outSize = CGSize(width: 1920, height: 1080)
    var recording = false
    var paused = false
    var started = false
    var pausedTotal = CMTime.zero
    var pauseBegan: CMTime?
    var startedAt: CMTime?
    var lastVideoTime = CMTime.zero
    var tempURL: URL?
    var systemAudio = false

    // MARK: capture callbacks

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .screen:
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                let raw = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status == .complete,
                let pb = CMSampleBufferGetImageBuffer(sb)
            else { return }
            let image = CIImage(cvPixelBuffer: pb)
            lock.lock(); screen = image; lock.unlock()
        case .audio:
            append(sb, to: sysIn)
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock(); failure = error.localizedDescription; lock.unlock()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output is AVCaptureAudioDataOutput {
            append(sb, to: micIn, clock: micSession?.synchronizationClock)
            return
        }
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let image = CIImage(cvPixelBuffer: pb)
        lock.lock(); cam = image; lock.unlock()
    }

    // MARK: drawing

    func ease() {
        let k = 0.22
        shown.cx += (look.cx - shown.cx) * k
        shown.cy += (look.cy - shown.cy) * k
        shown.zoom += (look.zoom - shown.zoom) * k
        shown.bx = look.bx; shown.by = look.by; shown.size = look.size
        shown.faceZoom = look.faceZoom; shown.show = look.show; shown.camera = look.camera
        shown.vertical = look.vertical
    }

    /// The part of the source the phone shows, in the source's pixels (top-left origin).
    static func crop(_ l: Look, _ sw: Double, _ sh: Double) -> CGRect {
        var h = sh / max(1, l.zoom)
        var w = h * Double(verticalSize.width / verticalSize.height)
        if w > sw { w = sw; h = w * Double(verticalSize.height / verticalSize.width) }
        let x = min(max(l.cx * sw - w / 2, 0), sw - w)
        let y = min(max(l.cy * sh - h / 2, 0), sh - h)
        return CGRect(x: x, y: y, width: w, height: h)
    }

    static func even(_ v: CGFloat) -> CGFloat { CGFloat(Int(v.rounded()) & ~1) }

    func outputSize(for source: CGRect, vertical: Bool) -> CGSize {
        vertical ? verticalSize : CGSize(width: Engine.even(source.width), height: Engine.even(source.height))
    }

    func bubble(_ camImage: CIImage, look l: Look, out: CGSize) -> CIImage? {
        let d = (l.size * Double(min(out.width, out.height))).rounded()
        guard d >= 16 else { return nil }
        let r = d / 2
        let inner = r - max(3, r * 0.05)
        let ext = camImage.extent
        let side = Double(min(ext.width, ext.height)) / max(1, l.faceZoom)
        let square = camImage
            .cropped(to: CGRect(x: ext.midX - side / 2, y: ext.midY - side / 2, width: side, height: side))
            .transformed(by: CGAffineTransform(translationX: -(ext.midX - side / 2), y: -(ext.midY - side / 2)))
        let k = (inner * 2) / side
        // scaled, mirrored like a selfie, centred on (r, r)
        let face = square
            .transformed(by: CGAffineTransform(scaleX: -k, y: k))
            .transformed(by: CGAffineTransform(translationX: r + inner, y: r - inner))
        // A soft-edged disc; uncropped it fades to clear everywhere, so it blurs cleanly.
        func disc(_ radius: Double, _ color: CIColor, cropped: Bool = true) -> CIImage {
            let g = CIFilter.radialGradient()
            g.center = CGPoint(x: r, y: r)
            g.radius0 = Float(radius - 1)
            g.radius1 = Float(radius)
            g.color0 = color
            g.color1 = CIColor(red: 0, green: 0, blue: 0, alpha: 0)
            return cropped ? g.outputImage!.cropped(to: CGRect(x: 0, y: 0, width: d, height: d)) : g.outputImage!
        }
        let mask = disc(inner, CIColor.white)
        let blend = CIFilter.blendWithMask()
        blend.inputImage = face
        blend.backgroundImage = CIImage.empty()
        blend.maskImage = mask
        guard let round = blend.outputImage?.cropped(to: CGRect(x: 0, y: 0, width: d, height: d)) else { return nil }
        let ring = disc(r, CIColor.white)
        let shade = disc(r, CIColor(red: 0, green: 0, blue: 0, alpha: 0.35), cropped: false)
            .applyingGaussianBlur(sigma: r * 0.08)
            .cropped(to: CGRect(x: -r * 0.3, y: -r * 0.3, width: d + r * 0.6, height: d + r * 0.6))
            .transformed(by: CGAffineTransform(translationX: 0, y: -r * 0.04))
        let composed = round.composited(over: ring.composited(over: shade))
        let cx = l.bx * Double(out.width)
        let cy = (1 - l.by) * Double(out.height)  // Core Image is bottom-up
        return composed.transformed(by: CGAffineTransform(translationX: cx - r, y: cy - r))
    }

    /// One output frame from the latest screen and camera images.
    func frame() -> CIImage? {
        lock.lock()
        let src = screen
        let camImage = cam
        ease()
        let l = shown
        lock.unlock()
        guard let src else { return nil }
        let ext = src.extent
        let out = outputSize(for: ext, vertical: l.vertical)
        let outRect = CGRect(origin: .zero, size: out)
        var image: CIImage
        if l.vertical {
            let c = Engine.crop(l, Double(ext.width), Double(ext.height))
            let ciRect = CGRect(x: c.minX, y: Double(ext.height) - c.maxY, width: c.width, height: c.height)
            image = src.cropped(to: ciRect)
                .transformed(by: CGAffineTransform(translationX: -ciRect.minX, y: -ciRect.minY))
                .transformed(by: CGAffineTransform(scaleX: out.width / ciRect.width, y: out.height / ciRect.height))
        } else {
            image = src.transformed(by: CGAffineTransform(translationX: -ext.minX, y: -ext.minY))
        }
        image = image.composited(over: CIImage(color: CIColor.black)).cropped(to: outRect)
        if l.camera, l.show, let camImage, let b = bubble(camImage, look: l, out: out) {
            image = b.composited(over: image).cropped(to: outRect)
        }
        return image
    }

    func tick() {
        guard let image = frame() else { return }
        lock.lock()
        lastOutput = image
        let shouldWrite = recording && !paused
        let (writer, videoIn, adaptor, isStarted, shift) = (self.writer, self.videoIn, self.adaptor, started, pausedTotal)
        lock.unlock()
        guard shouldWrite, let writer, let videoIn, let adaptor else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if !isStarted {
            guard writer.startWriting() else {
                lock.lock(); failure = writer.error?.localizedDescription ?? "couldn't start writing"; lock.unlock()
                return
            }
            writer.startSession(atSourceTime: now)
            lock.lock(); startedAt = now; started = true; lock.unlock()
        }
        let time = CMTimeSubtract(now, shift)
        guard videoIn.isReadyForMoreMediaData, CMTimeCompare(time, lastVideoTime) > 0,
            let pool = adaptor.pixelBufferPool
        else { return }
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
        guard let pb else { return }
        ci.render(image, to: pb, bounds: CGRect(origin: .zero, size: outSize), colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        if adaptor.append(pb, withPresentationTime: time) {
            lastVideoTime = time
        }
    }

    /// Audio goes in on the host clock the video uses, minus any paused time.
    func append(_ sb: CMSampleBuffer, to input: AVAssetWriterInput?, clock: CMClock? = nil) {
        lock.lock()
        let ok = recording && !paused && started
        let shift = pausedTotal
        let start = startedAt
        lock.unlock()
        guard ok, let input, input.isReadyForMoreMediaData else { return }
        var pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if let clock { pts = CMSyncConvertTime(pts, from: clock, to: CMClockGetHostTimeClock()) }
        if let start, CMTimeCompare(pts, start) < 0 { return }
        if shift == .zero && clock == nil {
            input.append(sb)
            return
        }
        var timing = CMSampleTimingInfo(
            duration: CMSampleBufferGetDuration(sb),
            presentationTimeStamp: CMTimeSubtract(pts, shift),
            decodeTimeStamp: .invalid)
        var shifted: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sb, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &shifted)
        if let shifted { input.append(shifted) }
    }

    func startTimer() {
        timer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: composeQueue)
        t.schedule(deadline: .now(), repeating: .nanoseconds(Int(1_000_000_000 / fps)), leeway: .milliseconds(2))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }
}

private let engine = Engine()
private var lastError = strdup("")

private func fail(_ message: String) -> Int32 {
    free(lastError)
    lastError = strdup(message)
    return -1
}

private func blocking<T>(_ work: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Result<T, Error>!
    Task.detached {
        do { result = .success(try await work()) } catch { result = .failure(error) }
        done.signal()
    }
    done.wait()
    return try result.get()
}

private func err(_ text: String) -> NSError {
    NSError(domain: "gus.cast", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
}

// MARK: sources

private struct Source: Codable {
    let kind: String  // "display" | "window"
    let id: UInt32
    let name: String
    let app: String
    let x: Double, y: Double, w: Double, h: Double  // points, global, top-left origin
}

private func content() throws -> SCShareableContent {
    try blocking { try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) }
}

private func listSources() throws -> [Source] {
    let c = try content()
    let own = Bundle.main.bundleIdentifier ?? ""
    let skip: Set<String> = ["com.apple.dock", "com.apple.WindowManager", "com.apple.controlcenter", "com.apple.notificationcenterui", "com.apple.Spotlight", own]
    var out: [Source] = []
    let main = CGMainDisplayID()
    for (i, d) in c.displays.sorted(by: { $0.displayID == main ? true : ($1.displayID == main ? false : $0.displayID < $1.displayID) }).enumerated() {
        let f = d.frame
        out.append(Source(kind: "display", id: d.displayID, name: i == 0 ? "Main screen" : "Screen \(i + 1)", app: "", x: f.minX, y: f.minY, w: f.width, h: f.height))
    }
    for w in c.windows where w.windowLayer == 0 && w.frame.width >= 160 && w.frame.height >= 120 && w.isOnScreen {
        let app = w.owningApplication
        if skip.contains(app?.bundleIdentifier ?? "") { continue }
        let f = w.frame
        out.append(Source(kind: "window", id: w.windowID, name: w.title ?? "", app: app?.applicationName ?? "", x: f.minX, y: f.minY, w: f.width, h: f.height))
    }
    return out
}

private func filter(kind: String, id: UInt32) throws -> (SCContentFilter, CGRect, CGFloat) {
    let c = try content()
    if kind == "window" {
        guard let w = c.windows.first(where: { $0.windowID == id }) else { throw err("That window is gone. Pick it again.") }
        let scale = NSScreen.screens.first(where: { $0.frame.intersects(w.frame) })?.backingScaleFactor ?? 2
        return (SCContentFilter(desktopIndependentWindow: w), w.frame, scale)
    }
    guard let d = c.displays.first(where: { $0.displayID == id }) ?? c.displays.first else { throw err("No screen to record") }
    let own = c.applications.filter { $0.bundleIdentifier == Bundle.main.bundleIdentifier }
    let scale = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == d.displayID })?.backingScaleFactor ?? 2
    return (SCContentFilter(display: d, excludingApplications: own, exceptingWindows: []), d.frame, scale)
}

private func jpeg(_ image: CIImage, maxWidth: Double) -> Data? {
    let k = min(1, maxWidth / Double(image.extent.width))
    let small = image.transformed(by: CGAffineTransform(scaleX: k, y: k))
    return engine.ci.jpegRepresentation(of: small, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6])
}

private func hand(_ data: Data?, _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ len: UnsafeMutablePointer<Int>) -> Int32 {
    guard let data, !data.isEmpty else { return -1 }
    let p = UnsafeMutablePointer<UInt8>.allocate(capacity: data.count)
    data.copyBytes(to: p, count: data.count)
    out.pointee = p
    len.pointee = data.count
    return 0
}

// MARK: C API

@_cdecl("gcast_free")
public func gcast_free(_ p: UnsafeMutableRawPointer?) { free(p) }

@_cdecl("gcast_free_bytes")
public func gcast_free_bytes(_ p: UnsafeMutablePointer<UInt8>?, _ len: Int) { p?.deallocate() }

@_cdecl("gcast_last_error")
public func gcast_last_error() -> UnsafePointer<CChar>? { UnsafePointer(lastError) }

@_cdecl("gcast_has_permission")
public func gcast_has_permission() -> Int32 { CGPreflightScreenCaptureAccess() ? 1 : 0 }

@_cdecl("gcast_request_permission")
public func gcast_request_permission() -> Int32 { CGRequestScreenCaptureAccess() ? 1 : 0 }

/// JSON list of screens and windows; free with gcast_free.
@_cdecl("gcast_sources")
public func gcast_sources() -> UnsafeMutablePointer<CChar>? {
    do {
        let data = try JSONEncoder().encode(try listSources())
        return strdup(String(data: data, encoding: .utf8) ?? "[]")
    } catch {
        _ = fail(error.localizedDescription)
        return nil
    }
}

/// A small JPEG of one screen or window, for the picker.
@_cdecl("gcast_thumbnail")
public func gcast_thumbnail(_ kind: UnsafePointer<CChar>, _ id: UInt32, _ maxWidth: Double,
    _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ len: UnsafeMutablePointer<Int>) -> Int32
{
    do {
        let (f, rect, _) = try filter(kind: String(cString: kind), id: id)
        let config = SCStreamConfiguration()
        let k = min(1, maxWidth / rect.width)
        config.width = max(2, Int(rect.width * k * 2))
        config.height = max(2, Int(rect.height * k * 2))
        config.showsCursor = false
        let cg = try blocking { try await SCScreenshotManager.captureImage(contentFilter: f, configuration: config) }
        return hand(jpeg(CIImage(cgImage: cg), maxWidth: maxWidth * 2), out, len)
    } catch {
        return fail(error.localizedDescription)
    }
}

/// Start capturing a screen or window (and the camera) for the preview.
@_cdecl("gcast_prepare")
public func gcast_prepare(_ kind: UnsafePointer<CChar>, _ id: UInt32, _ camera: Int32, _ systemAudio: Int32) -> Int32 {
    gcast_close()
    do {
        let (f, rect, scale) = try filter(kind: String(cString: kind), id: id)
        let config = SCStreamConfiguration()
        config.width = Int(Engine.even(rect.width * scale))
        config.height = Int(Engine.even(rect.height * scale))
        config.minimumFrameInterval = CMTime(value: 1, timescale: fps)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.queueDepth = 6
        config.showsCursor = true
        if #available(macOS 15.0, *) { config.showMouseClicks = true }
        config.capturesAudio = systemAudio != 0
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        let s = SCStream(filter: f, configuration: config, delegate: engine)
        try s.addStreamOutput(engine, type: .screen, sampleHandlerQueue: engine.captureQueue)
        if systemAudio != 0 { try s.addStreamOutput(engine, type: .audio, sampleHandlerQueue: engine.audioQueue) }
        try blocking { try await s.startCapture() }
        engine.stream = s
        engine.systemAudio = systemAudio != 0
    } catch {
        return fail("Couldn't capture the screen: \(error.localizedDescription)")
    }
    if camera != 0, let device = AVCaptureDevice.default(for: .video) {
        let session = AVCaptureSession()
        session.sessionPreset = .hd1280x720
        if let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) {
            session.addInput(input)
            let output = AVCaptureVideoDataOutput()
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(engine, queue: engine.captureQueue)
            if session.canAddOutput(output) { session.addOutput(output) }
            session.startRunning()
            engine.camSession = session
        }
    }
    engine.lock.lock()
    engine.look.camera = camera != 0
    engine.shown = engine.look
    engine.lock.unlock()
    engine.startTimer()
    return 0
}

@_cdecl("gcast_set_view")
public func gcast_set_view(_ vertical: Int32, _ cx: Double, _ cy: Double, _ zoom: Double) {
    engine.lock.lock()
    let snap = engine.look.vertical != (vertical != 0)
    engine.look.vertical = vertical != 0
    engine.look.cx = cx; engine.look.cy = cy; engine.look.zoom = zoom
    if snap { engine.shown.cx = cx; engine.shown.cy = cy; engine.shown.zoom = zoom }
    engine.lock.unlock()
}

@_cdecl("gcast_set_bubble")
public func gcast_set_bubble(_ x: Double, _ y: Double, _ size: Double, _ faceZoom: Double, _ show: Int32) {
    engine.lock.lock()
    engine.look.bx = x; engine.look.by = y; engine.look.size = size
    engine.look.faceZoom = faceZoom; engine.look.show = show != 0
    engine.lock.unlock()
}

/// The latest output frame (0) or the whole source (1) as a JPEG.
@_cdecl("gcast_preview")
public func gcast_preview(_ which: Int32, _ maxWidth: Double,
    _ out: UnsafeMutablePointer<UnsafeMutablePointer<UInt8>?>, _ len: UnsafeMutablePointer<Int>) -> Int32
{
    engine.lock.lock()
    let image = which == 1 ? engine.screen : engine.lastOutput
    engine.lock.unlock()
    guard let image else { return -1 }
    return hand(jpeg(image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY)), maxWidth: maxWidth), out, len)
}

/// Start writing (the capture is already running).
@_cdecl("gcast_record")
public func gcast_record(_ microphone: Int32) -> Int32 {
    engine.lock.lock()
    let src = engine.screen
    let vertical = engine.look.vertical
    engine.lock.unlock()
    guard let src else { return fail("Nothing captured yet. Give it a second and try again.") }
    let size = engine.outputSize(for: src.extent, vertical: vertical)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("gus-cast-\(UUID().uuidString).mp4")
    do {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let bitrate = max(6_000_000, Int(size.width * size.height * 3))
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoExpectedSourceFrameRateKey: Int(fps),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        video.expectsMediaDataInRealTime = true
        guard writer.canAdd(video) else { throw err("can't add video") }
        writer.add(video)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(size.width),
            kCVPixelBufferHeightKey as String: Int(size.height),
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ])
        func audioInput(_ channels: Int) -> AVAssetWriterInput? {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: channels,
                AVEncoderBitRateKey: 128_000,
            ])
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { return nil }
            writer.add(input)
            return input
        }
        var mic: AVAssetWriterInput?
        if microphone != 0, let device = AVCaptureDevice.default(for: .audio) {
            mic = audioInput(1)
            let session = AVCaptureSession()
            if let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) {
                session.addInput(input)
                let output = AVCaptureAudioDataOutput()
                output.audioSettings = [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: 48000,
                    AVNumberOfChannelsKey: 1,
                    AVLinearPCMBitDepthKey: 32,
                    AVLinearPCMIsFloatKey: true,
                    AVLinearPCMIsNonInterleaved: false,
                ]
                output.setSampleBufferDelegate(engine, queue: engine.audioQueue)
                if session.canAddOutput(output) { session.addOutput(output) }
                engine.micSession = session
            }
        }
        let system = engine.systemAudio ? audioInput(2) : nil
        engine.lock.lock()
        engine.writer = writer
        engine.videoIn = video
        engine.adaptor = adaptor
        engine.micIn = mic
        engine.sysIn = system
        engine.outSize = size
        engine.tempURL = url
        engine.started = false
        engine.paused = false
        engine.pausedTotal = .zero
        engine.pauseBegan = nil
        engine.startedAt = nil
        engine.lastVideoTime = .zero
        engine.recording = true
        engine.lock.unlock()
        engine.micSession?.startRunning()
        return 0
    } catch {
        return fail("Couldn't start the file: \(error.localizedDescription)")
    }
}

@_cdecl("gcast_pause")
public func gcast_pause() {
    engine.lock.lock(); defer { engine.lock.unlock() }
    guard engine.recording, !engine.paused else { return }
    engine.paused = true
    engine.pauseBegan = CMClockGetTime(CMClockGetHostTimeClock())
}

@_cdecl("gcast_resume")
public func gcast_resume() {
    engine.lock.lock(); defer { engine.lock.unlock() }
    guard engine.recording, engine.paused, let began = engine.pauseBegan else { return }
    let now = CMClockGetTime(CMClockGetHostTimeClock())
    engine.pausedTotal = CMTimeAdd(engine.pausedTotal, CMTimeSubtract(now, began))
    engine.pauseBegan = nil
    engine.paused = false
}

@_cdecl("gcast_elapsed_ms")
public func gcast_elapsed_ms() -> Double {
    engine.lock.lock(); defer { engine.lock.unlock() }
    guard engine.recording, let start = engine.startedAt else { return 0 }
    let now = engine.pauseBegan ?? CMClockGetTime(CMClockGetHostTimeClock())
    return CMTimeGetSeconds(CMTimeSubtract(CMTimeSubtract(now, start), engine.pausedTotal)) * 1000
}

@_cdecl("gcast_failure")
public func gcast_failure() -> UnsafeMutablePointer<CChar>? {
    engine.lock.lock(); defer { engine.lock.unlock() }
    return engine.failure.map { strdup($0) }
}

private func finishWriting() -> URL? {
    engine.lock.lock()
    engine.recording = false
    let writer = engine.writer
    let url = engine.tempURL
    let started = engine.started
    engine.writer = nil
    engine.lock.unlock()
    engine.micSession?.stopRunning()
    engine.micSession = nil
    guard let writer, started else { return nil }
    engine.videoIn?.markAsFinished()
    engine.micIn?.markAsFinished()
    engine.sysIn?.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    return writer.status == .completed ? url : nil
}

/// Finish the file and move it to `path`. Capture keeps running.
@_cdecl("gcast_stop")
public func gcast_stop(_ path: UnsafePointer<CChar>) -> Int32 {
    guard let url = finishWriting() else { return fail("The recording didn't save (nothing was written).") }
    let dest = URL(fileURLWithPath: String(cString: path))
    do {
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: url, to: dest)
        return 0
    } catch {
        return fail("Couldn't save the video: \(error.localizedDescription)")
    }
}

@_cdecl("gcast_discard")
public func gcast_discard() {
    if let url = finishWriting() { try? FileManager.default.removeItem(at: url) }
}

/// Stop capturing (closes the preview, camera and microphone).
@_cdecl("gcast_close")
public func gcast_close() {
    gcast_discard()
    engine.timer?.cancel()
    engine.timer = nil
    if let s = engine.stream { try? blocking { try await s.stopCapture() } }
    engine.stream = nil
    engine.camSession?.stopRunning()
    engine.camSession = nil
    engine.lock.lock()
    engine.screen = nil
    engine.cam = nil
    engine.lastOutput = nil
    engine.failure = nil
    engine.lock.unlock()
}

/// Writes a few seconds from made-up screen and camera images through the real
/// compositor and writer, so the drawing and the file can be checked without
/// screen-recording permission. Vertical when `vertical` is 1.
@_cdecl("gcast_selftest")
public func gcast_selftest(_ path: UnsafePointer<CChar>, _ vertical: Int32) -> Int32 {
    gcast_close()
    let sw = 2880.0, sh = 1800.0
    let screenImage = CIFilter.linearGradient()
    screenImage.point0 = .zero
    screenImage.point1 = CGPoint(x: sw, y: sh)
    screenImage.color0 = CIColor(red: 0.95, green: 0.95, blue: 0.97)
    screenImage.color1 = CIColor(red: 0.2, green: 0.3, blue: 0.7)
    let checker = CIFilter.checkerboardGenerator()
    checker.width = 60
    checker.color0 = CIColor(red: 0.9, green: 0.6, blue: 0.4)
    checker.color1 = CIColor(red: 0.3, green: 0.2, blue: 0.1)
    engine.lock.lock()
    engine.screen = screenImage.outputImage!.cropped(to: CGRect(x: 0, y: 0, width: sw, height: sh))
    engine.cam = checker.outputImage!.cropped(to: CGRect(x: 0, y: 0, width: 1280, height: 720))
    engine.look = Look()
    engine.look.vertical = vertical != 0
    engine.look.camera = true
    engine.shown = engine.look
    engine.lock.unlock()
    guard gcast_record(0) == 0 else { return -1 }
    engine.startTimer()
    // pan the phone crop and pause in the middle: the file should be ~2 s long
    Thread.sleep(forTimeInterval: 0.7)
    gcast_set_view(vertical, 0.2, 0.3, 2)
    Thread.sleep(forTimeInterval: 0.3)
    gcast_pause()
    Thread.sleep(forTimeInterval: 0.8)
    gcast_resume()
    Thread.sleep(forTimeInterval: 1.0)
    let r = gcast_stop(path)
    gcast_close()
    return r
}
