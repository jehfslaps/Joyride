import Combine
import MapboxMaps
import MapboxNavigationCore
import MapboxNavigationUIKit
import UIKit

// Joyride's look for Mapbox's turn-by-turn screen: one green scale from
// near-black to mint, a lime glow only on live things (your position, the
// route ahead, the next turn), and warm colors only for traffic and End.
// Turn instructions stay solid, high-contrast text.

extension UIColor {
  convenience init(hex: UInt32, alpha: CGFloat = 1) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255,
      green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255,
      alpha: alpha
    )
  }
}

struct JoyridePalette {
  let dark: Bool
  let canvas: UIColor
  let raised: UIColor
  let deep: UIColor
  let emerald: UIColor
  let brand: UIColor
  let glow: UIColor
  let text: UIColor
  let text2: UIColor
  let hairline: UIColor
  let caution: UIColor
  let hazard: UIColor
  /// Colors for Mapbox's map, as CSS color strings.
  let map: [String: String]

  static let night = JoyridePalette(
    dark: true,
    canvas: UIColor(hex: 0x050A07),
    raised: UIColor(hex: 0x0B1A12),
    deep: UIColor(hex: 0x0F3D26),
    emerald: UIColor(hex: 0x1E6B45),
    brand: UIColor(hex: 0x3BA373),
    glow: UIColor(hex: 0x7CFF6B),
    text: UIColor(hex: 0xE6F7EC),
    text2: UIColor(hex: 0xE6F7EC, alpha: 0.62),
    hairline: UIColor(white: 1, alpha: 0.10),
    caution: UIColor(hex: 0xFFB547),
    hazard: UIColor(hex: 0xFF6B5B),
    map: [
      "colorLand": "#07110B",
      "colorWater": "#05171A",
      "colorGreenspace": "#0A2215",
      "colorRoads": "#12241A",
      "colorTrunks": "#1B3527",
      "colorMotorways": "#22442F",
      "colorPlaceLabels": "rgba(230, 247, 236, 0.7)",
      "colorRoadLabels": "rgba(230, 247, 236, 0.5)",
      "colorPointOfInterestLabels": "rgba(230, 247, 236, 0.45)",
      "colorBuildings": "#0D1D14",
    ]
  )

  static let day = JoyridePalette(
    dark: false,
    canvas: UIColor(hex: 0xF6FBF7),
    raised: UIColor(hex: 0xFFFFFF),
    deep: UIColor(hex: 0xE3F3E8),
    emerald: UIColor(hex: 0x2E9A64),
    brand: UIColor(hex: 0x1E8A57),
    glow: UIColor(hex: 0x1E8A57),
    text: UIColor(hex: 0x06140C),
    text2: UIColor(hex: 0x06140C, alpha: 0.62),
    hairline: UIColor(hex: 0x06140C, alpha: 0.10),
    caution: UIColor(hex: 0xC97A00),
    hazard: UIColor(hex: 0xD9432F),
    map: [
      "colorLand": "#EEF6F0",
      "colorWater": "#CFE5E3",
      "colorGreenspace": "#D7EEDD",
      "colorRoads": "#FFFFFF",
      "colorTrunks": "#D3E8DA",
      "colorMotorways": "#BFDCCB",
      "colorPlaceLabels": "rgba(6, 20, 12, 0.7)",
      "colorRoadLabels": "rgba(6, 20, 12, 0.55)",
      "colorPointOfInterestLabels": "rgba(6, 20, 12, 0.45)",
      "colorBuildings": "#E2EFE6",
    ]
  )
}

