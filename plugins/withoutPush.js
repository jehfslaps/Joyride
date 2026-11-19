// Joyride only uses local notifications ("Are you still driving?"), never
// push. expo-notifications adds the push entitlement by default, which the
// App Store profile doesn't include, so take it back out.
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPush(config) {
  return withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults['aps-environment'];
    return cfg;
  });
};
