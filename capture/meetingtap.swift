// meetingtap: capture mic + system audio and transcribe meetings on-device.
// Default mode: transcribe locally (macOS 26 SpeechAnalyzer) — audio never
// leaves the Mac. Writes JSONL utterances:
//   {"t": iso8601, "ch": "me"|"them", "text": "..."}
// ch "me" = mic, ch "them" = system audio (other meeting participants).
//
// System audio uses a Core Audio process tap (macOS 14.4+). First run prompts
// for Microphone and System Audio Recording permission (run from Terminal.app
// so the dialogs can surface; see setup.sh).
//
// Usage:
//   meetingtap --out <transcript.jsonl> [--mic-only|--sys-only] [--duration N]
//   meetingtap --pcm            # raw 2-ch 16 kHz PCM16 to stdout (Deepgram path)
//   meetingtap --selfcheck      # 3 s capture check (RMS per source), no ASR

import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation
import Speech

let SAMPLE_RATE: Double = 16000
let TICK_FRAMES = 320 // 20 ms at 16 kHz (PCM mode)
let TICK_BYTES = TICK_FRAMES * 2
let RING_CAP = 64_000 // ~2 s per source in PCM mode; drop oldest beyond (drift)

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write("meetingtap: \(msg)\n".data(using: .utf8)!)
    exit(1)
}

func check(_ status: OSStatus, _ what: String) {
    if status != noErr { fail("\(what) failed (OSStatus \(status))") }
}

func log(_ msg: String) {
    FileHandle.standardError.write("meetingtap: \(msg)\n".data(using: .utf8)!)
}

// MARK: - PCM-mode plumbing

final class Ring {
    private var data = Data()
    private let lock = NSLock()
    private(set) var totalPushed = 0
    func push(_ d: Data) {
        guard !d.isEmpty else { return }
        lock.lock()
        data.append(d)
        totalPushed += d.count
        if data.count > RING_CAP { data.removeFirst(data.count - RING_CAP) }
        lock.unlock()
    }
    // Always returns exactly n bytes; pads with silence when the source is behind.
    func pull(_ n: Int) -> Data {
        lock.lock(); defer { lock.unlock() }
        var out = Data(data.prefix(n))
        data.removeFirst(out.count)
        if out.count < n { out.append(Data(count: n - out.count)) }
        return out
    }
}

// Streaming format converter (used by both modes).
final class Reformat {
    private let converter: AVAudioConverter
    private let outFormat: AVAudioFormat
    init(from: AVAudioFormat, to: AVAudioFormat) {
        guard let c = AVAudioConverter(from: from, to: to) else {
            fail("cannot build converter \(from) -> \(to)")
        }
        outFormat = to
        converter = c
    }
    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let cap = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil, out.frameLength > 0 else { return nil }
        return out
    }
    func convertToInt16Data(_ buffer: AVAudioPCMBuffer) -> Data {
        guard let out = convert(buffer), let ch = out.int16ChannelData else { return Data() }
        return Data(bytes: ch[0], count: Int(out.frameLength) * 2)
    }
}

// MARK: - System audio (process tap)

func defaultSystemOutputUID() -> String {
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &deviceID),
          "get default output device")
    var uid: Unmanaged<CFString>?
    var usize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var uaddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    check(AudioObjectGetPropertyData(deviceID, &uaddr, 0, nil, &usize, &uid), "get output device UID")
    guard let u = uid?.takeRetainedValue() else { fail("no output device UID") }
    return u as String
}

