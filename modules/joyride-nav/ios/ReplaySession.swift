import Combine
import CoreLocation
import Foundation
import MapboxDirections
import MapboxNavigationCore

// MARK: - Geometry

/// Small geometry helpers for recorded traces (distances in meters).
enum Geo {
  private static let earthRadius = 6_371_008.8

  static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
    let dLat = (b.latitude - a.latitude) * .pi / 180
    let dLng = (b.longitude - a.longitude) * .pi / 180
    let s = pow(sin(dLat / 2), 2)
      + cos(a.latitude * .pi / 180) * cos(b.latitude * .pi / 180) * pow(sin(dLng / 2), 2)
    return 2 * earthRadius * asin(min(1, sqrt(s)))
  }

  static func bearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
    let φ1 = a.latitude * .pi / 180
    let φ2 = b.latitude * .pi / 180
    let Δλ = (b.longitude - a.longitude) * .pi / 180
    let y = sin(Δλ) * cos(φ2)
    let x = cos(φ1) * sin(φ2) - sin(φ1) * cos(φ2) * cos(Δλ)
    return (atan2(y, x) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
  }

  /// The point `meters` away from `from` in direction `bearing` (degrees).
  static func destination(from: CLLocationCoordinate2D, bearing: Double, meters: Double) -> CLLocationCoordinate2D {
    let δ = meters / earthRadius
    let θ = bearing * .pi / 180
    let φ1 = from.latitude * .pi / 180
    let λ1 = from.longitude * .pi / 180
    let φ2 = asin(sin(φ1) * cos(δ) + cos(φ1) * sin(δ) * cos(θ))
    let λ2 = λ1 + atan2(sin(θ) * sin(δ) * cos(φ1), cos(δ) - sin(φ1) * sin(φ2))
    let lng = (λ2 * 180 / .pi + 540).truncatingRemainder(dividingBy: 360) - 180
    return CLLocationCoordinate2D(latitude: φ2 * 180 / .pi, longitude: lng)
  }

  /// Signed change in heading, -180...180.
  static func turnAngle(_ b1: Double, _ b2: Double) -> Double {
    var d = b2 - b1
    while d > 180 { d -= 360 }
    while d < -180 { d += 360 }
    return d
  }

  /// Indices of points at least `spacing` meters apart (always keeps the first and last).
  static func thin(_ points: [CLLocationCoordinate2D], spacing: Double) -> [Int] {
    guard points.count > 2 else { return Array(points.indices) }
    var keep = [0]
    var last = points[0]
    for i in 1..<(points.count - 1) where distance(last, points[i]) >= spacing {
      keep.append(i)
      last = points[i]
    }
    keep.append(points.count - 1)
    return keep
  }

  /// Splits a trace into overlapping pieces of at most `maxPoints` points. Each
  /// split is made where the road runs straightest, so no turn falls on a seam.
  static func chunkRanges(_ points: [CLLocationCoordinate2D], maxPoints: Int = 100) -> [ClosedRange<Int>] {
    guard points.count >= 2 else { return [] }
    var out: [ClosedRange<Int>] = []
    var start = 0
    while start < points.count - 1 {
      let hardEnd = min(points.count - 1, start + maxPoints - 1)
      if hardEnd == points.count - 1 {
        out.append(start...hardEnd)
        break
      }
      var best = hardEnd
      var bestBend = Double.infinity
      let searchFrom = max(start + Int(Double(maxPoints) * 0.7), start + 2)
      if searchFrom <= hardEnd - 1 {
        for i in searchFrom...(hardEnd - 1) {
          let bend = abs(turnAngle(bearing(points[i - 1], points[i]), bearing(points[i], points[i + 1])))
          if bend < bestBend {
            bestBend = bend
            best = i
          }
        }
      }
      out.append(start...best)
      start = best
    }
    return out
  }

  /// The trace point nearest to `p`, looking at segments from `from` to `to`.
  /// Returns the index of the segment's far end (the next point ahead) and the
  /// distance from `p` to the trace.
  static func nearest(
    _ p: CLLocationCoordinate2D,
    in points: [CLLocationCoordinate2D],
    from: Int = 0,
    to: Int? = nil
  ) -> (ahead: Int, offset: Double) {
    guard points.count >= 2 else { return (0, points.first.map { distance(p, $0) } ?? .infinity) }
    let lo = max(0, min(from, points.count - 2))
    let hi = max(lo + 1, min(to ?? points.count - 1, points.count - 1))
    let kx = cos(p.latitude * .pi / 180) * 111_320
    let ky = 110_540.0
    var bestIndex = lo + 1
    var bestD2 = Double.infinity
    for i in lo..<hi {
      let a = points[i], b = points[i + 1]
      let ax = (a.longitude - p.longitude) * kx, ay = (a.latitude - p.latitude) * ky
      let bx = (b.longitude - p.longitude) * kx, by = (b.latitude - p.latitude) * ky
      let dx = bx - ax, dy = by - ay
      let len2 = dx * dx + dy * dy
      let t = len2 == 0 ? 0 : max(0, min(1, -(ax * dx + ay * dy) / len2))
      let cx = ax + dx * t, cy = ay + dy * t
      let d2 = cx * cx + cy * cy
      if d2 < bestD2 {
        bestD2 = d2
        bestIndex = i + 1
      }
    }
    return (bestIndex, sqrt(bestD2))
  }
}