enum JoyrideTheme {
  /// Banners, labels and buttons on the phone's navigation screen.
  @MainActor
  static func applyAppearance(_ p: JoyridePalette) {
    let t = UITraitCollection(userInterfaceIdiom: .phone)

    TopBannerView.appearance(for: t).backgroundColor = p.raised
    InstructionsBannerView.appearance(for: t).backgroundColor = p.raised
    BottomBannerView.appearance(for: t).backgroundColor = p.raised
    BottomPaddingView.appearance(for: t).backgroundColor = p.raised
    NextBannerView.appearance(for: t).backgroundColor = p.deep
    LanesView.appearance(for: t).backgroundColor = p.deep
    NavigationView.appearance(for: t).backgroundColor = p.canvas
    SeparatorView.appearance(for: t).backgroundColor = p.hairline

    // The next turn: the arrow is the one glowing thing in the banner.
    ManeuverView.appearance(for: t, whenContainedInInstancesOf: [InstructionsBannerView.self]).primaryColor = p.glow
    ManeuverView.appearance(for: t, whenContainedInInstancesOf: [InstructionsBannerView.self]).secondaryColor = p.text.withAlphaComponent(0.3)
    ManeuverView.appearance(for: t, whenContainedInInstancesOf: [NextBannerView.self]).primaryColor = p.text
    ManeuverView.appearance(for: t, whenContainedInInstancesOf: [NextBannerView.self]).secondaryColor = p.text.withAlphaComponent(0.3)
    ManeuverView.appearance(for: t, whenContainedInInstancesOf: [StepInstructionsView.self]).primaryColor = p.text
    ManeuverView.appearance(for: t, whenContainedInInstancesOf: [StepInstructionsView.self]).secondaryColor = p.text.withAlphaComponent(0.3)

    // Instruction text: solid, never faded.
    PrimaryLabel.appearance(for: t, whenContainedInInstancesOf: [InstructionsBannerView.self]).normalTextColor = p.text
    PrimaryLabel.appearance(for: t, whenContainedInInstancesOf: [StepInstructionsView.self]).normalTextColor = p.text
    SecondaryLabel.appearance(for: t, whenContainedInInstancesOf: [InstructionsBannerView.self]).normalTextColor = p.text2
    SecondaryLabel.appearance(for: t, whenContainedInInstancesOf: [StepInstructionsView.self]).normalTextColor = p.text2
    DistanceLabel.appearance(for: t, whenContainedInInstancesOf: [InstructionsBannerView.self]).valueTextColor = p.text
    DistanceLabel.appearance(for: t, whenContainedInInstancesOf: [InstructionsBannerView.self]).unitTextColor = p.text2
    DistanceLabel.appearance(for: t, whenContainedInInstancesOf: [StepInstructionsView.self]).valueTextColor = p.text
    DistanceLabel.appearance(for: t, whenContainedInInstancesOf: [StepInstructionsView.self]).unitTextColor = p.text2
    NextInstructionLabel.appearance(for: t, whenContainedInInstancesOf: [NextBannerView.self]).normalTextColor = p.text

    // Bottom bar: time left is the hero, arrival and distance sit under it.
    TimeRemainingLabel.appearance(for: t).normalTextColor = p.text
    TimeRemainingLabel.appearance(for: t).trafficUnknownColor = p.text
    TimeRemainingLabel.appearance(for: t).trafficLowColor = p.text
    TimeRemainingLabel.appearance(for: t).trafficModerateColor = p.caution
    TimeRemainingLabel.appearance(for: t).trafficHeavyColor = p.hazard
    TimeRemainingLabel.appearance(for: t).trafficSevereColor = p.hazard
    ArrivalTimeLabel.appearance(for: t).normalTextColor = p.text2
    DistanceRemainingLabel.appearance(for: t).normalTextColor = p.text2
    CancelButton.appearance(for: t).tintColor = p.hazard

    FloatingButton.appearance(for: t).backgroundColor = p.raised
    FloatingButton.appearance(for: t).tintColor = p.text
    FloatingButton.appearance(for: t).borderColor = p.hairline
    ResumeButton.appearance(for: t).backgroundColor = p.raised
    ResumeButton.appearance(for: t).tintColor = p.text
    ResumeButton.appearance(for: t).borderColor = p.hairline
    WayNameView.appearance(for: t).backgroundColor = p.raised
    WayNameView.appearance(for: t).borderColor = p.brand
    WayNameLabel.appearance(for: t).normalTextColor = p.text

    StepsBackgroundView.appearance(for: t).backgroundColor = p.raised
    StepInstructionsView.appearance(for: t).backgroundColor = p.raised
    StepTableViewCell.appearance(for: t).backgroundColor = p.raised

    EndOfRouteContentView.appearance(for: t).backgroundColor = p.raised
    EndOfRouteTitleLabel.appearance(for: t).normalTextColor = p.text
    EndOfRouteStaticLabel.appearance(for: t).normalTextColor = p.text2
    EndOfRouteButton.appearance(for: t).textColor = p.text

    NavigationMapView.appearance(for: t).routeColor = p.brand
    NavigationMapView.appearance(for: t).routeCasingColor = p.dark ? p.deep : p.emerald
    NavigationMapView.appearance(for: t).routeAlternateColor = p.emerald.withAlphaComponent(0.5)
    NavigationMapView.appearance(for: t).traversedRouteColor = p.brand.withAlphaComponent(0.3)
    NavigationMapView.appearance(for: t).maneuverArrowColor = p.text
    NavigationMapView.appearance(for: t).maneuverArrowStrokeColor = p.deep
    NavigationMapView.appearance(for: t).waypointColor = p.text
    NavigationMapView.appearance(for: t).waypointStrokeColor = p.deep
  }

