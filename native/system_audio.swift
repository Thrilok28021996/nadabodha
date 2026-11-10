// Record system audio (all apps except Svara itself) to a 16 kHz mono WAV.
//
//   svara-system-audio /path/out.wav
//
// Runs until SIGINT/SIGTERM. Requires macOS Screen Recording permission for the
// responsible app; ScreenCaptureKit delivers the audio of other applications.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

final class SystemAudioRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private let output: URL
    private var stream: SCStream?
    private var file: AVAudioFile?
    private var frames = 0

    init(output: URL) {
        self.output = output
        try? FileManager.default.removeItem(at: output)
    }

    func start() async throws {
        FileHandle.standardError.write("screen capture access=\(CGPreflightScreenCaptureAccess())\n".data(using: .utf8)!)
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "svara", code: 3, userInfo: [NSLocalizedDescriptionKey: "no display available"])
        }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1
        config.width = 2
        config.height = 2
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "svara.audio"))
        try await stream.startCapture()
        self.stream = stream
        FileHandle.standardError.write("capture started, displays=\(content.displays.count)\n".data(using: .utf8)!)
    }

    func stop() async {
        if let stream {
            try? await stream.stopCapture()
        }
        file = nil
    }

    private func openFile(for format: AVAudioFormat) throws {
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        file = try AVAudioFile(forWriting: output, settings: settings)
        FileHandle.standardError.write("writing \(format.sampleRate) Hz, \(format.channelCount) ch\n".data(using: .utf8)!)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        if file == nil {
            do { try openFile(for: format) } catch {
                FileHandle.standardError.write("cannot open output: \(error.localizedDescription)\n".data(using: .utf8)!)
                exit(6)
            }
        }
        guard let file else { return }
        var block: CMBlockBuffer?
        var list = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &list,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &block
        )
        guard status == noErr else {
            FileHandle.standardError.write("buffer list failed: \(status)\n".data(using: .utf8)!)
            return
        }
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: &list, deallocator: nil) else { return }
        do {
            try file.write(from: pcm)
            frames += 1
            if frames == 1 {
                FileHandle.standardError.write("first buffer written\n".data(using: .utf8)!)
            }
        } catch {
            FileHandle.standardError.write("write failed: \(error.localizedDescription)\n".data(using: .utf8)!)
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write("stream stopped: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(3)
    }
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write("usage: svara-system-audio OUTPUT.wav\n".data(using: .utf8)!)
    exit(2)
}
let output = URL(fileURLWithPath: arguments[1])

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let recorder = SystemAudioRecorder(output: output)
Task {
    do {
        try await recorder.start()
        FileHandle.standardError.write("recording\n".data(using: .utf8)!)
    } catch {
        FileHandle.standardError.write("start failed: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(4)
    }
}
let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let finish: () -> Void = {
    Task {
        await recorder.stop()
        exit(0)
    }
}
sigint.setEventHandler(handler: finish)
sigterm.setEventHandler(handler: finish)
sigint.resume()
sigterm.resume()
RunLoop.main.run()
