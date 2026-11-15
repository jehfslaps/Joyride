// Adds settings that can't live in app.json because they come from secrets.
// app.json holds everything else; Expo passes it in as `config`.
module.exports = ({ config }) => {
  const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '';
  const ios = config.ios ?? {};
  const infoPlist = ios.infoPlist ?? {};
  const modes = new Set([...(infoPlist.UIBackgroundModes ?? []), 'location', 'audio']);
  return {
    ...config,
    ios: {
      ...ios,
      // Set by the TestFlight build: signing team and an ever-increasing build number.
      ...(process.env.APPLE_TEAM_ID ? { appleTeamId: process.env.APPLE_TEAM_ID } : {}),
      ...(process.env.BUILD_NUMBER ? { buildNumber: String(process.env.BUILD_NUMBER) } : {}),
      infoPlist: {
        ...infoPlist,
        // Read by the Mapbox Navigation SDK.
        MBXAccessToken: token,
        // 'audio' keeps voice directions speaking while the phone is locked.
        UIBackgroundModes: [...modes],
      },
    },
  };
};