// MARK: - Replay session

/// Guides the driver along a whole recorded drive.
///
/// Mapbox matches at most 100 points per request, so the drive is split into
/// overlapping pieces and guided one piece after another, switching to the
/// next piece shortly before the current one ends. If the driver leaves the
/// route, ordinary directions take them back to a point a little further along
/// it, and guidance resumes on the recorded roads from there.
@MainActor
final class ReplaySession {
  enum Phase { case approach, main, detour, finished }

  /// Points are kept about this far apart; dense enough to catch every turn.
  static let spacing: Double = 35

  private let navigation: MapboxNavigation
  let points: [CLLocationCoordinate2D]
  private let chunks: [ClosedRange<Int>]

  private(set) var phase: Phase = .approach
  private var chunkIndex = 0
  /// Where on the trace the driver is, as the index of the next point ahead.
  private var traceIndex = 0
  /// Where the current approach or detour joins the recorded drive.
  private var rejoinIndex = 0
  private var busy = false
  private var lastDetourAt = Date.distantPast
  private var cancellables = Set<AnyCancellable>()
  /// Meters from the start of the drive to each point.
  private let cum: [Double]
  /// Called with what's left of the whole drive (meters, seconds), not just the current piece.
  var onWholeProgress: ((Double, Double) -> Void)?

  init(navigation: MapboxNavigation, trace: [CLLocationCoordinate2D]) {
    self.navigation = navigation
    let keep = Geo.thin(trace, spacing: Self.spacing)
    points = keep.map { trace[$0] }
    chunks = Geo.chunkRanges(points)
    var c: [Double] = [0]
    for i in 1..<max(1, points.count) { c.append(c[i - 1] + Geo.distance(points[i - 1], points[i])) }
    cum = c
  }

  var isEmpty: Bool { points.count < 2 }

  /// The routes to start with: straight onto the drive if the driver is already
  /// on it, otherwise directions to the chosen joining point.
  func firstRoutes(from location: CLLocationCoordinate2D, joinNearest: Bool) async throws -> NavigationRoutes {
    let joinAt = joinNearest ? Geo.nearest(location, in: points).ahead : 0
    let start = joinNearest ? max(0, joinAt - 1) : 0
    if Geo.distance(location, points[start]) < 60 {
      return try await mainRoutes(from: start)
    }
    return try await detourRoutes(from: location, joiningAt: start, phase: .approach)
  }

  /// Starts following the driver's progress. Call once guidance is on screen.
  func attach() {
    let nav = navigation.navigation()
    nav.routeProgress
      .receive(on: DispatchQueue.main)
      .sink { [weak self] state in
        guard let self, let progress = state?.routeProgress else { return }
        self.handle(progress: progress)
      }
      .store(in: &cancellables)

    navigation.tripSession().session
      .receive(on: DispatchQueue.main)
      .sink { [weak self] session in
        guard let self else { return }
        if case .activeGuidance(.offRoute) = session.state {
          self.handleOffRoute()
        }
      }
      .store(in: &cancellables)
  }

  func stop() {
    cancellables.removeAll()
    phase = .finished
  }

  // MARK: Progress

  private func handle(progress: RouteProgress) {
    reportWhole(progress)
    guard !busy else { return }
    if let location = navigation.navigation().currentLocationMatching?.enhancedLocation.coordinate,
       phase == .main {
      let found = Geo.nearest(location, in: points, from: traceIndex - 3, to: traceIndex + 40)
      if found.offset < 50 { traceIndex = max(traceIndex, found.ahead) }
    }
    switch phase {
    case .main:
      guard progress.distanceRemaining < 60 else { return }
      if chunkIndex + 1 < chunks.count {
        // Start the next piece from a little behind its seam, so the driver
        // is already on it when it takes over.
        let next = chunks[chunkIndex + 1].lowerBound
        switchTo { try await self.mainRoutes(from: max(0, next - 2)) }
      } else {
        phase = .finished
      }
    case .approach, .detour:
      if progress.distanceRemaining < 40 {
        switchTo { try await self.mainRoutes(from: max(0, self.rejoinIndex - 1)) }
      }
    case .finished:
      break
    }
  }

