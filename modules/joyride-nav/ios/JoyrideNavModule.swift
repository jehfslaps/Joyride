import CoreLocation
import ExpoModulesCore
import MapboxDirections
import MapboxNavigationCore
import MapboxNavigationUIKit
import UIKit

/// Joyride's bridge to the Mapbox Navigation SDK.
///
/// `startReplay` takes a whole recorded drive and guides the driver along the
/// exact same roads, full screen, with voice turn-by-turn directions. If the
/// driver isn't on the drive yet, it first gets them to it.
public final class JoyrideNavModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JoyrideNav")

    Events("onNavigationEnded", "onCarPlayRecord")

    OnCreate { JoyrideNavModule.current = self }

    /// Tells CarPlay whether a drive is being recorded (for its Record / Stop
    /// button), with an optional message to show on the car screen.
    Function("setRecording") { (on: Bool, message: String?) in
      Task { @MainActor in JoyrideCarPlay.shared.setRecording(on, message: message) }
    }

    /// A Record or Stop tapped on CarPlay while JavaScript wasn't listening yet: "start", "stop" or null.
    Function("takeRecordRequest") { () -> String? in
      let pending = JoyrideNavModule.pendingRecord
      JoyrideNavModule.pendingRecord = nil
      return pending
    }

    /// Whether the native navigation engine is present in this build.
    Constant("isAvailable") { true }

    /// The Mapbox Navigation SDK version this build was made with.
    Constant("sdkVersion") { "3.27.3" }

    /// Keeps a copy of the saved drives for CarPlay, which can run without the
    /// phone app's JavaScript.
    AsyncFunction("syncDrives") { (drives: [DriveRecord]) in
      DriveStore.save(drives.map {
        StoredDrive(id: $0.id, title: $0.title, subtitle: $0.subtitle, trace: $0.trace)
      })
    }

    /// Relives a recorded drive.
    /// - trace: the recorded points, [longitude, latitude] pairs, in driving order
    /// - here: the driver's current [longitude, latitude]
    /// - joinNearest: join at the nearest point of the drive instead of its start
    /// - simulate: drive the route automatically (for testing)
    /// - secret: a mystery destination; hide anything that would give away where it ends
    /// Resolves once guidance is on screen; `onNavigationEnded` fires when it closes.
    AsyncFunction("startReplay") { (trace: [[Double]], here: [Double], joinNearest: Bool, simulate: Bool, secret: Bool, promise: Promise) in
      let points = trace.compactMap(Self.coordinate)
      guard points.count >= 2 else {
        promise.reject("E_POINTS", "This drive doesn't have enough points to navigate.")
        return
      }
      guard let start = Self.coordinate(here) else {
        promise.reject("E_LOCATION", "Joyride doesn't know where you are yet.")
        return
      }
      Task { @MainActor in
        do {
          try await JoyrideNavigator.shared.startReplay(
            trace: points,
            from: start,
            joinNearest: joinNearest,
            simulate: simulate,
            secret: secret,
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

  /// The live module, so CarPlay can ask the app's JavaScript to start or stop recording.
  static weak var current: JoyrideNavModule?
  static var pendingRecord: String?

  static func requestRecord(start: Bool) {
    if let module = current {
      module.sendEvent("onCarPlayRecord", ["start": start])
    } else {
      pendingRecord = start ? "start" : "stop"
    }
  }

  private static func coordinate(_ pair: [Double]) -> CLLocationCoordinate2D? {
    guard pair.count >= 2 else { return nil }
    let c = CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
    return CLLocationCoordinate2DIsValid(c) ? c : nil
  }
}

struct DriveRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var subtitle: String = ""
  @Field var trace: [[Double]] = []
}

/// Owns the single Mapbox navigation instance the SDK allows per app.
/// Everything here runs on the main thread.
final class JoyrideNavigator: NSObject, NavigationViewControllerDelegate {
  static let shared = JoyrideNavigator()

  private var provider: MapboxNavigationProvider?
  private var providerIsSimulated = false
  private var session: ReplaySession?
  private var onEnded: ((Bool, Bool) -> Void)?
  private var arrived = false

  @MainActor
  private func navigationProvider(simulate: Bool) -> MapboxNavigationProvider {
    let config = CoreConfig(
      routingConfig: RoutingConfig(
        // A replay follows the exact recorded drive. Joyride decides how to get
        // you back onto it, so the SDK must never swap in its own route.
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

  /// The live (not simulated) navigation provider, shared with CarPlay.
  @MainActor
  func sharedProvider() -> MapboxNavigationProvider {
    provider ?? navigationProvider(simulate: false)
  }

  var hasActiveSession: Bool { session != nil }

  /// Starts a replay chosen on the car screen. CarPlay shows its own guidance.
  @MainActor
  func startCarPlayReplay(
    trace: [CLLocationCoordinate2D],
    from here: CLLocationCoordinate2D,
    joinNearest: Bool
  ) async throws {
    let navigation = sharedProvider().mapboxNavigation
    session?.stop()
    let replay = ReplaySession(navigation: navigation, trace: trace)
    guard !replay.isEmpty else { throw JoyrideNavError.tooShort }
    let routes = try await replay.firstRoutes(from: here, joinNearest: joinNearest)
    session = replay
    navigation.tripSession().startActiveGuidance(with: routes, startLegIndex: 0)
    replay.attach()
  }

  @MainActor
  /// The drive was ended on the car screen: stop guidance everywhere, close
  /// the phone's navigation screen too, and leave just you on the map.
  func endFromCarPlay(canceled: Bool) {
    session?.stop()
    session = nil
    sharedProvider().mapboxNavigation.tripSession().setToIdle()
    if let phone = phoneController {
      phoneController = nil
      phone.dismiss(animated: true)
      onEnded?(canceled, arrived)
      onEnded = nil
    }
    JoyrideCarPlay.shared.clearMap()
  }

  /// The phone's navigation screen, while it's showing.
  weak var phoneController: NavigationViewController?

  @MainActor
  func startReplay(
    trace: [CLLocationCoordinate2D],
    from here: CLLocationCoordinate2D,
    joinNearest: Bool,
    simulate: Bool,
    secret: Bool = false,
    presenter: UIViewController?,
    onEnded: @escaping (Bool, Bool) -> Void
  ) async throws {
    guard let presenter else { throw JoyrideNavError.noScreen }
    let provider = navigationProvider(simulate: simulate)
    let navigation = provider.mapboxNavigation

    session?.stop()
    let replay = ReplaySession(navigation: navigation, trace: trace)
    guard !replay.isEmpty else { throw JoyrideNavError.tooShort }
    let routes = try await replay.firstRoutes(from: here, joinNearest: joinNearest)

    // A mystery drive hides its end pin, overview and arrival time.
    JoyrideTheme.secret = secret
    let banner = BottomBannerViewController()
    let navigationOptions = NavigationOptions(
      mapboxNavigation: navigation,
      voiceController: provider.routeVoiceController,
      eventsManager: provider.eventsManager(),
      styles: joyrideStyles(),
      bottomBanner: banner
    )
    let controller = NavigationViewController(navigationRoutes: routes, navigationOptions: navigationOptions)
    // Our own copy of the standard bottom bar, so it can show the whole drive; its End button still goes to the controller.
    banner.delegate = controller
    controller.modalPresentationStyle = .fullScreen
    controller.routeLineTracksTraversal = true
    controller.delegate = self
    // Light or dark follows the phone's appearance, like the rest of Joyride.
    controller.automaticallyAdjustsStyleForTimeOfDay = false
    controller.usesNightStyleInDarkMode = true
    controller.styleManager.applyStyle(type: presenter.traitCollection.userInterfaceStyle == .light ? .day : .night)
    if secret, let buttons = controller.floatingButtons, buttons.count > 1 {
      // The first floating button is the route overview, which would show the end.
      controller.floatingButtons = Array(buttons.dropFirst())
    }
    // Compass: heading-up or north-up, like Apple Maps.
    controller.floatingButtons = (controller.floatingButtons ?? []) + [JoyrideCompass.phoneButton(for: controller)]
    // The bottom bar shows the whole drive, not just the piece being guided.
    replay.onWholeProgress = { [weak banner] meters, seconds in
      DispatchQueue.main.async {
        guard let banner, banner.isViewLoaded else { return }
        JoyrideTheme.fill(banner, meters: meters, seconds: seconds, secret: secret)
      }
    }

    session = replay
    self.onEnded = onEnded
    arrived = false
    phoneController = controller
    presenter.present(controller, animated: true) {
      MainActor.assumeIsolated {
        replay.attach()
        JoyrideCompass.apply(to: controller.navigationMapView, animated: false)
        JoyrideCarPlay.shared.mirrorNavigation(from: here)
      }
    }
  }

  // MARK: NavigationViewControllerDelegate

  func navigationViewController(
    _ navigationViewController: NavigationViewController,
    didArriveAt waypoint: Waypoint
  ) {
    // Only the end of the whole drive counts; the end of a piece or of a
    // detour is just a handover.
    MainActor.assumeIsolated {
      if session?.phase == .finished { arrived = true }
    }
  }

  func navigationViewControllerDidDismiss(
    _ navigationViewController: NavigationViewController,
    byCanceling canceled: Bool
  ) {
    MainActor.assumeIsolated {
      session?.stop()
      session = nil
      phoneController = nil
      navigationViewController.dismiss(animated: true)
      // Ended on the phone: end it on the car screen too, and clear the route there.
      JoyrideCarPlay.shared.endOnCar()
    }
    onEnded?(canceled, arrived)
    onEnded = nil
  }
}

enum JoyrideNavError: LocalizedError {
  case noScreen
  case tooShort

  var errorDescription: String? {
    switch self {
    case .noScreen: return "There is no screen to show navigation on."
    case .tooShort: return "This drive is too short to navigate."
    }
  }
}
