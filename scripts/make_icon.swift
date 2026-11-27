// Draw the Svara app icon (Catppuccin Mocha, waveform motif) to a PNG.
//
//   swift scripts/make_icon.swift assets/icon.png
//
// Reproducible so the icon can be regenerated instead of hand-edited.

import AppKit
import CoreGraphics

let side = 1024
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/icon.png"

func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha
    )
}

let space = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(
    data: nil,
    width: side,
    height: side,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: space,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
    fatalError("cannot create context")
}

let canvas = CGFloat(side)

// Squircle plate, inset like a macOS app icon.
let inset: CGFloat = 84
let plate = CGRect(x: inset, y: inset, width: canvas - inset * 2, height: canvas - inset * 2)
let radius: CGFloat = 190
let platePath = CGPath(roundedRect: plate, cornerWidth: radius, cornerHeight: radius, transform: nil)

context.saveGState()
context.addPath(platePath)
context.clip()
let plateGradient = CGGradient(
    colorsSpace: space,
    colors: [color(0x1E1E2E), color(0x11111B)] as CFArray,
    locations: [0, 1]
)!
context.drawLinearGradient(
    plateGradient,
    start: CGPoint(x: plate.midX, y: plate.maxY),
    end: CGPoint(x: plate.midX, y: plate.minY),
    options: []
)
// Soft highlight along the top edge.
let glow = CGGradient(
    colorsSpace: space,
    colors: [color(0xFFFFFF, alpha: 0.09), color(0xFFFFFF, alpha: 0)] as CFArray,
    locations: [0, 1]
)!
context.drawLinearGradient(
    glow,
    start: CGPoint(x: plate.midX, y: plate.maxY),
    end: CGPoint(x: plate.midX, y: plate.maxY - 260),
    options: []
)
context.restoreGState()

// Hairline border.
context.addPath(platePath)
context.setStrokeColor(color(0x585B70, alpha: 0.95))
context.setLineWidth(6)
context.strokePath()

// Waveform: five rounded bars, centred, Catppuccin accents.
let heights: [CGFloat] = [0.38, 0.64, 0.92, 0.70, 0.46]
let colors: [UInt32] = [0x89B4FA, 0xB4BEFE, 0xCBA6F7, 0xB4BEFE, 0x94E2D5]
let barWidth: CGFloat = 62
let gap: CGFloat = 52
let total = CGFloat(heights.count) * barWidth + CGFloat(heights.count - 1) * gap
var x = (canvas - total) / 2
let maxHeight = plate.height * 0.52

for (index, fraction) in heights.enumerated() {
    let height = maxHeight * fraction
    let bar = CGRect(x: x, y: (canvas - height) / 2 - 3, width: barWidth, height: height)
    let path = CGPath(
        roundedRect: bar,
        cornerWidth: barWidth / 2,
        cornerHeight: barWidth / 2,
        transform: nil
    )
    context.addPath(path)
    context.setFillColor(color(colors[index]))
    context.fillPath()
    // Inner shadow at the bottom of each bar for a little depth.
    context.saveGState()
    context.addPath(path)
    context.clip()
    let shade = CGGradient(
        colorsSpace: space,
        colors: [color(0x000000, alpha: 0), color(0x000000, alpha: 0.12)] as CFArray,
        locations: [0.55, 1]
    )!
    context.drawLinearGradient(
        shade,
        start: CGPoint(x: bar.midX, y: bar.maxY),
        end: CGPoint(x: bar.midX, y: bar.minY),
        options: []
    )
    context.restoreGState()
    x += barWidth + gap
}

guard let image = context.makeImage() else { fatalError("cannot render") }
let bitmap = NSBitmapImageRep(cgImage: image)
guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("cannot encode") }
try data.write(to: URL(fileURLWithPath: output))
print("wrote \(output) (\(side)x\(side))")
