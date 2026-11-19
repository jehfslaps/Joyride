import CarPlay
import CoreLocation
import Foundation
import MapboxDirections
import MapboxNavigationCore
import MapboxNavigationUIKit

/// The CarPlay scene. Info.plist names this class (see plugins/withCarPlay.js).
/// CarPlay only shows Joyride once Apple has granted the CarPlay navigation
/// entitlement and the app is built with it.
@objc(JoyrideCarPlaySceneDelegate)
public final class JoyrideCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    MainActor.assumeIsolated {
      JoyrideCarPlay.shared.connect(scene: templateApplicationScene, interfaceController: interfaceController, window: window)
    }
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    MainActor.assumeIsolated {
      JoyrideCarPlay.shared.disconnect(scene: templateApplicationScene, interfaceController: interfaceController, window: window)
    }
  }
}

/// Joyride on the car's screen: the map, plus two buttons.
/// - Drives: pick a saved drive and relive it.
/// - Surprise: pick how far, and Joyride picks a random destination.
@MainActor
final class JoyrideCarPlay: NSObject, CarPlayManagerDelegate {
  static let shared = JoyrideCarPlay()

  private var manager: CarPlayManager?
  private(set) var isConnected = false

  func connect(scene: CPTemplateApplicationScene, interfaceController: CPInterfaceController, window: CPWindow) {
    let provider = JoyrideNavigator.shared.sharedProvider()
    let manager = self.manager ?? CarPlayManager(navigationProvider: provider, styles: joyrideStyles())
    // Browsing the map shouldn't count as a navigation session (Mapbox bills those).
    manager.startFreeDriveAutomatically = false
    manager.delegate = self
    self.manager = manager
    manager.templateApplicationScene(scene, didConnect: interfaceController, to: window)
    isConnected = true

    // A drive already running on the phone continues on the car screen.
    if JoyrideNavigator.shared.hasActiveSession, let here = Self.currentLocation() {
      manager.beginNavigationWithCarPlay(using: here)
    }
  }

  func disconnect(scene: CPTemplateApplicationScene, interfaceController: CPInterfaceController, window: CPWindow) {
    manager?.templateApplicationScene(scene, didDisconnect: interfaceController, from: window)
    isConnected = false
  }

  /// Shows guidance that was started on the phone on the car screen too.
  func mirrorNavigation(from here: CLLocationCoordinate2D) {
    guard isConnected else { return }
    manager?.beginNavigationWithCarPlay(using: here)
  }

  static func currentLocation() -> CLLocationCoordinate2D? {
    if let matched = JoyrideNavigator.shared.sharedProvider().mapboxNavigation.navigation()
      .currentLocationMatching?.enhancedLocation.coordinate {
      return matched
    }
    return CLLocationManager().location?.coordinate
  }

  // MARK: Buttons

  nonisolated func carPlayManager(
    _ carPlayManager: CarPlayManager,
    trailingNavigationBarButtonsCompatibleWith traitCollection: UITraitCollection,
    in carPlayTemplate: CPMapTemplate,
    for activity: CarPlayActivity
  ) -> [CPBarButton]? {
    guard activity == .browsing else { return nil }
    let drives = CPBarButton(title: "Drives") { _ in
      MainActor.assumeIsolated { JoyrideCarPlay.shared.showDrives() }
    }
    let surprise = CPBarButton(title: "Surprise") { _ in
      MainActor.assumeIsolated { JoyrideCarPlay.shared.showSurprise() }
    }
    return [drives, surprise]
  }

  nonisolated func carPlayManager(_ carPlayManager: CarPlayManager, didSetup navigationMapView: NavigationMapView) {}

  nonisolated func carPlayManager(
    _ carPlayManager: CarPlayManager,
    leadingNavigationBarButtonsCompatibleWith traitCollection: UITraitCollection,
    in carPlayTemplate: CPMapTemplate,
    for activity: CarPlayActivity,
    cameraState: NavigationCameraState
  ) -> [CPBarButton]? {
    nil
  }

