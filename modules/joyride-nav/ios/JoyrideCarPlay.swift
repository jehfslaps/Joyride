import CarPlay
import Combine
import CoreLocation
import Foundation
import MapboxDirections
import MapboxMaps
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
    // Live location is started by liveOnCar() below, so the dot always moves with you.
    manager.startFreeDriveAutomatically = false
    manager.delegate = self
    self.manager = manager
    manager.templateApplicationScene(scene, didConnect: interfaceController, to: window)
    isConnected = true

    // Already recording (started on the phone): show the REC badge, trail and Stop right away.
    if recording {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        MainActor.assumeIsolated {
          let car = JoyrideCarPlay.shared
          let mapVC = car.manager?.carPlayMapViewController
          JoyrideRecordingOverlay.shared.attach(host: mapVC, mapView: mapVC?.navigationMapView.mapView)
          car.keepButtonsShowing(true)
          if car.manager?.carPlayNavigationViewController == nil { car.followWhileRecording(true) }
        }
      }
    }

    // A drive already running on the phone continues on the car screen.
    if JoyrideNavigator.shared.hasActiveSession, let here = Self.currentLocation() {
      manager.beginNavigationWithCarPlay(using: here)
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { MainActor.assumeIsolated { JoyrideCarPlay.shared.liveOnCar() } }
    }
  }

  /// Whenever the car screen is connected and nothing is being navigated:
  /// live location on, so your dot moves with you in real time and the map
  /// follows (until you zoom or pan; the location button brings it back).
  func liveOnCar() {
    guard isConnected, !JoyrideNavigator.shared.hasActiveSession else { return }
    JoyrideNavigator.shared.sharedProvider().mapboxNavigation.tripSession().startFreeDrive()
    let view = manager?.carPlayMapViewController?.navigationMapView
    view?.navigationCamera.update(cameraState: .following)
    JoyrideCompass.apply(to: view, animated: false)
  }

  func disconnect(scene: CPTemplateApplicationScene, interfaceController: CPInterfaceController, window: CPWindow) {
    manager?.templateApplicationScene(scene, didDisconnect: interfaceController, from: window)
    isConnected = false
    // Off the car screen and not navigating: stop live location (saves battery).
    if !JoyrideNavigator.shared.hasActiveSession {
      JoyrideNavigator.shared.sharedProvider().mapboxNavigation.tripSession().setToIdle()
    }
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

  /// While driving: zoom in, zoom out, and back to following you, down the right
  /// side of the map. Browsing keeps Mapbox's own set (which has zoom too).
  nonisolated func carPlayManager(
    _ carPlayManager: CarPlayManager,
    mapButtonsCompatibleWith traitCollection: UITraitCollection,
    in carPlayTemplate: CPTemplate,
    for activity: CarPlayActivity
  ) -> [CPMapButton]? {
    switch activity {
    case .navigating:
      return MainActor.assumeIsolated { JoyrideCarPlay.shared.drivingButtons() }
    case .browsing:
      return MainActor.assumeIsolated { JoyrideCarPlay.shared.browsingButtons(carPlayManager) }
    default:
      return nil
    }
  }

  nonisolated func carPlayManager(_ carPlayManager: CarPlayManager, didSetup navigationMapView: NavigationMapView) {}

  nonisolated func carPlayManager(
    _ carPlayManager: CarPlayManager,
    leadingNavigationBarButtonsCompatibleWith traitCollection: UITraitCollection,
    in carPlayTemplate: CPMapTemplate,
    for activity: CarPlayActivity,
    cameraState: NavigationCameraState
  ) -> [CPBarButton]? {
    guard activity == .browsing else { return nil }
    return MainActor.assumeIsolated { [JoyrideCarPlay.shared.recordButton] }
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

  nonisolated func carPlayManager(_ carPlayManager: CarPlayManager, didPresent navigationViewController: CarPlayNavigationViewController) {
    // Same as the phone: the part you've driven turns gray behind you.
    MainActor.assumeIsolated {
      navigationViewController.routeLineTracksTraversal = true
      JoyrideCompass.apply(to: navigationViewController.navigationMapView, animated: false)
      JoyrideCarPlay.shared.watchArrows(in: navigationViewController)
    }
  }

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
    MainActor.assumeIsolated {
      JoyrideCarPlay.shared.arrowWatch = nil
      JoyrideNavigator.shared.endFromCarPlay(canceled: canceled)
      // Still recording: keep the map following you.
      if JoyrideCarPlay.shared.recording { JoyrideCarPlay.shared.followWhileRecording(true) }
    }
  }

  // MARK: Driving buttons and cleanup

  private static func symbol(_ name: String) -> UIImage? {
    UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold))
  }

  func drivingButtons() -> [CPMapButton] {
    let recenter = CPMapButton { _ in MainActor.assumeIsolated { JoyrideCarPlay.shared.follow() } }
    recenter.image = Self.symbol("location.fill")
    let compass = compassButton { JoyrideCarPlay.shared.manager?.navigationMapView }
    let zoomIn = CPMapButton { _ in MainActor.assumeIsolated { JoyrideCarPlay.shared.zoom(by: 1) } }
    zoomIn.image = Self.symbol("plus")
    let zoomOut = CPMapButton { _ in MainActor.assumeIsolated { JoyrideCarPlay.shared.zoom(by: -1) } }
    zoomOut.image = Self.symbol("minus")
    return [recenter, compass, zoomIn, zoomOut]
  }

  /// Browsing the map (and recording): Mapbox's recenter and zoom, plus the compass.
  func browsingButtons(_ manager: CarPlayManager) -> [CPMapButton]? {
    guard let mapVC = manager.carPlayMapViewController else { return nil }
    let compass = compassButton { JoyrideCarPlay.shared.manager?.carPlayMapViewController?.navigationMapView }
    return [mapVC.recenterButton, compass, mapVC.zoomInButton, mapVC.zoomOutButton]
  }

  private func compassButton(_ view: @escaping @MainActor () -> NavigationMapView?) -> CPMapButton {
    let button = CPMapButton { button in
      MainActor.assumeIsolated {
        JoyrideCompass.toggle(on: view())
        button.image = Self.symbol(JoyrideCompass.symbolName)
      }
    }
    button.image = Self.symbol(JoyrideCompass.symbolName)
    return button
  }

  // MARK: Turn arrows

  /// Mapbox draws a left-turn arrow as a right arrow marked "show mirrored",
  /// and the car screen can drop that mark, so lefts showed as rights. After
  /// each new instruction, swap in arrows that are really drawn facing left.
  var arrowWatch: AnyCancellable?

  func watchArrows(in controller: CarPlayNavigationViewController) {
    let navigation = JoyrideNavigator.shared.sharedProvider().mapboxNavigation
    arrowWatch = navigation.navigation().bannerInstructions
      .receive(on: DispatchQueue.main)
      .sink { [weak controller] _ in
        // Let Mapbox put its maneuvers up first.
        DispatchQueue.main.async { MainActor.assumeIsolated { Self.fixArrows(in: controller) } }
      }
    Self.fixArrows(in: controller)
  }

  static func fixArrows(in controller: CarPlayNavigationViewController?) {
    guard let controller,
          let session = Mirror(reflecting: controller).children.first(where: { $0.label == "carSession" })?.value as? CPNavigationSession
    else { return }
    let maneuvers = session.upcomingManeuvers
    var changed = false
    for maneuver in maneuvers {
      guard let set = maneuver.symbolSet else { continue }
      let light = set.lightContentImage
      let dark = set.darkContentImage
      guard light.imageOrientation == .upMirrored || dark.imageOrientation == .upMirrored else { continue }
      maneuver.symbolSet = CPImageSet(lightContentImage: baked(light), darkContentImage: baked(dark))
      changed = true
    }
    if changed { session.upcomingManeuvers = maneuvers }
  }

  /// Redraws an image that's only marked as mirrored so its pixels really face the other way.
  private static func baked(_ image: UIImage) -> UIImage {
    guard image.imageOrientation == .upMirrored else { return image }
    let format = UIGraphicsImageRendererFormat()
    format.scale = image.scale
    return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }

  // MARK: Recording

  private(set) var recording = false

  lazy var recordButton: CPBarButton = CPBarButton(title: "Record") { _ in
    MainActor.assumeIsolated { JoyrideCarPlay.shared.tappedRecord() }
  }

  private func tappedRecord() {
    JoyrideNavModule.requestRecord(start: !recording)
  }

  /// From the app: whether a drive is recording now (it may have started on the phone).
  func setRecording(_ on: Bool, message: String?, startedAt: Date? = nil, trail: [CLLocationCoordinate2D] = []) {
    if on != recording {
      recording = on
      recordButton.title = on ? "Stop" : "Record"
      if manager?.carPlayNavigationViewController == nil { followWhileRecording(on) }
      if on {
        let mapVC = manager?.carPlayMapViewController
        JoyrideRecordingOverlay.shared.start(on: mapVC, mapView: mapVC?.navigationMapView.mapView, startedAt: startedAt, trail: trail)
      } else {
        JoyrideRecordingOverlay.shared.stop()
      }
      keepButtonsShowing(on)
    }
    if let message { alert(message) }
  }

  /// While recording, the top buttons (with Stop) stay on screen instead of
  /// fading away after a few seconds, so stopping is always one tap.
  private func keepButtonsShowing(_ on: Bool) {
    (manager?.interfaceController?.rootTemplate as? CPMapTemplate)?.automaticallyHidesNavigationBar = !on
  }

  /// Recording or not, the car map keeps showing where you are live.
  func followWhileRecording(_ on: Bool) {
    liveOnCar()
  }

  /// Zooming pauses following you (like Apple Maps); the location button picks it back up.
  func zoom(by step: Double) {
    guard let view = manager?.navigationMapView, let map = view.mapView.mapboxMap else { return }
    view.navigationCamera.stop()
    var camera = CameraOptions(cameraState: map.cameraState)
    camera.zoom = min(19.5, max(4, map.cameraState.zoom + step))
    view.mapView.camera.ease(to: camera, duration: 0.3)
  }

  func follow() {
    manager?.navigationMapView?.navigationCamera.update(cameraState: .following)
  }

  /// After a drive ends: no route left on the car's map, just you where you are.
  func clearMap() {
    guard let manager else { return }
    let tidy = {
      guard let view = manager.carPlayMapViewController?.navigationMapView else { return }
      view.removeRoutes()
      if let here = Self.currentLocation() {
        view.mapView.camera.ease(to: CameraOptions(center: here, zoom: 14.5, bearing: 0, pitch: 0), duration: 0.6)
      }
      // And keep following you live from here.
      JoyrideCarPlay.shared.liveOnCar()
    }
    tidy()
    // Mapbox swaps the map template back in after ending; tidy again once it has.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { MainActor.assumeIsolated { tidy() } }
  }

  /// The drive was ended on the phone: end it on the car screen too.
  func endOnCar() {
    manager?.carPlayNavigationViewController?.exitNavigation(byCanceling: true)
    clearMap()
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
        // Like the phone's "Record this drive" (on by default): record drives started in the car.
        if !self.recording { JoyrideNavModule.requestRecord(start: true) }
        self.manager?.interfaceController?.popToRootTemplate(animated: false, completion: nil)
        self.manager?.beginNavigationWithCarPlay(using: here)
      } catch {
        self.alert(error.localizedDescription)
      }
    }
  }

  func alert(_ message: String) {
    let ok = CPAlertAction(title: "OK", style: .cancel) { _ in
      MainActor.assumeIsolated { JoyrideCarPlay.shared.manager?.interfaceController?.dismissTemplate(animated: true, completion: nil) }
    }
    let alert = CPAlertTemplate(titleVariants: [message], actions: [ok])
    manager?.interfaceController?.presentTemplate(alert, animated: true, completion: nil)
  }
}