final class SystemTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "meetingtap.sys")
    private(set) var format: AVAudioFormat!

    // Prepares the tap and reports its format; call run(onBuffer:) to start.
    func prepare() {
        log("creating system audio tap (watch for a System Audio Recording permission dialog)...")
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.name = "meetingtap"
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        check(AudioHardwareCreateProcessTap(desc, &tapID),
              "create system audio tap (System Audio Recording permission needed)")

        var asbd = AudioStreamBasicDescription()
        var fsize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var faddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        check(AudioObjectGetPropertyData(tapID, &faddr, 0, nil, &fsize, &asbd), "read tap format")
        guard let f = AVAudioFormat(streamDescription: &asbd) else { fail("bad tap format") }
        format = f
        log("system tap format: \(asbd.mSampleRate) Hz, \(asbd.mChannelsPerFrame) ch")

        let outputUID = defaultSystemOutputUID()
        let aggUID = UUID().uuidString
        let aggDesc: [String: Any] = [
            kAudioAggregateDeviceNameKey: "meetingtap-agg",
            kAudioAggregateDeviceUIDKey: aggUID,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: desc.uuid.uuidString,
            ]],
        ]
        check(AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggregateID),
              "create aggregate device")
    }

    func run(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) {
        let fmt = format!
        check(AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, queue) {
            _, inInputData, _, _, _ in
            let abl = UnsafeMutablePointer(mutating: inInputData)
            guard let pcm = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: abl,
                                             deallocator: nil), pcm.frameLength > 0 else { return }
            onBuffer(pcm)
        }, "create IO proc")
        check(AudioDeviceStart(aggregateID, ioProcID), "start aggregate device")
    }

    func stop() {
        if let p = ioProcID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, p)
            AudioDeviceDestroyIOProcID(aggregateID, p)
        }
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    }
}

// MARK: - Mic

final class MicCapture {
    private let engine = AVAudioEngine()
    private(set) var format: AVAudioFormat!

    func prepare() {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        log("mic permission status: \(status.rawValue) (0=notDetermined 1=restricted 2=denied 3=authorized)")
        if status != .authorized {
            log("requesting mic permission (watch for a macOS dialog)...")
            var granted = false
            let sem = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { ok in granted = ok; sem.signal() }
            if sem.wait(timeout: .now() + 60) == .timedOut {
                fail("mic permission dialog timed out after 60s (approve it and re-run, or grant meetingtap Microphone access in System Settings > Privacy & Security)")
            }
            guard granted else { fail("microphone permission denied") }
        }
        format = engine.inputNode.inputFormat(forBus: 0)
        log("mic format: \(format.sampleRate) Hz, \(format.channelCount) ch")
    }

    func run(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) {
        engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { buf, _ in
            onBuffer(buf)
        }
        do { try engine.start() } catch { fail("mic engine start: \(error)") }
    }

    func stop() { engine.stop() }
}

// MARK: - On-device transcription (macOS 26 SpeechAnalyzer)

final class OutputWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "meetingtap.out")
    private let handle: FileHandle?
    init(path: String?) {
        if let p = path {
            FileManager.default.createFile(atPath: p, contents: nil)
            handle = FileHandle(forWritingAtPath: p)
            if handle == nil { fail("cannot open \(p) for writing") }
        } else {
            handle = nil
        }
    }
    // Millisecond resolution: the fast path debounces on sub-second gaps between
    // volatile results, and whole-second stamps collapse them into one instant.
    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    func write(ch: String, text: String, at: Date = Date(), partial: Bool = false) {
        let iso = OutputWriter.iso.string(from: at)
        var obj: [String: Any] = ["t": iso, "ch": ch, "text": text]
        if partial { obj["partial"] = true }
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        queue.sync {
            if let h = handle {
                h.write(data)
                h.write("\n".data(using: .utf8)!)
            } else {
                FileHandle.standardOutput.write(data)
                FileHandle.standardOutput.write("\n".data(using: .utf8)!)
            }
            FileHandle.standardError.write("[\(ch)] \(text)\n".data(using: .utf8)!)
        }
    }
}

@available(macOS 26.0, *)
final class LiveTranscriber: @unchecked Sendable {
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let input: AsyncStream<AnalyzerInput>.Continuation
    private let analyzerFormat: AVAudioFormat
    private var reformat: Reformat?
    private var resultsTask: Task<Void, Never>?

    // `clock` stamps each finalized utterance. Live capture uses wall time; file
    // transcription uses the audio timeline, so an offline transcript replays with
    // the same pacing the meeting actually had.
    private let clock: () -> Date

