import MapboxMaps
import MapboxNavigationCore
import MapboxNavigationUIKit
import UIKit

/// The compass, like Apple Maps: heading-up turns the map so the way you're
/// driving points up; north-up keeps north at the top. Shared by the phone's
/// turn-by-turn screen and CarPlay, and remembered between drives.
@MainActor
enum JoyrideCompass {
  private static let key = "joyride.northUp"

  static var northUp: Bool {
    get { UserDefaults.standard.bool(forKey: key) }
    set { UserDefaults.standard.set(newValue, forKey: key) }
  }

  /// Applies the current setting to a navigation map (phone or car).
  static func apply(to view: NavigationMapView?, animated: Bool = true) {
    guard let view else { return }
    let up = northUp
    if let source = view.navigationCamera.viewportDataSource as? MobileViewportDataSource {
      source.options.followingCameraOptions.bearingUpdatesAllowed = !up
      source.options.followingCameraOptions.followsLocationCourse = !up
      if up {
        var camera = source.currentNavigationCameraOptions
        camera.followingCamera.bearing = 0
        source.currentNavigationCameraOptions = camera
      }
    } else if let source = view.navigationCamera.viewportDataSource as? CarPlayViewportDataSource {
      source.options.followingCameraOptions.bearingUpdatesAllowed = !up
      source.options.followingCameraOptions.followsLocationCourse = !up
      if up {
        var camera = source.currentNavigationCameraOptions
        camera.followingCamera.bearing = 0
        source.currentNavigationCameraOptions = camera
      }
    }
    if up, animated, let map = view.mapView.mapboxMap {
      var camera = CameraOptions(cameraState: map.cameraState)
      camera.bearing = 0
      view.mapView.camera.ease(to: camera, duration: 0.35)
    }
    view.navigationCamera.update(cameraState: .following)
  }

  static func toggle(on view: NavigationMapView?) {
    northUp.toggle()
    apply(to: view)
  }

  /// SF Symbol for the button: an arrow when the map turns with you, "N" when north is up.
  static var symbolName: String { northUp ? "location.north.line.fill" : "location.north.fill" }

  /// The phone's floating compass button for the turn-by-turn screen.
  static func phoneButton(for controller: NavigationViewController) -> FloatingButton {
    let button: FloatingButton = FloatingButton.rounded(
      image: UIImage(systemName: symbolName, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
    )
    button.accessibilityLabel = "Compass"
    let action = UIAction { [weak controller, weak button] _ in
      MainActor.assumeIsolated {
        toggle(on: controller?.navigationMapView)
        button?.setImage(
          UIImage(systemName: symbolName, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)),
          for: .normal
        )
      }
    }
    button.addAction(action, for: .touchUpInside)
    return button
  }
}
