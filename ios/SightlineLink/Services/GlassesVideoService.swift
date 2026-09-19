import Foundation
import UIKit

/// Thin helper around Meta wearable frames: JPEG encode off the main thread.
enum GlassesVideoService {
    static let defaultJPEGQuality: CGFloat = 0.65

    static func jpegData(
        from image: UIImage,
        quality: CGFloat = defaultJPEGQuality
    ) -> (Data, Int, Int)? {
        let width = Int(image.size.width * image.scale)
        let height = Int(image.size.height * image.scale)
        guard let data = image.jpegData(compressionQuality: quality) else { return nil }
        return (data, width, height)
    }

    /// Encode on a cooperative background task.
    static func encodeJPEGAsync(
        image: UIImage,
        quality: CGFloat
    ) async -> (Data, Int, Int)? {
        await Task.detached(priority: .userInitiated) {
            jpegData(from: image, quality: quality)
        }.value
    }
}