    init(channel: String, out: OutputWriter, clock: @escaping () -> Date = { Date() },
         volatileResults: Bool = false) async throws {
        self.clock = clock
        // Volatile results are the transcriber's in-progress guess. They land
        // ~0.3s after a word is spoken instead of waiting 0.5-4.5s for the
        // utterance to finalize. The brain uses them to start working early;
        // the final result still arrives and supersedes them.
        transcriber = SpeechTranscriber(locale: Locale(identifier: "en_US"),
                                        transcriptionOptions: [],
                                        reportingOptions: volatileResults ? [.volatileResults] : [],
                                        attributeOptions: [])
        if let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            log("downloading on-device speech model (one-time)...")
            try await req.downloadAndInstall()
            log("speech model installed")
        }
        analyzer = SpeechAnalyzer(modules: [transcriber])
        guard let fmt = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            fail("no compatible audio format for on-device transcription")
        }
        analyzerFormat = fmt
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        input = continuation
        try await analyzer.start(inputSequence: stream)
        let t = transcriber
        let stamp = clock
        resultsTask = Task {
            do {
                for try await result in t.results {
                    let text = String(result.text.characters)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty { continue }
                    if result.isFinal {
                        out.write(ch: channel, text: text, at: stamp())
                    } else if volatileResults {
                        out.write(ch: channel, text: text, at: stamp(), partial: true)
                    }
                }
            } catch {
                log("transcriber(\(channel)) results error: \(error)")
            }
        }
    }

    // Called from audio threads; each source has its own LiveTranscriber.
    func feed(_ buffer: AVAudioPCMBuffer) {
        if reformat == nil { reformat = Reformat(from: buffer.format, to: analyzerFormat) }
        guard let converted = reformat!.convert(buffer) else { return }
        input.yield(AnalyzerInput(buffer: converted))
    }

    func finish() async {
        input.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        resultsTask?.cancel()
    }
}

// MARK: - Offline: transcribe a recording (mp4/m4a/wav) into transcript.jsonl
//
// Reads the file's audio track straight through AVAssetReader (no ffmpeg) and
// feeds it to the same on-device transcriber, faster than realtime. Utterances
// are stamped on the AUDIO timeline anchored at `anchor`, so the resulting
// transcript.jsonl replays with the meeting's real pacing.
//
// Caveat: a recording is a single mixed track. Everything lands on the "them"
// channel and there is no per-speaker attribution.

// Cross-thread audio position (reader loop writes, results task reads).
final class AudioPosition: @unchecked Sendable {
    private let q = DispatchQueue(label: "meetingtap.pos")
    private var _seconds: Double = 0
    var seconds: Double { q.sync { _seconds } }
    func advance(_ d: Double) { q.sync { _seconds += d } }
}

