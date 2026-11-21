import Combine
import CoreLocation
import MapboxMaps
import MapboxNavigationCore
import MapboxNavigationUIKit
import Turf
import UIKit

/// While a drive records, the CarPlay map shows it:
///  - a red dot that pulses gently, with the time so far ("REC 12:34"), top left;
///  - a green trail behind you, where you've been on this drive.
/// Both go away when the recording stops.
@MainActor
final class JoyrideRecordingOverlay {
  static let shared = JoyrideRecordingOverlay()

  private static let sourceId = "joyride-trail"
  private static let layerId = "joyride-trail-line"

  private var startedAt = Date()
  private var trail: [CLLocationCoordinate2D] = []
  private weak var mapView: MapView?
  private weak var badge: RecordingBadge?
  private var styleWatch: AnyCancelable?
  private var locationWatch: AnyCancellable?
  private var clock: Timer?
  private(set) var isOn = false

  /// Starts showing the recording on `host` (the CarPlay map screen).
  func start(on host: UIViewController?, mapView: MapView?, startedAt: Date?, trail seed: [CLLocationCoordinate2D]) {
    isOn = true
    self.startedAt = startedAt ?? Date()
    if !seed.isEmpty { trail = seed }
    attach(host: host, mapView: mapView)

    // New positions from the navigation engine (free drive or guidance), ~1 a second.
    locationWatch = JoyrideNavigator.shared.sharedProvider().mapboxNavigation.navigation().locationMatching
      .map(\.enhancedLocation)
      .receive(on: DispatchQueue.main)
      .sink { location in
        MainActor.assumeIsolated { JoyrideRecordingOverlay.shared.add(location.coordinate) }
      }

    clock?.invalidate()
    clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
      MainActor.assumeIsolated { JoyrideRecordingOverlay.shared.tick() }
    }
    tick()
  }

  /// Hooks the badge and trail onto a (possibly new) CarPlay map, e.g. after reconnecting.
  func attach(host: UIViewController?, mapView: MapView?) {
    guard isOn else { return }
    if let host, badge?.superview !== host.view {
      badge?.removeFromSuperview()
      let view = RecordingBadge()
      view.translatesAutoresizingMaskIntoConstraints = false
      host.view.addSubview(view)
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: host.view.safeAreaLayoutGuide.leadingAnchor, constant: 10),
        view.topAnchor.constraint(equalTo: host.view.safeAreaLayoutGuide.topAnchor, constant: 10),
      ])
      badge = view
      tick()
    }
    if let mapView, mapView !== self.mapView {
      self.mapView = mapView
      // The map's style reloads when it switches day/night; put the trail back each time.
      styleWatch = mapView.mapboxMap?.onStyleLoaded.observe { _ in
        MainActor.assumeIsolated { JoyrideRecordingOverlay.shared.drawTrail(fresh: true) }
      }
      drawTrail(fresh: true)
    }
  }

  func stop() {
    isOn = false
    locationWatch = nil
    styleWatch = nil
    clock?.invalidate()
    clock = nil
    badge?.removeFromSuperview()
    badge = nil
    trail = []
    if let map = mapView?.mapboxMap {
      if map.layerExists(withId: Self.layerId) { try? map.removeLayer(withId: Self.layerId) }
      if map.sourceExists(withId: Self.sourceId) { try? map.removeSource(withId: Self.sourceId) }
    }
    mapView = nil
  }

  private func tick() {
    let s = max(0, Int(Date().timeIntervalSince(startedAt)))
    let text = s >= 3600
      ? String(format: "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)
      : String(format: "%d:%02d", s / 60, s % 60)
    badge?.time = text
  }

  private func add(_ c: CLLocationCoordinate2D) {
    guard isOn, CLLocationCoordinate2DIsValid(c) else { return }
    if let last = trail.last,
       CLLocation(latitude: last.latitude, longitude: last.longitude).distance(from: CLLocation(latitude: c.latitude, longitude: c.longitude)) < 4 {
      return
    }
    trail.append(c)
    drawTrail(fresh: false)
  }

  private func drawTrail(fresh: Bool) {
    guard isOn, let mapView, let map = mapView.mapboxMap else { return }
    let line: GeoJSONObject = trail.count >= 2 ? .geometry(.lineString(LineString(trail))) : .featureCollection(FeatureCollection(features: []))
    if !map.sourceExists(withId: Self.sourceId) {
      var source = GeoJSONSource(id: Self.sourceId)
      source.data = trail.count >= 2 ? .geometry(.lineString(LineString(trail))) : .featureCollection(FeatureCollection(features: []))
      try? map.addSource(source)
    } else {
      map.updateGeoJSONSource(withId: Self.sourceId, geoJSON: line)
    }
    if !map.layerExists(withId: Self.layerId) {
      let dark = mapView.traitCollection.userInterfaceStyle == .dark
      var layer = LineLayer(id: Self.layerId, source: Self.sourceId)
      layer.lineColor = .constant(StyleColor(dark ? UIColor(hex: 0x7CFF6B) : UIColor(hex: 0x1E8A57)))
      layer.lineWidth = .expression(Exp(.interpolate) { Exp(.linear); Exp(.zoom); 10; 3; 16; 7; 19; 12 })
      layer.lineOpacity = .constant(0.9)
      layer.lineCap = .constant(.round)
      layer.lineJoin = .constant(.round)
      // Under the location puck, so you stay on top of your own trail.
      let below = ["puck", "mapbox-location-indicator-layer"].first { map.layerExists(withId: $0) }
      try? map.addLayer(layer, layerPosition: below.map { .below($0) })
    }
  }
}

/// "● REC 12:34": a small dark pill with a gently pulsing red dot.
final class RecordingBadge: UIView {
  private let dot = UIView()
  private let label = UILabel()

  var time: String = "0:00" {
    didSet { label.text = "REC  \(time)" }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor(white: 0.05, alpha: 0.82)
    layer.cornerRadius = 14
    layer.cornerCurve = .continuous
    isUserInteractionEnabled = false
    isAccessibilityElement = true
    accessibilityLabel = "Recording"

    dot.backgroundColor = UIColor(red: 1, green: 0.23, blue: 0.19, alpha: 1)
    dot.layer.cornerRadius = 5
    dot.translatesAutoresizingMaskIntoConstraints = false
    label.font = .monospacedDigitSystemFont(ofSize: 14, weight: .bold)
    label.textColor = .white
    label.text = "REC  0:00"
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(dot)
    addSubview(label)
    NSLayoutConstraint.activate([
      heightAnchor.constraint(equalToConstant: 28),
      dot.widthAnchor.constraint(equalToConstant: 10),
      dot.heightAnchor.constraint(equalToConstant: 10),
      dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
      dot.centerYAnchor.constraint(equalTo: centerYAnchor),
      label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 7),
      label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -11),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
    pulse()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// A slow breathe, not a blink; a steady dot when Reduce Motion is on.
  private func pulse() {
    guard !UIAccessibility.isReduceMotionEnabled else { return }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0.35
    let grow = CABasicAnimation(keyPath: "transform.scale")
    grow.fromValue = 1
    grow.toValue = 0.8
    let group = CAAnimationGroup()
    group.animations = [fade, grow]
    group.duration = 0.9
    group.autoreverses = true
    group.repeatCount = .infinity
    group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    dot.layer.add(group, forKey: "pulse")
  }
}