  nonisolated func carPlayManager(_ carPlayManager: CarPlayManager, selectedPreviewFor trip: CPTrip, using routeChoice: CPRouteChoice) {}

  nonisolated func carPlayManager(_ carPlayManager: CarPlayManager, guidanceBackgroundColorFor style: UIUserInterfaceStyle) -> UIColor? {
    // Joyride's dark night-drive look.
    UIColor(hex: 0x0B1A12)
  }

  nonisolated func carPlayManagerWillCancelPreview(
    _ carPlayManager: CarPlayManager,
    configuration: inout CarPlayManagerCancelPreviewConfiguration
  ) {
    configuration.popToRoot = true
  }

  nonisolated func carPlayManagerDidCancelPreview(_ carPlayManager: CarPlayManager) {}

  nonisolated func carPlayManagerDidBeginNavigation(_ carPlayManager: CarPlayManager) {}

  nonisolated func carPlayManager(_ carPlayManager: CarPlayManager, didPresent navigationViewController: CarPlayNavigationViewController) {}

  nonisolated func carPlayManager(_ carPlayManager: CarPlayManager, shouldPresentArrivalUIFor waypoint: Waypoint) -> Bool {
    true
  }

  nonisolated func carPlayManager(
    _ carPlayManager: CarPlayManager,
    didFailToFetchRouteBetween waypoints: [Waypoint]?,
    options: RouteOptions,
    error: Error
  ) -> CPNavigationAlert? {
    nil
  }

  nonisolated func carPlayManagerWillEndNavigation(_ carPlayManager: CarPlayManager, byCanceling canceled: Bool) {}

  nonisolated func carPlayManagerDidEndNavigation(_ carPlayManager: CarPlayManager, byCanceling canceled: Bool) {
    MainActor.assumeIsolated { JoyrideNavigator.shared.endFromCarPlay(canceled: canceled) }
  }

  // MARK: My drives

  private func showDrives() {
    let drives = DriveStore.load()
    let items: [CPListItem] = drives.prefix(CPListTemplate.maximumItemCount).map { drive in
      let item = CPListItem(text: drive.title, detailText: drive.subtitle)
      item.handler = { _, completion in
        MainActor.assumeIsolated { JoyrideCarPlay.shared.chooseDirection(for: drive) }
        completion()
      }
      return item
    }
    let empty = CPListItem(text: "No drives yet", detailText: "Record one from the Joyride app on your phone.")
    let template = CPListTemplate(title: "My drives", sections: [CPListSection(items: items.isEmpty ? [empty] : items)])
    manager?.interfaceController?.pushTemplate(template, animated: true, completion: nil)
  }

  /// Relive it the way you drove it, or drive it back the other way.
  private func chooseDirection(for drive: StoredDrive) {
    let relive = CPListItem(text: "Relive this drive", detailText: "The same way you drove it")
    relive.handler = { _, completion in
      MainActor.assumeIsolated { JoyrideCarPlay.shared.chooseStart(trace: drive.coordinates) }
      completion()
    }
    let back = CPListItem(text: "Drive it back", detailText: "The same streets, end to start")
    back.handler = { _, completion in
      MainActor.assumeIsolated { JoyrideCarPlay.shared.chooseStart(trace: Array(drive.coordinates.reversed())) }
      completion()
    }
    let template = CPListTemplate(title: drive.title, sections: [CPListSection(items: [relive, back])])
    manager?.interfaceController?.pushTemplate(template, animated: true, completion: nil)
  }