@available(macOS 26.0, *)
func transcribeFile(path: String, out: OutputWriter, anchor: Date, speed: Double) async {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else { fail("no such file: \(path)") }
    let asset = AVURLAsset(url: url)

    let tracks: [AVAssetTrack]
    do { tracks = try await asset.loadTracks(withMediaType: .audio) }
    catch { fail("cannot load audio tracks: \(error)") }
    guard let track = tracks.first else { fail("no audio track in \(path)") }

    let durationSec = (try? await asset.load(.duration).seconds) ?? 0
    log(String(format: "file: %.1f min of audio", durationSec / 60))

    let srcRate: Double = 48000
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsNonInterleaved: false,
        AVLinearPCMIsBigEndianKey: false,
        AVSampleRateKey: srcRate,
        AVNumberOfChannelsKey: 1,
    ]
    guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot create reader") }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    guard reader.canAdd(output) else { fail("cannot add reader output") }
    reader.add(output)
    guard reader.startReading() else { fail("reader failed to start: \(String(describing: reader.error))") }

    guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: srcRate,
                                  channels: 1, interleaved: false) else { fail("bad file format") }

    // Audio-timeline clock: results are stamped at the position fed so far.
    // Written by the reader loop, read by the transcriber's results task.
    let pos = AudioPosition()
    let clock: () -> Date = { anchor.addingTimeInterval(pos.seconds) }

    let t: LiveTranscriber
    do { t = try await LiveTranscriber(channel: "them", out: out, clock: clock) }
    catch { fail("transcriber init: \(error)") }

    var lastLogged = -60.0
    while reader.status == .reading, let sample = output.copyNextSampleBuffer() {
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sample) else { continue }
        let frames = CMSampleBufferGetNumSamples(sample)
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)) else {
            CMSampleBufferInvalidate(sample); continue
        }
        buf.frameLength = AVAudioFrameCount(frames)
        var lengthAtOffset = 0, totalLength = 0
        var dataPtr: UnsafeMutablePointer<Int8>?
        if CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset,
                                       totalLengthOut: &totalLength, dataPointerOut: &dataPtr) == kCMBlockBufferNoErr,
           let src = dataPtr, let dst = buf.floatChannelData?[0] {
            memcpy(dst, src, min(totalLength, frames * MemoryLayout<Float>.size))
            t.feed(buf)
            let chunkSec = Double(frames) / srcRate
            pos.advance(chunkSec)
            // Backpressure: the analyzer's input stream is unbounded, so feeding a
            // 57-minute file at disk speed would buffer the whole thing. Feed at
            // `speed`x realtime instead — bounded memory, still much faster than live.
            if speed > 0 {
                try? await Task.sleep(nanoseconds: UInt64(chunkSec / speed * 1_000_000_000))
            }
        }
        CMSampleBufferInvalidate(sample)

        let at = pos.seconds
        if at - lastLogged >= 300 { lastLogged = at; log(String(format: "  ...%.0f min transcribed", at / 60)) }
    }
    await t.finish()
    log(String(format: "file: done, %.1f min of audio processed", pos.seconds / 60))
}

// MARK: - Main

