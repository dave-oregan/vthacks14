import SwiftUI

struct VideoPreviewView: View {
    let image: UIImage?

    var body: some View {
        GroupBox("Live Preview") {
            ZStack {
                Rectangle()
                    .fill(Color.black.opacity(0.85))
                    .aspectRatio(4 / 3, contentMode: .fit)
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .aspectRatio(4 / 3, contentMode: .fit)
                        .clipped()
                } else {
                    Text("No camera frame")
                        .foregroundStyle(.white.opacity(0.7))
                        .font(.caption.monospaced())
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}
