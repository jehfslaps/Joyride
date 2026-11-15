import CoreLocation
import Foundation

/// A saved drive as CarPlay needs it. The phone app keeps the master copy and
/// sends updates here (see `syncDrives`), because CarPlay can run while the
/// phone app's JavaScript isn't running.
struct StoredDrive: Codable {
  let id: String
  let title: String
  let subtitle: String
  /// [longitude, latitude] pairs in driving order.
  let trace: [[Double]]

  var coordinates: [CLLocationCoordinate2D] {
    trace.compactMap { pair in
      guard pair.count >= 2 else { return nil }
      return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
    }
  }
}

/// Saves the drive list to a file in the app's private storage.
enum DriveStore {
  private static var fileURL: URL? {
    guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      return nil
    }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("joyride-drives.json")
  }

  static func save(_ drives: [StoredDrive]) {
    guard let url = fileURL, let data = try? JSONEncoder().encode(drives) else { return }
    try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  static func load() -> [StoredDrive] {
    guard let url = fileURL, let data = try? Data(contentsOf: url) else { return [] }
    return (try? JSONDecoder().decode([StoredDrive].self, from: data)) ?? []
  }
}