@main
struct Main {
    static func main() async {
        var args = Array(CommandLine.arguments.dropFirst())
        func flag(_ name: String) -> Bool {
            if let i = args.firstIndex(of: name) { args.remove(at: i); return true }
            return false
        }
        func opt(_ name: String) -> String? {
            if let i = args.firstIndex(of: name), i + 1 < args.count {
                let v = args[i + 1]
                args.removeSubrange(i...(i + 1))
                return v
            }
            return nil
        }

        let micOnly = flag("--mic-only")
        let sysOnly = flag("--sys-only")
        let selfCheck = flag("--selfcheck")
        let wantVolatile = flag("--volatile")
        let pcmMode = flag("--pcm")
        let outPath = opt("--out")
        let filePath = opt("--file")
        let anchorStr = opt("--anchor")
        let speed = opt("--speed").flatMap(Double.init) ?? 8
        let duration = opt("--duration").flatMap(Double.init)
        if !args.isEmpty { fail("unknown arguments: \(args.joined(separator: " "))") }

        // Offline: transcribe a recording. No audio devices, no TCC permissions.
        if let f = filePath {
            guard #available(macOS 26.0, *) else { fail("--file needs macOS 26+") }
            let anchor = anchorStr.flatMap { ISO8601DateFormatter().date(from: $0) } ?? Date()
            let out = OutputWriter(path: outPath)
            await transcribeFile(path: f, out: out, anchor: anchor, speed: speed)
            return
        }

        let mic = MicCapture()
        let sys = SystemTap()
        if !sysOnly { mic.prepare() }
        if !micOnly { sys.prepare() }

        signal(SIGINT) { _ in exit(0) }
        signal(SIGTERM) { _ in exit(0) }

        if pcmMode || selfCheck {
            runPCM(mic: mic, sys: sys, micOnly: micOnly, sysOnly: sysOnly,
                   selfCheck: selfCheck, duration: duration ?? (selfCheck ? 3.0 : nil))
            return
        }

        // Default: on-device transcription.
        guard #available(macOS 26.0, *) else {
            fail("on-device transcription needs macOS 26+; use --pcm with the Deepgram streamer instead")
        }
        let out = OutputWriter(path: outPath)
        do {
            var micT: LiveTranscriber?
            var sysT: LiveTranscriber?
            if !sysOnly { micT = try await LiveTranscriber(channel: "me", out: out, volatileResults: wantVolatile) }
            if !micOnly { sysT = try await LiveTranscriber(channel: "them", out: out, volatileResults: wantVolatile) }
            if let t = micT { mic.run { t.feed($0) } }
            if let t = sysT { sys.run { t.feed($0) } }
            log("transcribing on-device (mic=\(!sysOnly), system=\(!micOnly))... Ctrl-C to stop")
            if let d = duration {
                try await Task.sleep(nanoseconds: UInt64(d * 1_000_000_000))
                mic.stop(); sys.stop()
                await micT?.finish()
                await sysT?.finish()
            } else {
                while true { try await Task.sleep(nanoseconds: 1_000_000_000) }
            }
        } catch {
            fail("transcription setup failed: \(error)")
        }
    }

    static func runPCM(mic: MicCapture, sys: SystemTap, micOnly: Bool, sysOnly: Bool,
                       selfCheck: Bool, duration: Double?) {
        let micRing = Ring()
        let sysRing = Ring()
        guard let pcm16k = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: SAMPLE_RATE,
                                         channels: 1, interleaved: true) else { fail("bad target format") }
        if !sysOnly {
            let conv = Reformat(from: mic.format, to: pcm16k)
            mic.run { micRing.push(conv.convertToInt16Data($0)) }
        }
        if !micOnly {
            let conv = Reformat(from: sys.format, to: pcm16k)
            sys.run { sysRing.push(conv.convertToInt16Data($0)) }
        }
        log("capturing PCM (mic=\(!sysOnly), system=\(!micOnly))")

        func rms(_ d: Data) -> Double {
            let n = d.count / 2
            guard n > 0 else { return 0 }
            var acc = 0.0
            d.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
                let s = p.bindMemory(to: Int16.self)
                for i in 0..<n { let v = Double(s[i]); acc += v * v }
            }
            return (acc / Double(n)).squareRoot()
        }

        let outHandle = FileHandle.standardOutput
        let deadline = duration.map { Date().addingTimeInterval($0) } ?? Date.distantFuture
        var rmsMicAcc = 0.0, rmsSysAcc = 0.0, ticks = 0

        while Date() < deadline {
            usleep(20_000)
            let m = micRing.pull(TICK_BYTES)
            let s = sysRing.pull(TICK_BYTES)
            if selfCheck { rmsMicAcc += rms(m); rmsSysAcc += rms(s); ticks += 1; continue }
            var frame = Data(capacity: TICK_BYTES * 2)
            m.withUnsafeBytes { (mp: UnsafeRawBufferPointer) in
                s.withUnsafeBytes { (sp: UnsafeRawBufferPointer) in
                    let ms = mp.bindMemory(to: Int16.self)
                    let ss = sp.bindMemory(to: Int16.self)
                    for i in 0..<TICK_FRAMES {
                        var a = ms[i], b = ss[i]
                        withUnsafeBytes(of: &a) { frame.append(contentsOf: $0) }
                        withUnsafeBytes(of: &b) { frame.append(contentsOf: $0) }
                    }
                }
            }
            outHandle.write(frame)
        }

        if selfCheck {
            let mAvg = ticks > 0 ? rmsMicAcc / Double(ticks) : 0
            let sAvg = ticks > 0 ? rmsSysAcc / Double(ticks) : 0
            log(String(format: "selfcheck: mic pushed=%d bytes avgRMS=%.1f | system pushed=%d bytes avgRMS=%.1f",
                       micRing.totalPushed, mAvg, sysRing.totalPushed, sAvg))
            let ok = (sysOnly || micRing.totalPushed > 0) && (micOnly || sysRing.totalPushed > 0)
            log(ok ? "selfcheck: PASS (audio flowing from all requested sources)"
                   : "selfcheck: FAIL (a requested source produced no audio)")
            exit(ok ? 0 : 2)
        }
    }
}