  /// The current piece's remaining distance and time, plus the rest of the
  /// drive after it at the same pace.
  private func reportWhole(_ progress: RouteProgress) {
    guard let total = cum.last, total > 0 else { return }
    let after: Double
    switch phase {
    case .main:
      after = total - cum[min(cum.count - 1, chunks[min(chunkIndex, chunks.count - 1)].upperBound)]
    case .approach, .detour:
      after = total - cum[min(cum.count - 1, max(0, rejoinIndex))]
    case .finished:
      after = 0
    }
    let route = progress.route
    let pace = route.distance > 0 ? route.expectedTravelTime / route.distance : 0.08
    onWholeProgress?(progress.distanceRemaining + max(0, after), progress.durationRemaining + max(0, after) * pace)
  }

  private func handleOffRoute() {
    guard !busy, phase != .finished else { return }
    guard Date().timeIntervalSince(lastDetourAt) > 10 else { return }
    guard let here = navigation.navigation().currentLocationMatching?.enhancedLocation.coordinate else { return }
    lastDetourAt = Date()
    // Rejoin about 200 m past where they left, so they don't redo a stretch.
    let target = phase == .main
      ? min(points.count - 1, traceIndex + 6)
      : rejoinIndex
    switchTo { try await self.detourRoutes(from: here, joiningAt: target, phase: self.phase == .approach ? .approach : .detour) }
  }

  private func switchTo(_ make: @escaping () async throws -> NavigationRoutes) {
    busy = true
    Task { @MainActor in
      defer { self.busy = false }
      guard let routes = try? await make(), self.phase != .finished else { return }
      self.navigation.tripSession().startActiveGuidance(with: routes, startLegIndex: 0)
    }
  }

  // MARK: Building routes

  /// The recorded roads from `index` to the end of the piece that contains it.
  private func mainRoutes(from index: Int) async throws -> NavigationRoutes {
    let i = min(max(0, index), points.count - 2)
    let piece = chunks.lastIndex(where: { $0.lowerBound <= i }) ?? 0
    let end = chunks[piece].upperBound
    chunkIndex = piece
    traceIndex = i + 1
    phase = .main
    return try await match(i...max(end, i + 1))
  }

  /// Ordinary directions from `location` to the trace, arriving pointed the
  /// same way the drive went.
  private func detourRoutes(
    from location: CLLocationCoordinate2D,
    joiningAt index: Int,
    phase newPhase: Phase
  ) async throws -> NavigationRoutes {
    let join = min(max(0, index), points.count - 1)
    let onward = min(join + 2, points.count - 1)
    var waypoints = [Waypoint(coordinate: location), Waypoint(coordinate: points[join])]
    if onward != join {
      waypoints.append(Waypoint(coordinate: points[onward]))
      waypoints[1].separatesLegs = false
    }
    rejoinIndex = onward
    phase = newPhase
    let options = NavigationRouteOptions(waypoints: waypoints)
    return try await navigation.routingProvider().calculateRoutes(options: options).value
  }

  /// Road-matches part of the trace. If Mapbox can't match it, falls back to
  /// directions through up to 25 points along the same stretch.
  private func match(_ range: ClosedRange<Int>) async throws -> NavigationRoutes {
    var waypoints = range.map { Waypoint(coordinate: points[$0]) }
    for i in waypoints.indices {
      waypoints[i].separatesLegs = i == 0 || i == waypoints.count - 1
    }
    let options = NavigationMatchOptions(waypoints: waypoints)
    // Allow for GPS wobble: each point may be up to 25 m off the road.
    options.waypoints = options.waypoints.map { waypoint in
      var w = waypoint
      w.coordinateAccuracy = 25
      return w
    }
    do {
      return try await navigation.routingProvider().calculateRoutes(options: options).value
    } catch {
      return try await directions(along: range)
    }
  }

  private func directions(along range: ClosedRange<Int>) async throws -> NavigationRoutes {
    let count = range.count
    let step = max(1, Int((Double(count) / 24).rounded(.up)))
    var indices = Array(stride(from: range.lowerBound, through: range.upperBound, by: step))
    if indices.last != range.upperBound { indices.append(range.upperBound) }
    var waypoints = indices.map { Waypoint(coordinate: points[$0]) }
    for i in waypoints.indices {
      waypoints[i].separatesLegs = i == 0 || i == waypoints.count - 1
    }
    let options = NavigationRouteOptions(waypoints: waypoints)
    return try await navigation.routingProvider().calculateRoutes(options: options).value
  }
}
