import CoreLocation
import ExpoModulesCore
import MapboxDirections
import MapboxNavigationCore
import MapboxNavigationUIKit
import UIKit

/// Joyride's bridge to the Mapbox Navigation SDK.
///
/// Phase 1: proves the SDK is linked and can guide along a road-matched trace.
/// `startMatchedNavigation` takes up to 100 recorded points, asks Mapbox's Map
/// Matching service which roads they were on, and presents full-screen
/// turn-by-turn guidance along exactly those roads.
public final class JoyrideNavModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JoyrideNav")

    Events("onNavigationEnded")

    /// Whether the native navigation engine is present in this build.
    Constant("isAvailable") { true }

    /// The Mapbox Navigation SDK version this build was made with.
    Constant("sdkVersion") { "3.27.3" }

    /// Guides the driver along a road-matched version of `coordinates`
    /// ([longitude, latitude] pairs, 2 to 100 of them).
    /// Resolves once guidance is on screen; `onNavigationEnded` fires when it closes.
    AsyncFunction("startMatchedNavigation") { (coordinates: [[Double]], simulate: Bool, promise: Promise) in
      let points = coordinates.compactMap { pair -> CLLocationCoordinate2D? in
        guard pair.count >= 2 else { return nil }
        return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
      }
      guard points.count >= 2, points.count <= 100 else {
        promise.reject("E_POINTS", "Need between 2 and 100 points, got \(points.count).")
        return
      }
      Task { @MainActor in
        do {
          try await JoyrideNavigator.shared.startMatched(
            points: points,
            simulate: simulate,
            presenter: self.appContext?.utilities?.currentViewController()
          ) { [weak self] canceled, arrived in
            self?.sendEvent("onNavigationEnded", ["canceled": canceled, "arrived": arrived])
          }
          promise.resolve(nil)
        } catch {
          promise.reject("E_NAVIGATION", error.localizedDescription)
        }
      }
    }
  }
}

/// Owns the single Mapbox navigation instance the SDK allows per app.
/// Everything here runs on the main thread.
final class JoyrideNavigator: NSObject, NavigationViewControllerDelegate {
  static let shared = JoyrideNavigator()

  private var provider: MapboxNavigationProvider?
  private var providerIsSimulated = false
  private var onEnded: ((Bool, Bool) -> Void)?
  private var arrived = false

  @MainActor
  private func navigationProvider(simulate: Bool) -> MapboxNavigationProvider {
    let config = CoreConfig(
      routingConfig: RoutingConfig(
        // A matched route is the exact recorded drive. Joyride decides how to
        // get you back onto it, so the SDK must never swap in a new route.
        rerouteConfig: RerouteConfig(detectsReroute: false)
      ),
      locationSource: simulate ? .simulation(initialLocation: nil) : .live
    )
    if let provider {
      if providerIsSimulated != simulate {
        provider.apply(coreConfig: config)
        providerIsSimulated = simulate
      }
      return provider
    }
    let created = MapboxNavigationProvider(coreConfig: config)
    provider = created
    providerIsSimulated = simulate
    return created
  }

  @MainActor
  func startMatched(
    points: [CLLocationCoordinate2D],
    simulate: Bool,
    presenter: UIViewController?,
    onEnded: @escaping (Bool, Bool) -> Void
  ) async throws {
    guard let presenter else { throw JoyrideNavError.noScreen }
    let provider = navigationProvider(simulate: simulate)
    let navigation = provider.mapboxNavigation

    // Only the first and last points are stops; everything in between just
    // shapes the route.
    var waypoints = points.map { Waypoint(coordinate: $0) }
    for index in waypoints.indices {
      waypoints[index].separatesLegs = index == 0 || index == waypoints.count - 1
    }
    let options = NavigationMatchOptions(waypoints: waypoints)

    let routes = try await navigation.routingProvider().calculateRoutes(options: options).value

    let navigationOptions = NavigationOptions(
      mapboxNavigation: navigation,
      voiceController: provider.routeVoiceController,
      eventsManager: provider.eventsManager()
    )
    let controller = NavigationViewController(navigationRoutes: routes, navigationOptions: navigationOptions)
    controller.modalPresentationStyle = .fullScreen
    controller.routeLineTracksTraversal = true
    controller.delegate = self

    self.onEnded = onEnded
    self.arrived = false
    presenter.present(controller, animated: true)
  }

  // MARK: NavigationViewControllerDelegate

  func navigationViewController(
    _ navigationViewController: NavigationViewController,
    didArriveAt waypoint: Waypoint
  ) {
    arrived = true
  }

  func navigationViewControllerDidDismiss(
    _ navigationViewController: NavigationViewController,
    byCanceling canceled: Bool
  ) {
    navigationViewController.dismiss(animated: true)
    onEnded?(canceled, arrived)
    onEnded = nil
  }
}

enum JoyrideNavError: LocalizedError {
  case noScreen

  var errorDescription: String? {
    switch self {
    case .noScreen: return "There is no screen to show navigation on."
    }
  }
}
