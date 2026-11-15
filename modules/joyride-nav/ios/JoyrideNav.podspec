# Joyride's native navigation core: wraps the Mapbox Navigation SDK (v3).
#
# The Mapbox SDK only ships as a Swift package, so it is pulled in with React
# Native's spm_dependency helper. Downloading it needs a Mapbox secret token
# with the Downloads:Read scope in ~/.netrc (the GitHub build writes it from
# the MAPBOX_DOWNLOADS_TOKEN secret).

MAPBOX_NAV_VERSION = '3.27.3'

Pod::Spec.new do |s|
  s.name           = 'JoyrideNav'
  s.version        = '0.1.0'
  s.summary        = 'Turn-by-turn navigation for Joyride, built on Mapbox.'
  s.description    = 'Turn-by-turn navigation for Joyride, built on the Mapbox Navigation SDK.'
  s.license        = 'MIT'
  s.author         = 'jehfslaps'
  s.homepage       = 'https://github.com/jehfslaps/Joyride'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/jehfslaps/Joyride.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  spm_dependency(s,
    url: 'https://github.com/mapbox/mapbox-navigation-ios.git',
    requirement: { kind: 'exactVersion', version: MAPBOX_NAV_VERSION },
    products: ['MapboxNavigationUIKit', 'MapboxNavigationCore']
  )
end