  /// The map itself: muted greens, no point-of-interest clutter, a glowing route and position dot.
  @MainActor
  static func styleMap(_ view: NavigationMapView, _ p: JoyridePalette) {
    view.routeColor = p.brand
    view.routeCasingColor = p.dark ? p.deep : p.emerald
    view.traversedRouteColor = p.brand.withAlphaComponent(0.3)
    view.maneuverArrowColor = p.text
    view.maneuverArrowStrokeColor = p.deep
    var congestion = view.congestionConfiguration
    congestion.colors.mainRouteColors.moderate = p.caution
    congestion.colors.mainRouteColors.heavy = p.hazard
    congestion.colors.mainRouteColors.severe = p.hazard
    view.congestionConfiguration = congestion
    view.puckType = .puck2D(puck(p))

    guard let map = view.mapView.mapboxMap else { return }
    var config: [String: Any] = [
      "lightPreset": p.dark ? "night" : "day",
      "showPointOfInterestLabels": false,
      "showTransitLabels": false,
    ]
    for (key, value) in p.map { config[key] = value }
    for (key, value) in config {
      // Each one on its own: an option the style doesn't have is simply skipped.
      try? map.setStyleImportConfigProperty(for: "basemap", config: key, value: value)
    }
  }

  /// Lime dot with a mint ring and a soft pulsing halo.
  static func puck(_ p: JoyridePalette) -> Puck2DConfiguration {
    let top = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { ctx in
      let c = ctx.cgContext
      c.setFillColor(p.text.cgColor)
      c.fillEllipse(in: CGRect(x: 1, y: 1, width: 22, height: 22))
      c.setFillColor(p.glow.cgColor)
      c.fillEllipse(in: CGRect(x: 4, y: 4, width: 16, height: 16))
    }
    let halo = UIGraphicsImageRenderer(size: CGSize(width: 48, height: 48)).image { ctx in
      ctx.cgContext.setFillColor(p.glow.withAlphaComponent(0.22).cgColor)
      ctx.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: 48, height: 48))
    }
    return Puck2DConfiguration(
      topImage: top,
      bearingImage: nil,
      shadowImage: halo,
      scale: .constant(1.0),
      pulsing: Puck2DConfiguration.Pulsing(color: p.glow, radius: .constant(28)),
      showsAccuracyRing: false
    )
  }
}

final class JoyrideNightStyle: StandardNightStyle {
  private var styleLoaded: AnyCancellable?

  required init() {
    super.init()
    statusBarStyle = .lightContent
  }

  override func apply() {
    super.apply()
    tintColor = JoyridePalette.night.glow
    MainActor.assumeIsolated { JoyrideTheme.applyAppearance(.night) }
  }

  @MainActor
  override func applyMapStyle(to navigationMapView: NavigationMapView) {
    super.applyMapStyle(to: navigationMapView)
    JoyrideTheme.styleMap(navigationMapView, .night)
    styleLoaded = navigationMapView.mapView.mapboxMap.onStyleLoaded.first().sink { [weak navigationMapView] _ in
      MainActor.assumeIsolated {
        if let navigationMapView { JoyrideTheme.styleMap(navigationMapView, .night) }
      }
    }
  }
}

final class JoyrideDayStyle: StandardDayStyle {
  private var styleLoaded: AnyCancellable?

  required init() {
    super.init()
    statusBarStyle = .darkContent
  }

  override func apply() {
    super.apply()
    tintColor = JoyridePalette.day.brand
    MainActor.assumeIsolated { JoyrideTheme.applyAppearance(.day) }
  }

  @MainActor
  override func applyMapStyle(to navigationMapView: NavigationMapView) {
    super.applyMapStyle(to: navigationMapView)
    JoyrideTheme.styleMap(navigationMapView, .day)
    styleLoaded = navigationMapView.mapView.mapboxMap.onStyleLoaded.first().sink { [weak navigationMapView] _ in
      MainActor.assumeIsolated {
        if let navigationMapView { JoyrideTheme.styleMap(navigationMapView, .day) }
      }
    }
  }
}

/// Day and night versions; the navigation screen picks by the phone's appearance.
func joyrideStyles() -> [Style] {
  [JoyrideDayStyle(), JoyrideNightStyle()]
}
