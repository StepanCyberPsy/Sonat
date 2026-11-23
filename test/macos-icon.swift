import AppKit

// Finder and the Dock obtain the bundle icon from Launch Services.
let installed = NSWorkspace.shared.icon(forFile: CommandLine.arguments[1])
let approved = NSImage(contentsOfFile: CommandLine.arguments[2])!

func pixels(of image: NSImage) -> [UInt8] {
    let size = 32
    var data = [UInt8](repeating: 0, count: size * size * 4)
    data.withUnsafeMutableBytes { bytes in
        let context = CGContext(data: bytes.baseAddress, width: size, height: size,
            bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.interpolationQuality = .high
        let bounds = CGRect(x: 0, y: 0, width: size, height: size)
        context.draw(image.cgImage(forProposedRect: nil, context: nil, hints: nil)!, in: bounds)
    }
    return data
}

let actual = pixels(of: installed)
let expected = pixels(of: approved)
let difference = zip(actual, expected).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }
let mean = Double(difference) / Double(actual.count)
print("Mean icon channel difference (0–255):", mean)
precondition(mean < 24, "macOS returned a different application icon")