  /// Near the start (usually home)? Go. Otherwise ask where to pick it up.
  private func chooseStart(trace: [CLLocationCoordinate2D]) {
    guard let here = Self.currentLocation(), let first = trace.first else {
      alert("Joyride doesn't know where you are yet.")
      return
    }
    if Geo.distance(here, first) < 150 {
      startReplay(trace: trace, from: here, joinNearest: false)
      return
    }
    let beginning = CPListItem(text: "From the beginning", detailText: "Drive to the start first")
    beginning.handler = { _, completion in
      MainActor.assumeIsolated { JoyrideCarPlay.shared.startReplay(trace: trace, from: here, joinNearest: false) }
      completion()
    }
    let nearest = CPListItem(text: "Nearest point", detailText: "Join the drive close to here")
    nearest.handler = { _, completion in
      MainActor.assumeIsolated { JoyrideCarPlay.shared.startReplay(trace: trace, from: here, joinNearest: true) }
      completion()
    }
    let template = CPListTemplate(title: "Pick it up where?", sections: [CPListSection(items: [beginning, nearest])])
    manager?.interfaceController?.pushTemplate(template, animated: true, completion: nil)
  }

  // MARK: Surprise

  private func showSurprise() {
    let options: [(String, Double)] = [("Within 10 miles", 10), ("Within 20 miles", 20), ("Within 30 miles", 30), ("Within 50 miles", 50)]
    let items = options.map { label, miles -> CPListItem in
      let item = CPListItem(text: label, detailText: nil)
      item.handler = { _, completion in
        MainActor.assumeIsolated { JoyrideCarPlay.shared.startSurprise(miles: miles) }
        completion()
      }
      return item
    }
    let template = CPListTemplate(title: "Surprise me", sections: [CPListSection(items: items)])
    manager?.interfaceController?.pushTemplate(template, animated: true, completion: nil)
  }

  private func startSurprise(miles: Double) {
    guard let here = Self.currentLocation() else {
      alert("Joyride doesn't know where you are yet.")
      return
    }
    let radius = miles * 1609.344
    // Somewhere between 40% and 100% of the distance, so it's a real drive,
    // through a detour spot off to one side so it isn't the obvious way.
    let distance = sqrt(pow(radius * 0.4, 2) + Double.random(in: 0...1) * (pow(radius, 2) - pow(radius * 0.4, 2)))
    let heading = Double.random(in: 0..<360)
    let destination = Geo.destination(from: here, bearing: heading, meters: distance)
    let middle = Geo.destination(from: here, bearing: heading, meters: distance / 2)
    let side = Geo.destination(from: middle, bearing: heading + (Bool.random() ? 90 : -90), meters: distance * 0.3)

    var waypoints = [Waypoint(coordinate: here), Waypoint(coordinate: side), Waypoint(coordinate: destination)]
    waypoints[1].separatesLegs = false
    let options = NavigationRouteOptions(waypoints: waypoints)
    let navigation = JoyrideNavigator.shared.sharedProvider().mapboxNavigation
    Task { @MainActor in
      do {
        let routes = try await navigation.routingProvider().calculateRoutes(options: options).value
        guard let shape = routes.mainRoute.route.shape?.coordinates, shape.count >= 2 else {
          self.alert("Couldn't find a route. Try again.")
          return
        }
        self.startReplay(trace: shape, from: here, joinNearest: false)
      } catch {
        self.alert("Couldn't find a route. Check your connection.")
      }
    }
  }

  // MARK: Starting guidance

  private func startReplay(trace: [CLLocationCoordinate2D], from here: CLLocationCoordinate2D, joinNearest: Bool) {
    Task { @MainActor in
      do {
        try await JoyrideNavigator.shared.startCarPlayReplay(trace: trace, from: here, joinNearest: joinNearest)
        self.manager?.interfaceController?.popToRootTemplate(animated: false, completion: nil)
        self.manager?.beginNavigationWithCarPlay(using: here)
      } catch {
        self.alert(error.localizedDescription)
      }
    }
  }

  private func alert(_ message: String) {
    let ok = CPAlertAction(title: "OK", style: .cancel) { _ in
      MainActor.assumeIsolated { JoyrideCarPlay.shared.manager?.interfaceController?.dismissTemplate(animated: true, completion: nil) }
    }
    let alert = CPAlertTemplate(titleVariants: [message], actions: [ok])
    manager?.interfaceController?.presentTemplate(alert, animated: true, completion: nil)
  }
}
