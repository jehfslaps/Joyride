// Adds Joyride's CarPlay scene to the iPhone app.
//
// The CarPlay scene is always declared, but iOS only shows Joyride on a car
// screen when the app is signed with Apple's CarPlay navigation entitlement.
// That entitlement is added only when JOYRIDE_CARPLAY=1, because builds that
// ask for it fail to sign until Apple has approved the request.
const { withInfoPlist, withEntitlementsPlist } = require('expo/config-plugins');

const CARPLAY_ROLE = 'CPTemplateApplicationSceneSessionRoleApplication';

module.exports = function withCarPlay(config) {
  config = withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    const manifest = plist.UIApplicationSceneManifest ?? {};
    const scenes = manifest.UISceneConfigurations ?? {};
    scenes[CARPLAY_ROLE] = [
      {
        UISceneClassName: 'CPTemplateApplicationScene',
        UISceneConfigurationName: 'Joyride CarPlay',
        UISceneDelegateClassName: 'JoyrideCarPlaySceneDelegate',
      },
    ];
    manifest.UISceneConfigurations = scenes;
    // The phone and the car screen run at the same time.
    manifest.UIApplicationSupportsMultipleScenes = true;
    manifest.CPSupportsDashboardNavigationScene = false;
    plist.UIApplicationSceneManifest = manifest;
    return cfg;
  });

  config = withEntitlementsPlist(config, (cfg) => {
    if (process.env.JOYRIDE_CARPLAY === '1') {
      cfg.modResults['com.apple.developer.carplay-maps'] = true;
    } else {
      delete cfg.modResults['com.apple.developer.carplay-maps'];
    }
    return cfg;
  });

  return config;
};
